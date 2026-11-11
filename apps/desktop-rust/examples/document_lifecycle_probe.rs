//! Native close/quit acceptance surface; requires an explicit isolated state directory.
use anynote_core::backend::{Command, Reply};
use anynote_desktop::{
    backend_client::{BackendClient, Response},
    backend_session::BackendSession,
    document_editor::{self, DocumentEditor},
};
use gpui_kit::*;
use std::{path::PathBuf, time::Duration};
actions!(lifecycle_probe, [NativeQuit]);

fn main() {
    let state = PathBuf::from(
        std::env::var_os("ANYNOTE_LIFECYCLE_STATE_DIR").expect("isolated state directory"),
    );
    std::fs::create_dir_all(&state).unwrap();
    let backend =
        PathBuf::from(std::env::var_os("ANYNOTE_LIFECYCLE_BACKEND").expect("backend executable"));
    let client = BackendClient::launch(backend, state.canonicalize().unwrap())
        .recv_blocking()
        .unwrap()
        .unwrap();
    let open = |command| {
        client
            .submit(command, Duration::from_secs(10))?
            .receive_blocking()
    };
    let response = open(Command::OpenLastDocument)
        .or_else(|_| open(Command::CreateDocument))
        .unwrap();
    let Response::Reply(Reply::Document(snapshot)) = response else {
        panic!("document snapshot")
    };
    std::fs::write(state.join("opened.md"), snapshot.content().body()).unwrap();
    if std::env::var_os("ANYNOTE_LIFECYCLE_DISCONNECT").is_some() {
        client.terminate();
    }
    gpui_kit::application()
        .with_assets(gpui_kit::assets::Assets)
        .with_quit_mode(QuitMode::Explicit)
        .run(move |cx| {
            gpui_kit::init(cx);
            document_editor::install_actions(cx);
            BackendSession::install(client, cx);
            // Deliberately enter the OS terminate path instead of the application's quit action.
            cx.on_action(|_: &NativeQuit, cx| cx.quit());
            cx.bind_keys([KeyBinding::new("cmd-q", NativeQuit, None)]);
            cx.set_menus([Menu {
                name: "Anynote F002".into(),
                items: vec![MenuItem::action("Quit", NativeQuit)],
                disabled: false,
            }]);
            let (_, editor) = gpui_kit::open_window(
                WindowOptions {
                    titlebar: Some(TitlebarOptions {
                        title: Some("Anynote F002 生命周期验证".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                cx,
                |window, cx| cx.new(|cx| DocumentEditor::from_snapshot(snapshot, window, cx)),
            )
            .unwrap();
            let output = state.join("observed.md");
            cx.observe(&editor, move |editor, cx| {
                std::fs::write(&output, editor.read(cx).source()).unwrap();
            })
            .detach();
            cx.on_quit_requested(|cx| {
                eprintln!(
                    "native quit request; saving={}",
                    cx.global::<BackendSession>().is_quitting()
                );
                true
            })
            .detach();
            cx.on_window_closed(|cx, _| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();
            cx.activate(true);
        });
}
