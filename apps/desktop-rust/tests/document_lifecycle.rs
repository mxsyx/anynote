#![cfg(feature = "ui-tests")]
use anynote_core::{backend::*, document_session::*};
#[cfg(target_os = "macos")]
use anynote_desktop::backend_client::BackendClient;
use anynote_desktop::{
    backend_session::BackendSession,
    document_editor::{self, DocumentEditor},
    shell::CloseWindow,
};
use core::prelude::v1::test;
use gpui_kit::{test::TestWindowExt, *};
#[cfg(target_os = "macos")]
use std::path::PathBuf;
use std::time::Duration;
#[cfg(target_os = "macos")]
use uuid::Uuid;
#[allow(dead_code)]
#[path = "support/media_ui.rs"]
mod media_ui;
use media_ui::{Backend, reply};

fn open(
    cx: &mut TestAppContext,
    backend: &Backend,
) -> (AnyWindowHandle, Entity<DocumentEditor>, DocumentSnapshot) {
    let Reply::Document(snapshot) = reply(&backend.client, Command::CreateDocument) else {
        panic!()
    };
    cx.update(|cx| {
        gpui_kit::init(cx);
        document_editor::install_actions(cx);
        BackendSession::install(backend.client.clone(), cx);
    });
    let (window, editor) = cx.update(|cx| {
        gpui_kit::open_window(WindowOptions::default(), cx, |w, cx| {
            cx.new(|cx| DocumentEditor::from_snapshot(snapshot.clone(), w, cx))
        })
        .unwrap()
    });
    cx.update_window(window, |_, w, cx| {
        editor.focus_handle(cx).focus(w, cx);
        w.render_frame(cx);
        editor.update(cx, |editor, cx| {
            editor.replace_and_mark_text_in_range(None, "退出保存中文🦀", None, w, cx);
        });
        w.render_frame(cx);
        assert!(editor.read(cx).is_composing());
    })
    .unwrap();
    (window, editor, snapshot)
}
fn settle(cx: &mut TestAppContext, condition: impl Fn(&mut App) -> bool) {
    for _ in 0..600 {
        cx.executor().advance_clock(Duration::from_millis(10));
        cx.run_until_parked();
        if cx.update(&condition) {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("document lifecycle did not settle");
}

#[gpui_kit::test]
fn close_completes_marked_input_and_reopens_saved_document(cx: &mut TestAppContext) {
    cx.background_executor.allow_parking();
    let backend = Backend::new();
    let (window, editor, base) = open(cx, &backend);
    cx.update_window(window, |_, w, cx| {
        w.dispatch_action(Box::new(CloseWindow), cx)
    })
    .unwrap();
    settle(cx, |cx| !cx.windows().contains(&window));
    let Reply::Document(saved) = reply(
        &backend.client,
        Command::OpenDocument {
            id: base.id().clone(),
        },
    ) else {
        panic!()
    };
    cx.update(|cx| {
        assert_eq!(editor.read(cx).text(), "退出保存中文🦀");
        assert_eq!(saved.content().body(), editor.read(cx).source());
    });
    cx.update(|cx| {
        assert!(!editor.read(cx).is_composing());
        assert_eq!(editor.read(cx).undo_steps(), 1);
        let (_, reopened) = gpui_kit::open_window(WindowOptions::default(), cx, |w, cx| {
            cx.new(|cx| DocumentEditor::from_snapshot(saved.clone(), w, cx))
        })
        .unwrap();
        assert_eq!(reopened.read(cx).source(), saved.content().body());
    });
}

#[cfg(target_os = "macos")]
#[gpui_kit::test]
fn system_quit_waits_for_composition_and_durable_save_before_shutdown(cx: &mut TestAppContext) {
    cx.background_executor.allow_parking();
    let backend = Backend::new();
    let (window, editor, base) = open(cx, &backend);
    cx.update(|cx| {
        assert!(!cx.should_quit());
        assert!(!cx.should_quit()); // repeated OS requests cannot bypass the save barrier
        assert!(cx.windows().contains(&window));
    });
    settle(cx, |_| backend.client.has_exited());
    assert!(cx.update(|cx| cx.should_quit()));
    let reopened = BackendClient::launch(
        PathBuf::from(env!("CARGO_BIN_EXE_anynote-desktop")),
        backend.root.clone(),
    )
    .recv_blocking()
    .unwrap()
    .unwrap();
    let Reply::Document(saved) = reply(
        &reopened,
        Command::OpenDocument {
            id: base.id().clone(),
        },
    ) else {
        panic!()
    };
    cx.update(|cx| {
        assert_eq!(editor.read(cx).text(), "退出保存中文🦀");
        assert_eq!(saved.content().body(), editor.read(cx).source());
    });
    reply(&reopened, Command::Shutdown);
    settle(cx, |_| reopened.has_exited());
}

#[cfg(target_os = "macos")]
#[gpui_kit::test]
fn failed_system_quit_keeps_draft_window_and_backend_alive(cx: &mut TestAppContext) {
    cx.background_executor.allow_parking();
    let backend = Backend::new();
    let (window, editor, base) = open(cx, &backend);
    reply(
        &backend.client,
        Command::SaveDocument(SaveDocument::new(
            Uuid::new_v4(),
            1,
            DocumentSnapshot::new(
                base.id().clone(),
                base.revision(),
                base.head(),
                base.content().with_body("remote".into()),
            ),
        )),
    );
    assert!(!cx.update(|cx| cx.should_quit()));
    settle(cx, |cx| !cx.global::<BackendSession>().is_quitting());
    cx.update(|cx| {
        assert!(cx.windows().contains(&window));
        assert!(!editor.read(cx).is_composing());
        assert_eq!(editor.read(cx).text(), "退出保存中文🦀");
        assert!(!cx.should_quit());
    });
    settle(cx, |cx| !cx.global::<BackendSession>().is_quitting());
    let Reply::Document(saved) = reply(
        &backend.client,
        Command::OpenDocument {
            id: base.id().clone(),
        },
    ) else {
        panic!()
    };
    assert_eq!(saved.content().body(), "remote");
    assert!(backend.client.is_connected());
    assert!(!backend.client.has_exited());
}

#[gpui_kit::test]
fn cancelling_prequit_preserves_handlers_until_unsubscribed(cx: &mut TestAppContext) {
    use std::{cell::Cell, rc::Rc};
    let ready = Rc::new(Cell::new(false));
    let subscription = cx.update(|cx| {
        let ready = ready.clone();
        cx.on_quit_requested(move |_| ready.get())
    });
    assert!(!cx.update(|cx| cx.should_quit()));
    assert!(!cx.update(|cx| cx.should_quit()));
    ready.set(true);
    assert!(cx.update(|cx| cx.should_quit()));
    ready.set(false);
    drop(subscription);
    assert!(cx.update(|cx| cx.should_quit()));
}
