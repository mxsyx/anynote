use super::*;
use crate::{
    backend_client::{BackendClient, Response},
    backend_session::BackendSession,
};
use anynote_core::{backend::*, document_session::*};
use std::time::{Duration, Instant};

#[derive(Default)]
struct DocumentWindows(Vec<(AnyWindowHandle, WeakEntity<DocumentEditor>)>);
impl Global for DocumentWindows {}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum FlushState {
    Ready,
    Waiting,
    Failed,
}

pub fn flush_all(cx: &mut App) -> FlushState {
    let Some(windows) = cx.try_global::<DocumentWindows>() else {
        return FlushState::Ready;
    };
    let windows = windows.0.clone();
    let mut result = FlushState::Ready;
    for (window, editor) in windows {
        let state = window.update(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                editor.request_close(window, cx);
                if editor
                    .board
                    .as_ref()
                    .is_some_and(|b| b.read(cx).is_failed())
                    || editor.state.save.as_ref().is_some_and(|s| s.retry_needed())
                    || (editor.builtin_request.is_some() && !editor.builtin_running)
                {
                    FlushState::Failed
                } else if editor.board.is_some()
                    || editor.is_composing()
                    || editor.images.importing
                    || editor.source_composing(window, cx)
                    || editor.state.save.as_ref().is_some_and(|s| s.dirty())
                    || editor.builtin_running
                    || editor.builtin_pending.is_some()
                {
                    FlushState::Waiting
                } else {
                    FlushState::Ready
                }
            })
        });
        if let Ok(Ok(state)) = state {
            if state == FlushState::Failed {
                result = FlushState::Failed;
            } else if state == FlushState::Waiting && result != FlushState::Failed {
                result = FlushState::Waiting;
            }
        }
    }
    result
}
pub fn open_document(snapshot: DocumentSnapshot, cx: &mut App) -> gpui_kit::Result<()> {
    let existing = cx.try_global::<DocumentWindows>().and_then(|windows| {
        windows.0.iter().find_map(|(window, weak)| {
            weak.upgrade()
                .filter(|editor| {
                    editor
                        .read(cx)
                        .state
                        .save
                        .as_ref()
                        .is_some_and(|s| s.base().id() == snapshot.id())
                })
                .map(|_| *window)
        })
    });
    if let Some(window) = existing {
        window.update(cx, |_, window, cx| {
            window.activate_window();
            cx.activate(true);
        })?;
    } else {
        gpui_kit::open_window(
            WindowOptions {
                titlebar: Some(TitlebarOptions {
                    title: Some(format!("Anynote · {}", snapshot.content().title()).into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
            cx,
            |window, cx| cx.new(|cx| DocumentEditor::from_snapshot(snapshot, window, cx)),
        )?;
    }
    Ok(())
}
pub(super) async fn request(client: &BackendClient, command: Command) -> ServiceResult<Reply> {
    match client
        .submit(command, Duration::from_secs(15))?
        .receive()
        .await?
    {
        Response::Reply(reply) => Ok(reply),
        _ => Err(ServiceError::new(ErrorCode::InvalidRequest)),
    }
}
impl DocumentEditor {
    pub fn from_snapshot(
        snapshot: DocumentSnapshot,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut editor = Self::new(snapshot.content().body().to_owned(), window, cx);
        editor.state.save = Some(session::SaveController::new(snapshot));
        if let Some(resource) = editor
            .state
            .save
            .as_ref()
            .and_then(|s| s.base().primary_image())
        {
            editor.open_image(resource, window, cx);
        }
        editor
    }
    pub fn resource_request(
        &self,
        resource: uuid::Uuid,
        offset: u64,
        length: u32,
    ) -> Option<Command> {
        let base = self.state.save.as_ref()?.base();
        Some(Command::DocumentResource {
            id: base.id().clone(),
            revision: base.head(),
            resource,
            offset,
            length,
        })
    }
    fn save_copy(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.builtin_running || self.builtin_request.is_some() {
            return;
        }
        if self.saving || self.is_composing() || self.source_composing(window, cx) {
            return;
        }
        let Some(client) = cx
            .try_global::<BackendSession>()
            .map(|s| s.client().clone())
        else {
            return;
        };
        let Some(base) = self.state.save.as_ref().map(|s| s.base().clone()) else {
            return;
        };
        let mut staged = self.images.staged.clone();
        self.saving = true;
        self.save_task = Some(cx.spawn_in(window, async move |this, cx| {
            let result = async {
                use crate::image::service;
                use sha2::{Digest, Sha256};
                let cancel = std::sync::atomic::AtomicBool::new(false);
                let mut total = staged.values().map(|(_, bytes)| bytes.len()).sum::<usize>();
                for resource in base.resources().keys() {
                    if staged.contains_key(resource) {
                        continue;
                    }
                    let scope = anynote_core::image::ImageScope {
                        document: base.id().clone(),
                        revision: base.head(),
                        resource: *resource,
                    };
                    let (_, bytes) = service::read(&client, &scope, &cancel).await?;
                    total += bytes.len();
                    if total > 100 * 1024 * 1024 || staged.len() >= 32 {
                        return Err("草稿图片超过单次复制预算，当前草稿已保留".to_string());
                    }
                    staged.insert(*resource, ("image".into(), std::sync::Arc::new(bytes)));
                }
                let Reply::Document(snapshot) = request(&client, Command::CreateDocument)
                    .await
                    .map_err(|_| "无法创建草稿副本".to_string())?
                else {
                    return Err("草稿副本响应无效".into());
                };
                let inputs = staged.clone();
                let hashes = cx
                    .background_spawn(async move {
                        inputs
                            .iter()
                            .map(|(id, (_, bytes))| {
                                (*id, format!("{:x}", Sha256::digest(bytes.as_slice())))
                            })
                            .collect::<Vec<_>>()
                    })
                    .await;
                Ok((snapshot, hashes))
            }
            .await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.saving = false;
                match result {
                    Ok((snapshot, hashes)) => {
                        this.reset_images(window, cx);
                        this.images.staged = staged;
                        let mut save = session::SaveController::new(snapshot);
                        for (id, hash) in hashes {
                            save.stage_resource(id, hash);
                        }
                        if let Some(id) = base.primary_image() {
                            let body = anynote_editor::image::markdown(
                                &id.to_string(),
                                base.content().title(),
                            )
                            .unwrap();
                            this.state = DocumentSession::new(body);
                            this.layout.reset(this.state.projection.rows.len());
                            this.rekey();
                            this.sync_source(window, cx);
                        }
                        this.state.save = Some(save);
                        this.closing = false;
                        this.switching = None;
                        this.flush(window, cx);
                    }
                    Err(error) => {
                        this.error = Some(error);
                        cx.notify();
                    }
                }
            });
        }));
    }
    pub(super) fn install_lifecycle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.lifecycle
            .push(cx.on_release_in(window, |this, window, cx| this.reset_images(window, cx)));
        if cx.try_global::<DocumentWindows>().is_none() {
            cx.set_global(DocumentWindows::default());
        }
        let weak = cx.weak_entity();
        let windows = &mut cx.global_mut::<DocumentWindows>().0;
        windows.retain(|(_, editor)| editor.is_upgradable());
        windows.push((window.window_handle(), weak.clone()));
        window.on_window_should_close(cx, move |window, cx| {
            weak.update(cx, |this, cx| this.request_close(window, cx))
                .is_err()
        });
        self.lifecycle
            .push(cx.on_focus_out(&self.focus, window, |this, _, window, cx| {
                this.flush(window, cx)
            }));
        self.lifecycle
            .push(cx.observe_window_activation(window, |this, window, cx| {
                if !window.is_window_active() {
                    this.flush(window, cx);
                }
            }));
    }
    pub(super) fn schedule_save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let generation = self.state.editor.document().generation();
        if let Some(save) = &mut self.state.save {
            if !save.observe(generation, Instant::now()) {
                return;
            }
        } else {
            return;
        }
        self.debounce_task = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(session::SAVE_DELAY).await;
            let _ = this.update_in(cx, |this, window, cx| this.pump_save(false, window, cx));
        }));
    }
    pub fn flush(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.flush_requested = true;
        self.pump_save(true, window, cx);
    }
    pub(super) fn request_close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.closing = true;
        if let Some(board) = self.board.clone() {
            board.update(cx, |b, cx| b.close(cx));
            return;
        }
        self.board_pending = None;
        self.flush(window, cx);
    }
    /// The caller may load another note in advance; it cannot replace a dirty session.
    pub fn switch_document(
        &mut self,
        snapshot: DocumentSnapshot,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.switching = Some(snapshot);
        if let Some(board) = self.board.clone() {
            board.update(cx, |b, cx| b.close(cx));
            return;
        }
        self.board_pending = None;
        self.flush(window, cx);
    }
    fn complete_flush(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.builtin_running || self.builtin_request.is_some() {
            return;
        }
        if self.is_composing()
            || self.images.importing
            || self.source_composing(window, cx)
            || self.state.save.as_ref().is_some_and(|s| s.dirty())
        {
            return;
        }
        self.flush_requested = false;
        if self.board_pending.is_some() {
            self.start_board(window, cx);
            return;
        }
        if self.builtin_pending.is_some() {
            self.start_reading(window, cx);
            return;
        }
        if self.closing {
            window.remove_window();
            return;
        }
        if let Some(snapshot) = self.switching.take() {
            self.reset_images(window, cx);
            self.source = None;
            self.source_subscription = None;
            self.source_blur = None;
            self.source_scroll = None;
            self.rich_scroll = None;
            self.expanded_blocks.clear();
            self.state = DocumentSession::new(snapshot.content().body().to_owned());
            self.state.save = Some(session::SaveController::new(snapshot));
            self.layout.reset(self.state.projection.rows.len());
            self.layout.scroll_to(ListOffset::default());
            self.rekey();
            self.changed(Ok(()), window, cx);
            self.focus.focus(window, cx);
        }
        cx.notify();
    }
    fn pump_save(&mut self, force: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.board.is_some() {
            return;
        }
        if self.builtin_running || self.builtin_request.is_some() {
            return;
        }
        let composing =
            self.is_composing() || self.source_composing(window, cx) || self.images.importing;
        let force = force || self.flush_requested;
        if composing {
            if let Some(save) = &mut self.state.save {
                save.wait_for_input();
            }
            if force {
                self.debounce_task = Some(cx.spawn_in(window, async move |this, cx| {
                    cx.background_executor()
                        .timer(Duration::from_millis(50))
                        .await;
                    let _ = this.update_in(cx, |this, window, cx| this.pump_save(true, window, cx));
                }));
            }
            cx.notify();
            return;
        }
        if self.saving {
            return;
        }
        let body = self.state.editor.document().source();
        let Some(save) = &mut self.state.save else {
            self.complete_flush(window, cx);
            return;
        };
        save.observe(self.state.editor.document().generation(), Instant::now());
        save.input_finished();
        let Some(pending) = save.prepare(body, false, force, Instant::now()) else {
            self.complete_flush(window, cx);
            return;
        };
        let Some(client) = cx
            .try_global::<BackendSession>()
            .map(|s| s.client().clone())
        else {
            save.fail(
                pending.epoch(),
                pending.generation(),
                ErrorCode::Disconnected,
            );
            cx.notify();
            return;
        };
        let uploads = pending
            .resources()
            .iter()
            .filter_map(|id| {
                self.images
                    .staged
                    .get(id)
                    .map(|(name, bytes)| (*id, name.clone(), bytes.clone()))
            })
            .collect::<Vec<_>>();
        self.saving = true;
        self.save_task = Some(cx.spawn_in(window, async move |this, cx| {
            let mut lease = crate::image::service::UploadLease {
                client: client.clone(),
                document: pending.snapshot().id().clone(),
                resources: vec![],
            };
            let result = async {
                if uploads.len() != pending.resources().len() {
                    return Err(ServiceError::new(ErrorCode::InvalidRequest));
                }
                for (resource, name, bytes) in uploads {
                    lease.resources.push(resource);
                    crate::image::service::upload(
                        &client,
                        pending.snapshot().id().clone(),
                        resource,
                        name,
                        &bytes,
                    )
                    .await
                    .map_err(|_| ServiceError::new(ErrorCode::Storage))?;
                }
                request(&client, Command::SaveDocument(pending.clone())).await
            }
            .await;
            drop(lease);
            let _ = this.update_in(cx, |this, window, cx| {
                this.saving = false;
                let Some(save) = &mut this.state.save else {
                    return;
                };
                match result {
                    Ok(Reply::DocumentSaved(ack)) => {
                        if !save.acknowledge(&ack) {
                            save.fail(
                                pending.epoch(),
                                pending.generation(),
                                ErrorCode::InvalidRequest,
                            );
                        }
                    }
                    Ok(_) => save.fail(
                        pending.epoch(),
                        pending.generation(),
                        ErrorCode::InvalidRequest,
                    ),
                    Err(error) => save.fail(pending.epoch(), pending.generation(), error.code()),
                }
                if save.retry_needed() {
                    this.reconcile_save(false, window, cx);
                } else {
                    this.images_saved(window, cx);
                    this.pump_save(true, window, cx);
                }
                cx.notify();
            });
        }));
        cx.notify();
    }
    fn reconcile_save(&mut self, resume: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        let Some(save) = &self.state.save else {
            return;
        };
        let (epoch, id) = (save.epoch(), save.base().id().clone());
        let Some(client) = cx
            .try_global::<BackendSession>()
            .map(|s| s.client().clone())
        else {
            return;
        };
        // Reconnection is explicit. A read on the same pipe is ordered after the
        // uncertain save; a replacement backend must reacquire the write lease.
        if !client.is_connected() {
            cx.notify();
            return;
        }
        self.saving = true;
        self.save_task = Some(cx.spawn_in(window, async move |this, cx| {
            let result = request(&client, Command::OpenDocument { id }).await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.saving = false;
                if let (Some(save), Ok(Reply::Document(remote))) = (&mut this.state.save, result) {
                    save.reconcile(epoch, remote);
                    if resume {
                        save.retry();
                    }
                }
                if this.state.save.as_ref().is_some_and(|s| !s.retry_needed()) {
                    this.images_saved(window, cx);
                    this.pump_save(true, window, cx);
                } else {
                    cx.notify();
                }
            });
        }));
    }
    pub(super) fn retry_save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.builtin_request.is_some() {
            self.start_reading(window, cx);
            return;
        }
        let Some(client) = cx
            .try_global::<BackendSession>()
            .map(|s| s.client().clone())
        else {
            return;
        };
        if self.saving {
            return;
        }
        if !client.is_connected() {
            if !BackendSession::begin_reconnect(cx) {
                return;
            }
            self.saving = true;
            self.save_task = Some(cx.spawn_in(window, async move |this, cx| {
                let result = client.reconnect().recv().await;
                let _ = this.update_in(cx, |this, window, cx| {
                    this.saving = false;
                    BackendSession::end_reconnect(result.ok().and_then(|r| r.ok()), cx);
                    this.reconcile_save(true, window, cx);
                });
            }));
        } else if self.state.save.as_mut().is_some_and(|s| s.retry()) {
            self.flush(window, cx);
        } else if self.state.save.as_ref().is_some_and(|s| s.retry_needed()) {
            self.reconcile_save(true, window, cx);
        } else {
            self.flush(window, cx);
        }
    }
    pub(super) fn render_save_status(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(save) = &self.state.save else {
            return div().into_any_element();
        };
        div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap_2()
            .px_4()
            .py_2()
            .child(
                div()
                    .text_sm()
                    .child(save.base().content().title().to_owned()),
            )
            .child(
                div()
                    .id("document-save-status")
                    .role(Role::Status)
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child(save.label()),
            )
            .child(
                Button::new("save-document")
                    .small()
                    .ghost()
                    .label("保存")
                    .disabled(self.saving)
                    .on_click(cx.listener(|this, _, window, cx| this.retry_save(window, cx))),
            )
            .when(save.dirty(), |bar| {
                bar.child(
                    Button::new("copy-draft")
                        .small()
                        .ghost()
                        .label("复制草稿")
                        .on_click(cx.listener(|this, _, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(
                                this.source().to_owned(),
                            ))
                        })),
                )
            })
            .when(save.remote.is_some(), |bar| {
                bar.child(
                    Button::new("save-conflict-copy")
                        .small()
                        .ghost()
                        .label("另存草稿")
                        .disabled(self.saving)
                        .on_click(cx.listener(|this, _, window, cx| this.save_copy(window, cx))),
                )
            })
            .when(save.remote.is_some(), |bar| {
                bar.child(
                    Button::new("compare-remote")
                        .small()
                        .ghost()
                        .label("查看已保存版本…")
                        .on_click(cx.listener(|this, _, window, cx| {
                            let Some(remote) =
                                this.state.save.as_ref().and_then(|s| s.remote.clone())
                            else {
                                return;
                            };
                            let text = cx.new(|cx| {
                                EditorState::new(window, cx)
                                    .default_value(remote.content().body().to_owned())
                                    .language("markdown")
                            });
                            window.open_dialog(cx, move |dialog, _, _| {
                                dialog
                                    .title("已保存版本（当前草稿保留）")
                                    .child(SourceEditor::new(&text).readonly(true).h_64())
                                    .footer(
                                        DialogFooter::new().child(
                                            DialogClose::new().trigger(|b| b.label("返回草稿")),
                                        ),
                                    )
                            });
                        })),
                )
            })
            .into_any_element()
    }
}
