use super::BoardView;
use crate::{
    backend_client::BackendClient,
    backend_session::BackendSession,
    image::{codec, service},
};
use anynote_core::{
    backend::{Command, Reply},
    board::{BoardBlock, BoardSave, MAX_SCENE_BYTES},
    document_session::DocumentSnapshot,
    image::ImageScope,
};
use anynote_editor::board::Scene;
use base64::{Engine, engine::general_purpose::STANDARD};
use gpui_kit::{
    component::{
        ActiveTheme, Disableable,
        button::{Button, ButtonVariants},
    },
    prelude::*,
    *,
};
use serde_json::Value;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use uuid::Uuid;

actions!(board_session, [Save]);
pub(super) fn install_actions(cx: &mut App) {
    cx.bind_keys([KeyBinding::new(
        if cfg!(target_os = "macos") {
            "cmd-s"
        } else {
            "ctrl-s"
        },
        Save,
        Some("BoardSession"),
    )]);
}

pub enum BoardEvent {
    Closed(Option<DocumentSnapshot>),
}
pub struct BoardSession {
    base: DocumentSnapshot,
    block: BoardBlock,
    board: Option<Entity<BoardView>>,
    original: Option<Scene>,
    pending: Option<Prepared>,
    task: Option<Task<()>>,
    loading: bool,
    saving: bool,
    error: Option<String>,
    cancel: Arc<AtomicBool>,
    release: Option<Subscription>,
    focus: FocusHandle,
    observation: Option<Subscription>,
}
impl EventEmitter<BoardEvent> for BoardSession {}
enum SaveFailure {
    BeforeCommit(String),
    Uncertain(String),
    Rejected(String),
}
impl SaveFailure {
    fn retained(self, was_uncertain: bool) -> (String, bool) {
        match self {
            Self::BeforeCommit(error) => (error, was_uncertain),
            Self::Uncertain(error) => (error, true),
            Self::Rejected(error) => (error, false),
        }
    }
}
struct Prepared {
    request: BoardSave,
    uploads: Vec<(Uuid, Arc<Vec<u8>>)>,
}
impl BoardSession {
    pub fn new(
        base: DocumentSnapshot,
        block: BoardBlock,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut this = Self {
            base,
            block,
            board: None,
            original: None,
            pending: None,
            task: None,
            loading: true,
            saving: false,
            error: None,
            cancel: Arc::new(AtomicBool::new(false)),
            release: None,
            focus: cx.focus_handle(),
            observation: None,
        };
        this.focus.focus(window, cx);
        this.release = Some(cx.on_release(|this, _| this.cancel.store(true, Ordering::Relaxed)));
        let Some(client) = cx
            .try_global::<BackendSession>()
            .map(|s| s.client().clone())
        else {
            this.loading = false;
            this.error = Some("白板服务不可用".into());
            return this;
        };
        let (base, block, cancel) = (this.base.clone(), this.block.clone(), this.cancel.clone());
        this.task = Some(cx.spawn_in(window, async move |owner, cx| {
            let result = cx
                .background_spawn(async move { load(&client, &base, &block, &cancel).await })
                .await;
            let _ = owner.update_in(cx, |this, window, cx| {
                this.loading = false;
                match result {
                    Ok(scene) => {
                        this.original = Some(scene.clone());
                        let board = cx.new(|cx| BoardView::new(scene, window, cx));
                        this.observation = Some(cx.observe(&board, |_, _, cx| cx.notify()));
                        this.board = Some(board);
                    }
                    Err(e) => this.error = Some(e),
                }
                cx.notify();
            });
        }));
        this
    }
    pub fn is_failed(&self) -> bool {
        !self.saving && self.pending.is_some()
    }
    pub fn is_saving(&self) -> bool {
        self.saving || self.pending.is_some()
    }
    pub fn close(&mut self, cx: &mut Context<Self>) {
        if self.is_saving() {
            self.error = Some("白板保存尚未确认，请重试后再关闭".into());
            cx.notify();
            return;
        }
        self.cancel.store(true, Ordering::Relaxed);
        cx.emit(BoardEvent::Closed(None));
    }
    fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.saving || self.loading {
            return;
        }
        let Some(client) = cx
            .try_global::<BackendSession>()
            .map(|s| s.client().clone())
        else {
            return;
        };
        let Some(board) = &self.board else { return };
        if board.read(cx).is_loading() {
            return;
        }
        let reconnecting = !client.is_connected();
        if reconnecting && !BackendSession::begin_reconnect(cx) {
            self.error = Some("正在重新连接，请稍后重试".into());
            cx.notify();
            return;
        }
        let scene = board.read(cx).scene().clone();
        let original = self.original.clone().unwrap();
        let base = self.base.clone();
        let block = self.block.id().to_owned();
        let pending = self.pending.take();
        self.saving = true;
        self.error = None;
        self.focus.focus(window, cx);
        self.task = Some(cx.spawn_in(window, async move |owner, cx| {
            let was_uncertain = pending.is_some();
            let mut client = client;
            let mut connected = true;
            if reconnecting {
                let replacement = client.reconnect().recv().await.ok().and_then(Result::ok);
                let _ = owner.update_in(cx, |_, _, cx| {
                    BackendSession::end_reconnect(replacement.clone(), cx)
                });
                if let Some(replacement) = replacement {
                    client = replacement;
                } else {
                    connected = false;
                }
            }
            let prepared = match pending {
                Some(p) => Ok(p),
                None => {
                    cx.background_spawn(async move { prepare(base, block, &scene, &original) })
                        .await
                }
            };
            let (result, pending) = match prepared {
                Err(e) => (Err((e, false)), None),
                Ok(p) => {
                    let result = if connected {
                        submit(&client, &p).await
                    } else {
                        Err(SaveFailure::Uncertain(
                            "无法重新连接，白板草稿已保留".into(),
                        ))
                    };
                    let result = result.map_err(|error| error.retained(was_uncertain));
                    (result, Some(p))
                }
            };
            let _ = owner.update_in(cx, |this, _, cx| {
                this.saving = false;
                match result {
                    Ok(snapshot) => cx.emit(BoardEvent::Closed(Some(snapshot))),
                    Err((error, uncertain)) => {
                        this.pending = if uncertain { pending } else { None };
                        this.error = Some(error);
                        cx.notify();
                    }
                }
            });
        }));
        cx.notify();
    }
}
impl Render for BoardSession {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .flex_col()
            .key_context("BoardSession")
            .track_focus(&self.focus)
            .on_action(cx.listener(|this, _: &Save, w, cx| this.save(w, cx)))
            .on_action(cx.listener(|this, _: &crate::shell::CloseWindow, _, cx| this.close(cx)))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .p_3()
                    .child(div().flex_1().child("白板"))
                    .child(
                        Button::new("board-session-copy")
                            .label("复制场景")
                            .disabled(self.board.is_none())
                            .on_click(cx.listener(|this, _, _, cx| {
                                if let Some(board) = &this.board
                                    && let Ok(source) = board.read(cx).scene().serialize()
                                {
                                    cx.write_to_clipboard(ClipboardItem::new_string(source));
                                }
                            })),
                    )
                    .child(
                        Button::new("board-session-cancel")
                            .label("取消")
                            .disabled(self.is_saving())
                            .on_click(cx.listener(|this, _, _, cx| this.close(cx))),
                    )
                    .child(
                        Button::new("board-session-save")
                            .primary()
                            .label(if self.pending.is_some() {
                                "重试保存"
                            } else {
                                "保存白板"
                            })
                            .disabled(
                                self.loading
                                    || self.saving
                                    || self.board.as_ref().is_none_or(|b| b.read(cx).is_loading()),
                            )
                            .on_click(cx.listener(|this, _, w, cx| this.save(w, cx))),
                    ),
            )
            .when_some(self.error.clone(), |view, error| {
                view.child(div().p_3().text_color(cx.theme().danger).child(error))
            })
            .child(if self.loading || self.saving || self.pending.is_some() {
                div()
                    .flex_1()
                    .p_4()
                    .child(if self.loading {
                        "正在打开白板"
                    } else if self.saving {
                        "正在保存白板"
                    } else {
                        "草稿已保留。重试会核对保存结果，不会覆盖更新的笔记。"
                    })
                    .into_any_element()
            } else if let Some(board) = &self.board {
                div()
                    .flex_1()
                    .min_h_0()
                    .child(board.clone())
                    .into_any_element()
            } else {
                div().into_any_element()
            })
    }
}
async fn load(
    client: &BackendClient,
    base: &DocumentSnapshot,
    block: &BoardBlock,
    cancel: &AtomicBool,
) -> Result<Scene, String> {
    let Some(resource) = block.resource() else {
        return Scene::parse(
            r#"{"type":"excalidraw","version":2,"elements":[],"files":{},"appState":{}}"#,
        )
        .map_err(|e| e.to_string());
    };
    let scope = |resource| ImageScope {
        document: base.id().clone(),
        revision: base.head(),
        resource,
    };
    let (_, bytes) = service::read(client, &scope(resource), cancel).await?;
    if bytes.len() > MAX_SCENE_BYTES {
        return Err("白板场景超过 2 MiB".into());
    }
    let mut json: Value = serde_json::from_slice(&bytes).map_err(|_| "白板场景无效")?;
    let mut total = 0;
    if let Some(files) = json.get_mut("files").and_then(Value::as_object_mut) {
        if files.len() > 128 {
            return Err("白板嵌图数量超过上限".into());
        }
        for file in files.values_mut() {
            let id = file
                .get("resourceId")
                .and_then(Value::as_str)
                .ok_or("白板嵌图引用缺失")?;
            let (_, bytes) = service::read(
                client,
                &scope(Uuid::parse_str(id).map_err(|_| "白板资源 ID 无效")?),
                cancel,
            )
            .await?;
            total += bytes.len();
            if total > 100 * 1024 * 1024 {
                return Err("白板嵌图超过 100 MiB".into());
            }
            let mime = codec::inspect(&bytes)?.mime;
            file["dataURL"] =
                Value::String(format!("data:{mime};base64,{}", STANDARD.encode(bytes)));
        }
    }
    Scene::from_json(json).map_err(|e| e.to_string())
}
fn prepare(
    base: DocumentSnapshot,
    block: String,
    scene: &Scene,
    original: &Scene,
) -> Result<Prepared, String> {
    let mut json = scene.to_json();
    let mut uploads = vec![];
    let mut total = 0;
    if let Some(files) = json.get_mut("files").and_then(Value::as_object_mut) {
        if files.len() > 128 {
            return Err("白板嵌图数量超过上限".into());
        }
        for (id, file) in files {
            let old = original.field("files").and_then(|f| f.get(id));
            let reuse = old.is_some_and(|old| {
                old.get("resourceId").is_some()
                    && old.get("resourceId") == file.get("resourceId")
                    && old.get("dataURL") == file.get("dataURL")
            });
            if !reuse {
                let bytes = super::assets::decode_data_url(
                    file.get("dataURL")
                        .and_then(Value::as_str)
                        .ok_or("嵌图尚未加载")?,
                )?;
                total += bytes.len();
                if total > 100 * 1024 * 1024 || uploads.len() >= 30 {
                    return Err("本次白板新增嵌图超过 30 张或 100 MiB".into());
                }
                codec::inspect(&bytes)?;
                let resource = Uuid::new_v4();
                file["resourceId"] = Value::String(resource.to_string());
                uploads.push((resource, Arc::new(bytes)));
            }
            file.as_object_mut()
                .ok_or("嵌图格式无效")?
                .remove("dataURL");
        }
    }
    let serialized = serde_json::to_string(&json).map_err(|e| e.to_string())?;
    if serialized.len() > MAX_SCENE_BYTES {
        return Err("白板场景超过 2 MiB".into());
    }
    let preview = super::preview::png(scene)?;
    if total + preview.len() > 100 * 1024 * 1024 {
        return Err("本次白板资源超过 100 MiB".into());
    }
    let preview_id = Uuid::new_v4();
    let request = BoardSave::new(
        base,
        block,
        serialized,
        Uuid::new_v4(),
        preview_id,
        uploads.iter().map(|(id, _)| *id).collect(),
    );
    uploads.push((preview_id, Arc::new(preview)));
    Ok(Prepared { request, uploads })
}
async fn submit(
    client: &BackendClient,
    prepared: &Prepared,
) -> Result<DocumentSnapshot, SaveFailure> {
    let request = &prepared.request;
    let mut lease = service::UploadLease {
        client: client.clone(),
        document: request.base().id().clone(),
        resources: vec![],
    };
    for (id, bytes) in &prepared.uploads {
        lease.resources.push(*id);
        service::upload(
            client,
            request.base().id().clone(),
            *id,
            "whiteboard".into(),
            bytes,
        )
        .await
        .map_err(SaveFailure::BeforeCommit)?;
    }
    use anynote_core::backend::ErrorCode;
    let response = async {
        client
            .submit(
                Command::SaveBoard(request.clone()),
                std::time::Duration::from_secs(30),
            )?
            .receive()
            .await
    }
    .await
    .map_err(|e| {
        let uncertain = matches!(
            e.code(),
            ErrorCode::Timeout | ErrorCode::Disconnected | ErrorCode::ShuttingDown
        );
        let message = if e.code() == ErrorCode::Conflict {
            "笔记已被更新，白板草稿已保留。可复制场景或取消后重新打开。"
        } else {
            "白板保存失败，草稿已保留。"
        };
        if uncertain {
            SaveFailure::Uncertain(message.into())
        } else {
            SaveFailure::Rejected(message.into())
        }
    })?;
    let crate::backend_client::Response::Reply(reply) = response else {
        return Err(SaveFailure::Uncertain("白板保存响应无效".into()));
    };
    match reply {
        Reply::Document(snapshot)
            if snapshot.id() == request.base().id()
                && snapshot.revision() == request.base().revision() + 1
                && Some(snapshot.content().body()) == request.body().as_deref() =>
        {
            Ok(snapshot)
        }
        _ => Err(SaveFailure::Uncertain(
            "白板保存响应无效，草稿已保留".into(),
        )),
    }
}
