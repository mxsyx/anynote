use anynote_core::backend::*;
use anynote_desktop::backend_client::{BackendClient, Response};
use gpui_kit::{
    test::{TestEventExt, TestQueryExt, TestWindowExt},
    *,
};
use std::{path::PathBuf, time::Duration};
use uuid::Uuid;
const WAIT: Duration = Duration::from_secs(10);
pub fn reply(client: &BackendClient, command: Command) -> Reply {
    match client
        .submit(command, WAIT)
        .unwrap()
        .receive_blocking()
        .unwrap()
    {
        Response::Reply(reply) => reply,
        _ => panic!("expected reply"),
    }
}
pub struct Backend {
    pub root: PathBuf,
    pub client: BackendClient,
}
impl Backend {
    pub fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tmp/rust-media-ui")
            .join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let client = BackendClient::launch(
            PathBuf::from(env!("CARGO_BIN_EXE_anynote-desktop")),
            root.clone(),
        )
        .recv_blocking()
        .unwrap()
        .unwrap();
        Self { root, client }
    }
}
impl Drop for Backend {
    fn drop(&mut self) {
        let _ = self
            .client
            .submit(Command::Shutdown, WAIT)
            .and_then(|h| h.receive_blocking());
        for _ in 0..100 {
            if self.client.has_exited() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
pub fn spin(
    cx: &mut TestAppContext,
    window: AnyWindowHandle,
    condition: impl Fn(&mut Window, &mut App) -> bool,
) {
    for _ in 0..400 {
        cx.run_until_parked();
        if cx
            .update_window(window, |_, w, cx| {
                w.render_frame(cx);
                condition(w, cx)
            })
            .unwrap()
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("image UI did not settle");
}
pub fn click_label(w: &mut Window, label: &str, cx: &mut App) {
    let point = w.find_all_by_label(label)[0].bounds().center();
    w.pointer_down(point, MouseButton::Left, cx);
    w.pointer_up(point, MouseButton::Left, cx);
}
