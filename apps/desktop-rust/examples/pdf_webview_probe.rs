//! Open a synthetic PDF through the production system viewer and revision-scoped backend.
use anynote_core::backend::{Command, Reply};
use anynote_desktop::pdf::PdfView;
use gpui_kit::*;
use std::{path::PathBuf, time::Duration};
#[path = "../tests/support/pdf_backend.rs"]
mod support;

struct Probe {
    view: Entity<PdfView>,
    _backend: support::PdfBackend,
    _task: Task<()>,
}
impl Probe {
    fn new(
        output: PathBuf,
        fixture: &str,
        seconds: u64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let backend = support::PdfBackend::new(fixture);
        assert!(matches!(backend.reply(Command::Ping), Reply::Pong));
        let view =
            cx.new(|cx| PdfView::new(backend.scope.clone(), backend.client.clone(), window, cx));
        let task = cx.spawn_in(window, async move |this, cx| {
            for _ in 0..300 {
                cx.background_executor().timer(Duration::from_millis(100)).await;
                let done = this.update(cx, |this, cx| {
                    let view = this.view.read(cx);
                    if view.is_loading() { return false; }
                    let report = serde_json::json!({"platform": std::env::consts::OS, "loadFinished": true, "error": view.error(), "evidence": "System WebView load event only; inspect the window for PDF rendering and interactions"});
                    if let Some(parent) = output.parent() { std::fs::create_dir_all(parent).unwrap(); }
                    std::fs::write(&output, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
                    true
                }).unwrap_or(true);
                if done { break; }
            }
            cx.background_executor().timer(Duration::from_secs(seconds)).await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.view.update(cx, |v, cx| v.close(cx));
                if let Ok(bytes) = std::fs::read(&output) {
                    let mut report: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                    report["closed"] = true.into();
                    std::fs::write(&output, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
                }
                window.remove_window();
                cx.quit();
            });
        });
        Self {
            view,
            _backend: backend,
            _task: task,
        }
    }
}
impl Render for Probe {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(self.view.clone())
    }
}
fn main() {
    let output = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .expect("report path");
    let fixture = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "geometry.pdf".into());
    let seconds = std::env::args()
        .nth(3)
        .and_then(|value| value.parse().ok())
        .unwrap_or(180);
    #[cfg(target_os = "linux")]
    let app = gpui_kit::platform::linux(WindowingModes::X11);
    #[cfg(not(target_os = "linux"))]
    let app = gpui_kit::application();
    app.run(move |cx| {
        gpui_kit::init(cx);
        gpui_kit::open_window(
            WindowOptions {
                titlebar: Some(TitlebarOptions {
                    title: Some("PDF system viewer probe".into()),
                    ..Default::default()
                }),
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    point(px(0.), px(0.)),
                    size(px(1000.), px(800.)),
                ))),
                ..Default::default()
            },
            cx,
            |window, cx| cx.new(|cx| Probe::new(output, &fixture, seconds, window, cx)),
        )
        .unwrap();
        cx.activate(true);
    });
}
