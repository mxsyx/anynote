//! Isolated feasibility probe: local Excalidraw assets and synthetic scene files only.
use base64::Engine as _;
use gpui_kit::*;
use gpui_webview::WebView;
use serde_json::{Value, json};
use std::{borrow::Cow, fs, path::PathBuf, time::Duration};

const ORIGIN: &str = if cfg!(target_os = "windows") {
    "http://anynote-board.localhost"
} else {
    "anynote-board://localhost"
};
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

struct Probe {
    view: Option<Entity<WebView>>,
    receiver: async_channel::Receiver<Value>,
    assets: PathBuf,
    output: PathBuf,
    generation: usize,
    last_command: Value,
    _task: Task<()>,
}

impl Probe {
    fn open(
        assets: PathBuf,
        scene: Value,
        window: &mut Window,
        cx: &mut App,
    ) -> (Entity<WebView>, async_channel::Receiver<Value>) {
        let (sender, receiver) = async_channel::unbounded();
        let native = WebView::build(
            wry::WebViewBuilder::new()
                .with_incognito(true)
                .with_devtools(false)
                .with_clipboard(true)
                .with_download_started_handler(|_, _| false)
                .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
                .with_initialization_script(format!("window.EXCALIDRAW_ASSET_PATH = '{ORIGIN}/excalidraw/'; window.__initialScene = {scene};"))
                .with_custom_protocol("anynote-board".into(), move |_, request| {
                    let path = request.uri().path();
                    let file = assets.join(path.trim_start_matches('/'));
                    let mime = match file.extension().and_then(|s| s.to_str()) {
                        Some("html") => "text/html; charset=utf-8",
                        Some("js") => "text/javascript",
                        Some("css") => "text/css",
                        Some("woff2") => "font/woff2",
                        Some("png") => "image/png",
                        Some("svg") => "image/svg+xml",
                        _ => "application/octet-stream",
                    };
                    let bytes = file
                        .canonicalize()
                        .ok()
                        .filter(|path| path.starts_with(&assets))
                        .and_then(|path| fs::read(path).ok());
                    wry::http::Response::builder()
                        .status(if bytes.is_some() && request.method() == "GET" {
                            200
                        } else {
                            404
                        })
                        .header("Content-Type", mime)
                        .header("Content-Security-Policy", CSP)
                        .header("X-Content-Type-Options", "nosniff")
                        .body(Cow::Owned(bytes.unwrap_or_default()))
                        .unwrap()
                })
                .with_navigation_handler(|url| url == format!("{ORIGIN}/index.html"))
                .with_ipc_handler(move |request| {
                    if request.uri().to_string().starts_with(&format!("{ORIGIN}/"))
                        && request.body().len() <= 32 * 1024 * 1024
                        && let Ok(message) = serde_json::from_str(request.body())
                    {
                        let _ = sender.try_send(message);
                    }
                })
                .with_url(format!("{ORIGIN}/index.html")),
            window,
            cx,
        )
        .expect("create system WebView");
        let view = cx.new(|_| native);
        view.read(cx).focus_handle(cx).focus(window, cx);
        view.read(cx).raw().focus().expect("focus WebView");
        (view, receiver)
    }

    fn new(assets: PathBuf, output: PathBuf, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (view, receiver) = Self::open(assets.clone(), Value::Null, window, cx);
        let task = cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(50))
                    .await;
                if this
                    .update_in(cx, |this, window, cx| this.poll(window, cx))
                    .is_err()
                {
                    break;
                }
            }
        });
        Self {
            view: Some(view),
            receiver,
            assets,
            output,
            generation: 0,
            last_command: Value::Null,
            _task: task,
        }
    }

    fn record(&self, name: &str, value: &Value) {
        let pending = self.output.join(format!("{name}.pending"));
        fs::write(&pending, serde_json::to_vec_pretty(value).unwrap()).unwrap();
        fs::rename(pending, self.output.join(format!("{name}.json"))).unwrap();
    }

    fn poll(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        while let Ok(message) = self.receiver.try_recv() {
            let kind = message["kind"].as_str().unwrap_or("unknown");
            if kind == "ready" {
                self.record(&format!("ready-{}", self.generation), &message);
            } else if kind == "save" {
                self.record("scene", &message["scene"]);
            } else if kind == "export" {
                let encoded = message["dataURL"]
                    .as_str()
                    .unwrap()
                    .split_once(',')
                    .unwrap()
                    .1;
                fs::write(
                    self.output.join("preview.png"),
                    base64::engine::general_purpose::STANDARD
                        .decode(encoded)
                        .unwrap(),
                )
                .unwrap();
            }
            if let Some(id) = message["id"].as_u64() {
                self.record(&format!("response-{id}"), &message);
            }
            if kind == "error" || kind == "csp" {
                use std::io::Write as _;
                let mut file = fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(self.output.join("errors.jsonl"))
                    .unwrap();
                writeln!(file, "{message}").unwrap();
            }
        }
        let command = fs::read(self.output.join("command.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        let Some(command) = command else {
            return;
        };
        if command["id"] == self.last_command {
            return;
        }
        self.last_command = command["id"].clone();
        let action = command["action"].as_str().unwrap_or("");
        match action {
            "reopen" => {
                if let Some(view) = self.view.take() {
                    view.read(cx).set_visible(false).unwrap();
                }
                self.generation += 1;
                let scene =
                    serde_json::from_slice(&fs::read(self.output.join("scene.json")).unwrap())
                        .unwrap();
                let (view, receiver) = Self::open(self.assets.clone(), scene, window, cx);
                self.view = Some(view);
                self.receiver = receiver;
                cx.notify();
            }
            "hide" | "show" => {
                let view = self.view.as_ref().unwrap().read(cx);
                view.set_visible(action == "show").unwrap();
                if action == "show" {
                    view.raw().focus().unwrap();
                }
                self.record(
                    &format!("response-{}", command["id"]),
                    &json!({"kind":"visibility", "visible":view.visible()}),
                );
                cx.notify();
            }
            "quit" => {
                if let Some(view) = self.view.take() {
                    view.read(cx).set_visible(false).unwrap();
                }
                self.record("closed", &json!({"generation":self.generation}));
                window.remove_window();
                cx.quit();
            }
            _ => {
                self.view
                    .as_ref()
                    .unwrap()
                    .read(cx)
                    .raw()
                    .evaluate_script(&format!("window.probe({command});"))
                    .expect("send probe command");
            }
        }
    }
}

impl Render for Probe {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().children(self.view.clone())
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let assets = PathBuf::from(args.next().expect("built asset directory"))
        .canonicalize()
        .unwrap();
    let output = PathBuf::from(args.next().expect("isolated report directory"));
    fs::create_dir_all(&output).unwrap();
    #[cfg(target_os = "linux")]
    let app = gpui_kit::platform::linux(WindowingModes::X11);
    #[cfg(not(target_os = "linux"))]
    let app = gpui_kit::application();
    app.with_quit_mode(QuitMode::LastWindowClosed)
        .run(move |cx| {
            gpui_kit::init(cx);
            gpui_kit::open_window(
                WindowOptions {
                    titlebar: Some(TitlebarOptions {
                        title: Some("Anynote Excalidraw WebView probe".into()),
                        ..Default::default()
                    }),
                    // A fixed logical viewport keeps the external input coordinates reproducible.
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        point(px(40.), px(40.)),
                        size(px(1100.), px(760.)),
                    ))),
                    ..Default::default()
                },
                cx,
                move |window, cx| cx.new(|cx| Probe::new(assets, output, window, cx)),
            )
            .unwrap();
            cx.activate(true);
        });
}
