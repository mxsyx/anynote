use anynote_editor::board::Scene;
use gpui_kit::prelude::*;
use gpui_kit::{
    component::{ActiveTheme, Theme},
    *,
};
use gpui_webview::WebView;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{borrow::Cow, cell::Cell, sync::Arc, time::Duration};
use uuid::Uuid;

include!(concat!(env!("OUT_DIR"), "/whiteboard_assets.rs"));
const MAX_MESSAGE: usize = 160 * 1024 * 1024;
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

pub(crate) fn bundled_asset(path: &str) -> Option<&'static [u8]> {
    ASSETS
        .binary_search_by_key(&path, |(name, _)| *name)
        .ok()
        .map(|ix| ASSETS[ix].1)
}

pub fn install_actions(cx: &mut App) {
    super::session::install_actions(cx);
}

#[derive(Deserialize)]
struct Envelope {
    token: Uuid,
    #[serde(flatten)]
    message: Message,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Message {
    Ready,
    Save,
    Snapshot {
        request: Uuid,
        scene: Value,
        preview: Option<String>,
    },
    CaptureError {
        request: Uuid,
        message: String,
    },
    Error {
        message: String,
    },
}

pub(super) enum BoardViewEvent {
    Ready,
    Save,
    Captured(Arc<Captured>),
    Failed(String),
}
pub(super) struct Captured {
    pub scene: Value,
    pub preview: Option<String>,
}

pub struct BoardView {
    webview: Option<Entity<WebView>>,
    token: Uuid,
    ready: bool,
    visible: Cell<bool>,
    pending: Option<Uuid>,
    error: Option<String>,
    focus: FocusHandle,
    _receiver: Option<Task<()>>,
    timeout: Option<Task<()>>,
    _theme: Subscription,
}
impl EventEmitter<BoardViewEvent> for BoardView {}
impl Focusable for BoardView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}
impl BoardView {
    pub fn new(scene: Scene, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let token = Uuid::new_v4();
        let origin = if cfg!(target_os = "windows") {
            format!("http://anynote-board.{token}")
        } else {
            format!("anynote-board://{token}")
        };
        let page = format!("{origin}/index.html");
        let allowed = page.clone();
        let expected_origin = origin.clone();
        let (sender, receiver) = async_channel::bounded(8);
        let theme = if cx.theme().is_dark() {
            "dark"
        } else {
            "light"
        };
        let bootstrap = json!({"token":token,"scene":scene.to_json(),"theme":theme});
        let result = WebView::build(
            wry::WebViewBuilder::new()
                .with_incognito(true)
                .with_clipboard(true)
                .with_devtools(false)
                .with_download_started_handler(|_, _| false)
                .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
                .with_initialization_script(format!(
                    "window.EXCALIDRAW_ASSET_PATH={};window.__anynoteBoard={bootstrap};",
                    serde_json::to_string(&format!("{origin}/excalidraw/")).unwrap()
                ))
                .with_custom_protocol("anynote-board".into(), |_, request| {
                    let path = request.uri().path().trim_start_matches('/');
                    let bytes = (request.method() == "GET")
                        .then(|| bundled_asset(path))
                        .flatten();
                    let mime = match path.rsplit('.').next().unwrap_or("") {
                        "html" => "text/html; charset=utf-8",
                        "js" => "text/javascript",
                        "css" => "text/css",
                        "woff2" => "font/woff2",
                        "svg" => "image/svg+xml",
                        "png" => "image/png",
                        "wasm" => "application/wasm",
                        "json" => "application/json",
                        "txt" => "text/plain; charset=utf-8",
                        _ => "application/octet-stream",
                    };
                    wry::http::Response::builder()
                        .status(if bytes.is_some() { 200 } else { 404 })
                        .header("Content-Type", mime)
                        .header("Content-Security-Policy", CSP)
                        .header("X-Content-Type-Options", "nosniff")
                        .body(Cow::Borrowed(bytes.unwrap_or(&[])))
                        .unwrap()
                })
                .with_navigation_handler(move |url| url == allowed)
                .with_ipc_handler(move |request| {
                    if request.uri().to_string() != format!("{expected_origin}/index.html")
                        || request.body().len() > MAX_MESSAGE
                    {
                        return;
                    }
                    if let Ok(envelope) = serde_json::from_str::<Envelope>(request.body())
                        && envelope.token == token
                    {
                        let _ = sender.try_send(envelope.message);
                    }
                })
                .with_url(page),
            window,
            cx,
        );
        let (webview, error) = match result {
            Ok(view) => (Some(cx.new(|_| view)), None),
            Err(error) => (None, Some(format!("无法打开系统白板：{error}"))),
        };
        let focus = webview
            .as_ref()
            .map(|view| view.read(cx).focus_handle(cx))
            .unwrap_or_else(|| cx.focus_handle());
        focus.focus(window, cx);
        let task = cx.spawn_in(window, async move |this, cx| {
            while let Ok(message) = receiver.recv().await {
                if this
                    .update_in(cx, |this, _, cx| this.accept(message, cx))
                    .is_err()
                {
                    break;
                }
            }
        });
        let theme = cx.observe_global::<Theme>(|this, cx| {
            let theme = if cx.theme().is_dark() {
                "dark"
            } else {
                "light"
            };
            let _ = this.send(json!({"kind":"theme","theme":theme}), cx);
        });
        let startup = cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_secs(30))
                .await;
            let _ = this.update(cx, |this, cx| {
                if !this.ready && this.error.is_none() {
                    this.error = Some("白板加载超时，请取消后重新打开".into());
                    cx.notify();
                }
            });
        });
        Self {
            webview,
            token,
            ready: false,
            visible: Cell::new(true),
            pending: None,
            error,
            focus,
            _receiver: Some(task),
            timeout: Some(startup),
            _theme: theme,
        }
    }
    pub(super) fn is_loading(&self) -> bool {
        !self.ready
    }
    pub(super) fn set_visible(&self, visible: bool, cx: &App) {
        if self.visible.replace(visible) == visible {
            return;
        }
        if let Some(view) = &self.webview {
            let _ = view.read(cx).set_visible(visible);
        }
    }
    pub(super) fn capture(&mut self, preview: bool, cx: &mut Context<Self>) -> Result<(), String> {
        if !self.ready || self.pending.is_some() {
            return Err("白板尚未就绪，请稍后重试".into());
        }
        let request = Uuid::new_v4();
        self.send(
            json!({"kind":"capture","request":request,"preview":preview}),
            cx,
        )?;
        self.pending = Some(request);
        self.timeout = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_secs(30))
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.pending == Some(request) {
                    this.pending = None;
                    this.resume(cx);
                    cx.emit(BoardViewEvent::Failed(
                        "白板快照超时，草稿已保留，请重试".into(),
                    ));
                }
            });
        }));
        Ok(())
    }
    pub(super) fn resume(&self, cx: &App) {
        let _ = self.send(json!({"kind":"resume"}), cx);
        if let Some(view) = &self.webview {
            let _ = view.read(cx).raw().focus();
        }
    }
    fn send(&self, mut command: Value, cx: &App) -> Result<(), String> {
        command["token"] = json!(self.token);
        self.webview
            .as_ref()
            .ok_or("白板视图不可用")?
            .read(cx)
            .raw()
            .evaluate_script(&format!("window.anynoteBoard?.({command});"))
            .map_err(|e| e.to_string())
    }
    fn accept(&mut self, message: Message, cx: &mut Context<Self>) {
        match message {
            Message::Ready => {
                self.ready = true;
                self.timeout = None;
                cx.emit(BoardViewEvent::Ready);
            }
            Message::Save if self.pending.is_none() => cx.emit(BoardViewEvent::Save),
            Message::Snapshot {
                request,
                scene,
                preview,
            } if self.pending == Some(request) => {
                self.pending = None;
                self.timeout = None;
                cx.emit(BoardViewEvent::Captured(Arc::new(Captured {
                    scene,
                    preview,
                })));
            }
            Message::CaptureError { request, message } if self.pending == Some(request) => {
                self.pending = None;
                self.timeout = None;
                self.resume(cx);
                cx.emit(BoardViewEvent::Failed(message));
            }
            Message::Error { message } => {
                if self.pending.take().is_some() {
                    self.timeout = None;
                    self.resume(cx);
                }
                self.error = Some(message.clone());
                cx.emit(BoardViewEvent::Failed(message));
            }
            _ => {}
        }
        cx.notify();
    }
}
impl Render for BoardView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("board-webview")
            .size_full()
            .flex()
            .flex_col()
            .when_some(self.error.clone(), |view, error| {
                view.child(div().p_3().text_color(cx.theme().danger).child(error))
            })
            .when_some(self.webview.clone(), |view, webview| {
                view.child(div().flex_1().min_h_0().child(webview))
            })
    }
}
