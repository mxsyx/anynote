#![cfg(feature = "ui-tests")]
use anynote_core::{backend::*, board::*, document_session::*};
use anynote_desktop::{
    backend_session::BackendSession,
    board,
    document_editor::{self, DocumentEditor},
};
use gpui_kit::{
    AppContext, Bounds, Focusable, MouseButton, TestAppContext, WindowBounds, WindowOptions,
    component::{Theme, ThemeMode},
    point, px, size,
    test::{TestEventExt, TestQueryExt, TestWindowExt},
};
use uuid::Uuid;
#[path = "support/media_ui.rs"]
mod media_ui;
use media_ui::{Backend, click_label, reply, spin};
fn snapshot(backend: &Backend, id: &DocumentId) -> DocumentSnapshot {
    let Reply::Document(doc) = reply(&backend.client, Command::OpenDocument { id: id.clone() })
    else {
        panic!()
    };
    doc
}
#[gpui_kit::test]
fn explicit_save_cancel_flush_reopen_conflict_and_close_use_native_controls(
    cx: &mut TestAppContext,
) {
    cx.background_executor.allow_parking();
    let backend = Backend::new();
    let Reply::Document(doc) = reply(&backend.client, Command::CreateDocument) else {
        panic!()
    };
    let block = Uuid::new_v4();
    let body = format!("正文\n\n{}", empty(block));
    let Reply::DocumentSaved(saved) = reply(
        &backend.client,
        Command::SaveDocument(SaveDocument::new(
            Uuid::new_v4(),
            1,
            DocumentSnapshot::new(
                doc.id().clone(),
                doc.revision(),
                doc.head(),
                doc.content().with_body(body),
            ),
        )),
    ) else {
        panic!()
    };
    let initial = saved.snapshot().clone();
    cx.update(|cx| {
        gpui_kit::init(cx);
        document_editor::install_actions(cx);
        board::install_actions(cx);
        BackendSession::install(backend.client.clone(), cx);
    });
    let (window, editor) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(1000.), px(800.)),
                ))),
                ..Default::default()
            },
            cx,
            |w, cx| cx.new(|cx| DocumentEditor::from_snapshot(initial.clone(), w, cx)),
        )
        .unwrap()
    });
    let draft = cx
        .update_window(window, |_, w, cx| {
            w.render_frame(cx);
            editor.focus_handle(cx).focus(w, cx);
            w.render_frame(cx);
            w.input("打开前的未保存输入", cx);
            assert!(editor.read(cx).text().contains("打开前的未保存输入"));
            let draft = editor.read(cx).source().to_owned();
            click_label(w, "编辑白板…", cx);
            draft
        })
        .unwrap();
    spin(cx, window, |w, _| w.try_find("board-canvas").is_some());
    let initial = snapshot(&backend, initial.id());
    assert_eq!(initial.content().body(), draft);
    let draw = |w: &mut gpui_kit::Window, cx: &mut gpui_kit::App| {
        w.click("board-rectangle", cx);
        let at = w.find("board-canvas").bounds().origin + point(px(100.), px(100.));
        w.pointer_down(at, MouseButton::Left, cx);
        w.pointer_move(at + point(px(80.), px(60.)), Some(MouseButton::Left), cx);
        w.pointer_up(at + point(px(80.), px(60.)), MouseButton::Left, cx);
    };
    cx.update_window(window, |_, w, cx| {
        draw(w, cx);
        w.click("board-session-cancel", cx);
    })
    .unwrap();
    spin(cx, window, |w, _| {
        w.try_find_by_label("编辑白板…").is_some()
    });
    assert_eq!(snapshot(&backend, initial.id()), initial);
    cx.update_window(window, |_, w, cx| click_label(w, "编辑白板…", cx))
        .unwrap();
    spin(cx, window, |w, _| w.try_find("board-canvas").is_some());
    cx.update_window(window, |_, w, cx| {
        draw(w, cx);
        w.click("board-session-save", cx);
    })
    .unwrap();
    spin(cx, window, |w, _| {
        w.try_find_by_label("编辑白板…").is_some()
    });
    let first = snapshot(&backend, initial.id());
    assert_eq!(first.revision(), initial.revision() + 1);
    assert_eq!(first.resources().len(), 2);
    assert_eq!(
        cx.update(|cx| editor.read(cx).source().to_owned()),
        first.content().body()
    );
    cx.update_window(window, |_, w, cx| click_label(w, "编辑白板…", cx))
        .unwrap();
    spin(cx, window, |w, _| w.try_find("board-canvas").is_some());
    cx.update_window(window, |_, w, cx| {
        w.click("board-session-copy", cx);
        assert!(
            cx.read_from_clipboard()
                .unwrap()
                .text()
                .unwrap()
                .contains("rectangle")
        );
        Theme::change(ThemeMode::Dark, Some(w), cx);
        w.render_frame(cx);
        assert!(w.find("board-session-save").visible());
    })
    .unwrap();
    let Reply::DocumentSaved(later) = reply(
        &backend.client,
        Command::SaveDocument(SaveDocument::new(
            Uuid::new_v4(),
            2,
            DocumentSnapshot::new(
                first.id().clone(),
                first.revision(),
                first.head(),
                first
                    .content()
                    .with_body(format!("{}\n其他窗口的新正文", first.content().body())),
            ),
        )),
    ) else {
        panic!()
    };
    cx.update_window(window, |_, w, cx| {
        draw(w, cx);
        w.click("board-session-save", cx);
    })
    .unwrap();
    spin(cx, window, |w, _| {
        w.try_find("board-session-cancel")
            .is_some_and(|b| b.disabled() != Some(true))
            && w.try_find("board-canvas").is_some()
    });
    assert_eq!(snapshot(&backend, initial.id()), *later.snapshot());
    cx.update_window(window, |_, w, cx| {
        w.click("board-session-copy", cx);
        assert!(
            cx.read_from_clipboard()
                .unwrap()
                .text()
                .unwrap()
                .contains("rectangle")
        );
        w.click("board-session-cancel", cx);
    })
    .unwrap();
    spin(cx, window, |w, _| {
        w.try_find_by_label("编辑白板…").is_some()
    });
    cx.update_window(window, |_, w, _| w.remove_window())
        .unwrap();
}

