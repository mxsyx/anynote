//! Real engine lifecycle evidence. Never opens remote pages or user notebooks.
use anynote_core::document_session::DocumentId;
use anynote_desktop::webview::{
    MediaHost,
    policy::{Binding, Message},
};
use gpui_kit::*;
use std::{path::PathBuf, time::Duration};
use uuid::Uuid;

struct Probe {
    host: Option<MediaHost>,
    task: Option<Task<()>>,
    label: String,
}
impl Probe {
    fn new(path: PathBuf, cycles: usize, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let task = cx.spawn_in(window, async move |this, cx| {
            let mut completed = 0;
            let mut failure = None;
            for _ in 0..cycles {
                let receiver = this.update_in(cx, |this, window, cx| {
                    let document = DocumentId::new(Uuid::new_v4(), Uuid::new_v4());
                    let revision = Uuid::new_v4();
                    let binding = Binding::new(document.clone(), revision);
                    let (host, receiver) = MediaHost::local(binding, window, cx)?;
                    host.publish_resource(&anynote_core::asset::AssetScope::new(document, revision, Uuid::new_v4()), std::sync::Arc::from(&include_bytes!("../../../tests/fixtures/rust-migration/corpus/media/pixel.png")[..])).map_err(|e| format!("resource: {e:?}"))?;
                    host.focus(window, cx)?;
                    this.host = Some(host); cx.notify(); Ok::<_, String>(receiver)
                });
                let receiver = match receiver { Ok(Ok(receiver)) => receiver, other => { failure = Some(format!("create: {other:?}")); break; } };
                let mut ready = false;
                for _ in 0..50 {
                    cx.background_executor().timer(Duration::from_millis(100)).await;
                    if matches!(receiver.try_recv(), Ok(Message::Rendered { generation: 0 })) { ready = true; break; }
                }
                if !ready { failure = Some("local bridge or Range resource timeout".into()); break; }
                let result = this.update_in(cx, |this, window, cx| {
                    let host = this.host.as_ref().unwrap();
                    for factor in [1., 1.5, 2.] {
                        let view = host.view().unwrap();
                        view.update(cx, |view, _| view.set_bounds(wry::Rect {
                            position: wry::dpi::LogicalPosition::new(0., 40.).into(),
                            size: wry::dpi::LogicalSize::new(320. * factor, 200. * factor).into(),
                        })).map_err(|e| e.to_string())?;
                    }
                    host.set_visible(false, cx)?;
                    if host.view().unwrap().read(cx).visible() { return Err("hide did not update visibility".to_owned()); }
                    host.set_visible(true, cx)?;
                    host.focus(window, cx)?;
                    this.host.as_mut().unwrap().close(cx); this.host = None;
                    this.label = "Closed".into(); cx.notify(); Ok::<_, String>(())
                });
                if !matches!(result, Ok(Ok(()))) { failure = Some(format!("lifecycle: {result:?}")); break; }
                completed += 1;
                cx.background_executor().timer(Duration::from_millis(100)).await;
            }
            let _ = this.update_in(cx, |this, window, cx| {
                if let Some(host) = &mut this.host { host.close(cx); }
                this.host = None;
                let report = serde_json::json!({"platform":std::env::consts::OS,"cycles":completed,"requested":cycles,"failure":failure,"evidence":"real local engine ready/rendered IPC, capability Range read, native bounds, visibility, focus API and revoke; not physical focus or provider playback"});
                if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).unwrap(); }
                std::fs::write(path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
                window.remove_window(); cx.quit();
            });
        });
        Self {
            host: None,
            task: Some(task),
            label: "Local WebView lifecycle probe".into(),
        }
    }
}
impl Render for Probe {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let _ = &self.task;
        let mut root = div()
            .size_full()
            .flex()
            .flex_col()
            .child(self.label.clone());
        if let Some(view) = self.host.as_ref().and_then(MediaHost::view) {
            root = root.child(div().flex_1().child(view));
        }
        root
    }
}
fn main() {
    let path = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .expect("report path");
    let cycles = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(100);
    #[cfg(target_os = "linux")]
    let app = gpui_kit::platform::linux(WindowingModes::X11);
    #[cfg(not(target_os = "linux"))]
    let app = gpui_kit::application();
    app.run(move |cx| {
        gpui_kit::init(cx);
        gpui_kit::open_window(WindowOptions::default(), cx, move |window, cx| {
            cx.new(|cx| Probe::new(path, cycles, window, cx))
        })
        .unwrap();
        cx.activate(true);
    });
}
