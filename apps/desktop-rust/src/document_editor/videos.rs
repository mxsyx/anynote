use super::*;
use crate::{backend_session::BackendSession, webview::MediaHost};
use anynote_core::{
    backend::{Command, Reply},
    video::VideoCard,
};
use anynote_editor::model::BlockId;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Default)]
pub(super) struct Videos {
    host: Option<MediaHost>,
    pending: Option<(BlockId, bool)>,
    task: Option<Task<()>>,
    busy: bool,
}
impl DocumentEditor {
    pub(super) fn stop_video(&mut self, cx: &mut App) {
        if let Some(mut host) = self.videos.host.take() {
            host.close(cx);
        }
        self.videos = Videos::default();
    }
    pub(super) fn insert_video(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(save) = &self.state.save else {
            return;
        };
        let epoch = save.epoch();
        let notebook = save.base().id().notebook();
        let generation = self.state.editor.document().generation();
        let Some(client) = cx
            .try_global::<BackendSession>()
            .map(|s| s.client().clone())
        else {
            return;
        };
        self.stop_video(cx);
        self.videos.busy = true;
        self.videos.task = Some(cx.spawn_in(window, async move |this, cx| {
            let reply = saving::request(&client, Command::GetNotebookPreferences { notebook }).await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.videos.busy = false;
                if !this.video_current(epoch, generation) { cx.notify(); return; }
                if matches!(reply, Ok(Reply::NotebookPreferences { preferences, .. }) if preferences.video) {
                    this.video_dialog(window, cx);
                } else {
                    this.error = Some("请在笔记本偏好中启用视频".into()); cx.notify();
                }
            });
        }));
    }
    fn video_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.state.save.is_none() || self.is_composing() || self.source_composing(window, cx) {
            return;
        }
        self.stop_video(cx);
        let generation = self.state.editor.document().generation();
        let epoch = self.state.save.as_ref().unwrap().epoch();
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("https://…"));
        let feedback = Rc::new(RefCell::new(None::<String>));
        let owner = cx.weak_entity();
        window.open_dialog(cx, move |dialog, _, _| {
            let input = input.clone();
            let feedback = feedback.clone();
            let owner = owner.clone();
            let error = feedback.borrow().clone();
            dialog
                .title("插入视频")
                .child(Input::new(&input).aria_label("视频地址"))
                .when_some(error, |d, text| d.child(div().child(text)))
                .footer(
                    DialogFooter::new()
                        .child(DialogClose::new().trigger(|b| b.label("取消")))
                        .child(
                            DialogAction::new()
                                .child(Button::new("insert-video-confirm").primary().label("插入")),
                        ),
                )
                .on_ok(move |_, window, cx| {
                    let Some(card) = VideoCard::parse(input.read(cx).value().as_str()) else {
                        *feedback.borrow_mut() = Some("请输入不含账号密码的 HTTPS 地址".into());
                        cx.refresh_windows();
                        return false;
                    };
                    owner
                        .update(cx, |this, cx| {
                            if !this.video_current(epoch, generation) {
                                return true;
                            }
                            let range = if let Some(start) = this.slash_start.take() {
                                this.state.projection.source_at(start)
                                    ..this.state.projection.source_at(this.state.head)
                            } else {
                                let leaf = &this.state.projection.leaves
                                    [this.state.projection.at(this.state.head).0];
                                let at = leaf
                                    .id
                                    .block
                                    .and_then(|id| this.state.editor.document().block(id))
                                    .map_or(leaf.span.end, |b| b.span().end);
                                at..at
                            };
                            this.slash = None;
                            let result = this.state.source_edit(
                                range,
                                &format!("\n\n{}\n", anynote_editor::video::insert(&card)),
                            );
                            this.changed(result, window, cx);
                            this.sync_source(window, cx);
                            this.flush(window, cx);
                            true
                        })
                        .unwrap_or(true)
                })
        });
    }
    fn video_current(&self, epoch: Uuid, generation: u64) -> bool {
        !self.closing
            && self.switching.is_none()
            && self.state.save.as_ref().is_some_and(|s| s.epoch() == epoch)
            && self.state.editor.document().generation() == generation
    }
    fn queue_video(
        &mut self,
        block: BlockId,
        metadata: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.state.save.is_none()
            || self.videos.busy
            || self.is_composing()
            || self.source_composing(window, cx)
        {
            return;
        }
        self.stop_video(cx);
        self.videos.pending = Some((block, metadata));
        self.flush(window, cx);
    }
    pub(super) fn start_video(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((block, metadata)) = self.videos.pending.take() else {
            return;
        };
        let Some((card, _, _)) = anynote_editor::video::read(self.state.editor.document(), block)
        else {
            return;
        };
        let Some(save) = &self.state.save else {
            return;
        };
        let epoch = save.epoch();
        let notebook = save.base().id().notebook();
        let generation = self.state.editor.document().generation();
        let Some(client) = cx
            .try_global::<BackendSession>()
            .map(|s| s.client().clone())
        else {
            return;
        };
        self.videos.busy = true;
        self.videos.task = Some(cx.spawn_in(window, async move |this, cx| {
            let preferences =
                saving::request(&client, Command::GetNotebookPreferences { notebook }).await;
            let permitted = matches!(preferences, Ok(Reply::NotebookPreferences { preferences, .. }) if preferences.video && (metadata || preferences.remote_embed));
            if !permitted {
                let _ = this.update_in(cx, |this, _, cx| {
                    if this.video_current(epoch, generation) {
                        this.videos.busy = false;
                        this.error = Some("请在笔记本偏好中启用视频；播放还需允许远程嵌入".into());
                        cx.notify();
                    }
                });
                return;
            }
            if !metadata {
                let _ = this.update_in(cx, |this, window, cx| {
                    this.videos.busy = false;
                    if !this.video_current(epoch, generation) {
                        return;
                    }
                    match MediaHost::external(&card, window, cx) {
                        Ok(host) => {
                            if let Err(error) = host.focus(window, cx) { this.error = Some(error); } else { this.videos.host = Some(host); }
                        }
                        Err(error) => this.error = Some(error),
                    }
                    cx.notify();
                });
                return;
            }
            let reply = saving::request(&client, Command::VideoMetadata { card }).await;
            let meta = match reply {
                Ok(Reply::VideoMetadata(meta)) => Ok(meta),
                _ => Err("无法更新视频信息，请稍后重试".to_owned()),
            };
            let meta = cx
                .background_spawn(async move {
                    let meta = meta?;
                    let thumbnail = meta.thumbnail().and_then(|bytes| {
                        crate::image::codec::inspect(bytes).ok()?;
                        let hash = format!("{:x}", Sha256::digest(bytes));
                        Some((Uuid::new_v4(), Arc::new(bytes.to_vec()), hash))
                    });
                    Ok::<_, String>((meta.title().map(str::to_owned), thumbnail))
                })
                .await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.videos.busy = false;
                if !this.video_current(epoch, generation) {
                    cx.notify();
                    return;
                }
                match meta {
                    Ok((title, thumbnail)) => {
                        let total: usize = this.images.staged.values().map(|(_, b)| b.len()).sum();
                        if thumbnail.as_ref().is_some_and(|(_, bytes, _)| {
                            this.images.staged.len() >= 32 || total + bytes.len() > 50 * 1024 * 1024
                        }) {
                            this.error = Some("待保存资源超过预算，请先保存笔记".into());
                            cx.notify();
                            return;
                        }
                        let resource = thumbnail.as_ref().map(|(id, _, _)| *id);
                        let result = anynote_editor::video::metadata(
                            this.state.editor.document(),
                            block,
                            generation,
                            title.as_deref(),
                            resource,
                            this.state.millis(),
                            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
                        )
                        .map_err(state::error)
                        .and_then(|tx| this.state.apply(tx));
                        if result.is_ok()
                            && let Some((id, bytes, hash)) = thumbnail
                        {
                            this.state.save.as_mut().unwrap().stage_resource(id, hash);
                            this.images
                                .staged
                                .insert(id, ("video-thumbnail".into(), bytes));
                        }
                        this.changed(result, window, cx);
                        this.sync_source(window, cx);
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
    pub(super) fn video_pending(&self) -> bool {
        self.videos.pending.is_some()
    }
    pub(super) fn render_video(
        &mut self,
        first: usize,
        key: u64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let id = self.state.projection.leaves[first].id.block?;
        let (card, title, thumbnail) =
            anynote_editor::video::read(self.state.editor.document(), id)?;
        let preview = thumbnail
            .and_then(|r| self.render_resource_preview(r, "视频缩略图".into(), None, window, cx))
            .map(|(v, _)| v);
        let url = card.url().to_owned();
        Some(
            div()
                .px_6()
                .py_3()
                .flex()
                .flex_col()
                .gap_2()
                .when_some(preview, |v, preview| v.child(preview))
                .child(title.unwrap_or_else(|| card.url().into()))
                .child(
                    div()
                        .flex()
                        .gap_2()
                        .when(card.embed().is_some(), |v| {
                            v.child(
                                Button::new(("video-play", key))
                                    .label("播放视频")
                                    .disabled(self.videos.busy || self.state.save.is_none())
                                    .on_click(cx.listener(move |this, _, w, cx| {
                                        this.queue_video(id, false, w, cx)
                                    })),
                            )
                        })
                        .child(
                            Button::new(("video-refresh", key))
                                .label(if self.videos.busy {
                                    "正在更新"
                                } else {
                                    "更新视频信息"
                                })
                                .disabled(self.videos.busy || self.state.save.is_none())
                                .on_click(cx.listener(move |this, _, w, cx| {
                                    this.queue_video(id, true, w, cx)
                                })),
                        )
                        .child(
                            gpui_kit::component::link::Link::new(("video-original", key))
                                .href(url)
                                .child("浏览器打开"),
                        ),
                )
                .into_any_element(),
        )
    }
    pub(super) fn video_view(&self, cx: &mut Context<Self>) -> Option<Stateful<Div>> {
        let host = self.videos.host.as_ref()?;
        let view = host.view()?;
        let occlusion = view.clone();
        Some(
            div()
                .id("video-player")
                .size_full()
                .flex()
                .flex_col()
                .bg(cx.theme().background)
                .child(
                    div().flex().gap_2().p_2().child(
                        Button::new("video-close")
                            .label("停止播放并返回")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.stop_video(cx);
                                this.focus.focus(window, cx);
                                cx.notify();
                            })),
                    ),
                )
                .child(
                    div()
                        .px_2()
                        .text_color(cx.theme().muted_foreground)
                        .child("若视频无法加载，请返回正文并在浏览器打开"),
                )
                .child(
                    canvas(
                        move |_, window, cx| {
                            let visible =
                                !window.has_active_dialog(cx) && !window.has_active_sheet(cx);
                            occlusion.update(cx, |view, _| {
                                if view.visible() != visible {
                                    let _ = view.set_visible(visible);
                                }
                            });
                        },
                        |_, _, _, _| {},
                    )
                    .absolute(),
                )
                .child(div().flex_1().min_h_0().child(view)),
        )
    }
}