#[gpui_kit::test]
fn insert_and_close_during_explicit_save_waits_for_the_atomic_ack(cx: &mut TestAppContext) {
    cx.background_executor.allow_parking();
    let backend = Backend::new();
    let Reply::Document(doc) = reply(&backend.client, Command::CreateDocument) else {
        panic!()
    };
    cx.update(|cx| {
        gpui_kit::init(cx);
        document_editor::install_actions(cx);
        board::install_actions(cx);
        BackendSession::install(backend.client.clone(), cx);
    });
    let (window, editor) = cx.update(|cx| {
        gpui_kit::open_window(WindowOptions::default(), cx, |w, cx| {
            cx.new(|cx| DocumentEditor::from_snapshot(doc.clone(), w, cx))
        })
        .unwrap()
    });
    cx.update_window(window, |_, w, cx| {
        w.render_frame(cx);
        editor.focus_handle(cx).focus(w, cx);
        w.dispatch_action(Box::new(document_editor::RunCommand::new("board")), cx);
    })
    .unwrap();
    spin(cx, window, |w, _| w.try_find("board-canvas").is_some());
    let before = snapshot(&backend, doc.id());
    assert_eq!(before.revision(), doc.revision() + 1);
    cx.update_window(window, |_, w, cx| {
        w.click("board-rectangle", cx);
        let at = w.find("board-canvas").bounds().center();
        w.pointer_down(at, MouseButton::Left, cx);
        w.pointer_move(at + point(px(60.), px(40.)), Some(MouseButton::Left), cx);
        w.pointer_up(at + point(px(60.), px(40.)), MouseButton::Left, cx);
        w.press(
            if cfg!(target_os = "macos") {
                "cmd-s"
            } else {
                "ctrl-s"
            },
            cx,
        );
    })
    .unwrap();
    assert!(cx.update(document_editor::flush_all) == document_editor::FlushState::Waiting);
    let mut closed = false;
    for _ in 0..400 {
        cx.run_until_parked();
        if cx.update_window(window, |_, _, _| ()).is_err() {
            closed = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(closed, "close must wait for save then finish");
    let after = snapshot(&backend, doc.id());
    assert_eq!(after.revision(), before.revision() + 1);
    assert_eq!(after.resources().len(), 2);
}
