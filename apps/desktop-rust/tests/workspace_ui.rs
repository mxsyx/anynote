#![cfg(feature = "ui-tests")]
use anynote_core::{backend::*, workspace::*};
use anynote_desktop::{backend_session::BackendSession, workspace::Workspace};
use gpui_kit::{
    AppContext, Bounds, TestAppContext, WindowBounds, WindowOptions, px, size, test::TestWindowExt,
};
#[path = "support/media_ui.rs"]
mod support;
use support::{Backend, click_label, reply};
fn workspace_reply(backend: &Backend, command: WorkspaceCommand) -> WorkspaceReply {
    let Reply::Workspace(reply) = reply(&backend.client, Command::Workspace(command)) else {
        panic!()
    };
    reply
}
#[gpui_kit::test]
fn bookshelf_create_read_search_history_theme_and_dialog_focus(cx: &mut TestAppContext) {
    cx.background_executor.allow_parking();
    let backend = Backend::new();
    cx.update(|cx| {
        gpui_kit::init(cx);
        anynote_desktop::shell::install_actions(cx);
        BackendSession::install(backend.client.clone(), cx);
    });
    let (window, _view) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(1200.), px(800.)),
                ))),
                ..Default::default()
            },
            cx,
            |w, cx| cx.new(|cx| Workspace::new(w, cx)),
        )
        .unwrap()
    });
    support::spin(cx, window, |w, _| {
        w.try_find("workspace-create-book")
            .is_some_and(|b| b.disabled() != Some(true))
    });
    cx.update_window(window, |_, w, cx| {
        w.click("workspace-create-book", cx);
        w.render_frame(cx);
        click_label(w, "新建笔记本", cx);
        w.input("研究笔记", cx);
        w.click("workspace-name-submit", cx);
    })
    .unwrap();
    spin(cx, window, |w, _| {
        w.try_find("workspace-new-note")
            .is_some_and(|b| b.disabled() != Some(true))
    });
    let WorkspaceReply::Books(books) = workspace_reply(&backend, WorkspaceCommand::Books) else {
        panic!()
    };
    assert_eq!(books.len(), 1);
    assert_eq!(books[0].title, "研究笔记");
    cx.update_window(window, |_, w, cx| {
        w.click("workspace-new-note", cx);
        w.render_frame(cx);
        click_label(w, "新建笔记", cx);
        w.input("第一篇笔记", cx);
        w.click("workspace-name-submit", cx);
    })
    .unwrap();
    spin(cx, window, |w, _| {
        w.try_find("workspace-edit")
            .is_some_and(|b| b.disabled() != Some(true))
    });
    let WorkspaceReply::Nodes { entries, .. } = workspace_reply(
        &backend,
        WorkspaceCommand::Nodes {
            book: books[0].id,
            trash: false,
            offset: 0,
        },
    ) else {
        panic!()
    };
    assert_eq!(entries.len(), 1);
    cx.update_window(window, |_, w, cx| {
        w.click("workspace-history", cx);
    })
    .unwrap();
    let id = entries[0].id.clone();
    let Reply::Document(snapshot) =
        reply(&backend.client, Command::OpenDocument { id: id.clone() })
    else {
        panic!()
    };
    let revision = format!("revision-{}", snapshot.head());
    spin(cx, window, |w, _| w.try_find(revision.clone()).is_some());
    cx.update_window(window, |_, w, cx| {
        w.click(revision.clone(), cx);
    })
    .unwrap();
    spin(cx, window, |w, _| {
        w.try_find("workspace-restore-revision").is_some()
    });
    cx.update_window(window, |_, w, cx| {
        w.click("workspace-current-revision", cx);
        w.click("workspace-search", cx);
        w.render_frame(cx);
        w.input("第一篇", cx);
    })
    .unwrap();
    let hit = format!("hit-{}-{}", id.notebook(), id.note());
    spin(cx, window, |w, _| w.try_find(hit.clone()).is_some());
    cx.update_window(window, |_, w, cx| {
        w.click(hit.clone(), cx);
    })
    .unwrap();
    spin(cx, window, |w, _| {
        w.try_find("workspace-edit")
            .is_some_and(|b| b.disabled() != Some(true))
    });
    cx.update_window(window, |_, w, cx| {
        w.click("workspace-settings", cx);
        w.render_frame(cx);
        w.click("dark", cx);
        w.render_frame(cx);
        w.press("escape", cx);
        w.render_frame(cx);
        assert!(w.try_find("workspace-zoom").is_none());
    })
    .unwrap();
    spin(
        cx,
        window,
        |_, _| matches!(workspace_reply(&backend,WorkspaceCommand::Preferences),WorkspaceReply::Preferences(prefs) if prefs.theme=="dark"),
    );
    cx.update_window(window, |_, w, _| w.remove_window())
        .unwrap();
}
#[gpui_kit::test]
fn switching_library_waits_for_real_editor_save(cx: &mut TestAppContext) {
    cx.background_executor.allow_parking();
    let backend = Backend::new();
    let WorkspaceReply::Book(book) = workspace_reply(
        &backend,
        WorkspaceCommand::CreateBook {
            title: "保存测试".into(),
        },
    ) else {
        panic!()
    };
    let WorkspaceReply::Node(node) = workspace_reply(
        &backend,
        WorkspaceCommand::CreateNode {
            book: book.id,
            parent: None,
            title: "原文".into(),
            folder: false,
        },
    ) else {
        panic!()
    };
    let Reply::Document(snapshot) = reply(
        &backend.client,
        Command::OpenDocument {
            id: node.id.clone(),
        },
    ) else {
        panic!()
    };
    cx.update(|cx| {
        gpui_kit::init(cx);
        anynote_desktop::shell::install_actions(cx);
        BackendSession::install(backend.client.clone(), cx);
    });
    let (window, _) = cx.update(|cx| {
        gpui_kit::open_window(WindowOptions::default(), cx, |w, cx| {
            cx.new(|cx| Workspace::new(w, cx))
        })
        .unwrap()
    });
    let book_id = format!("book-{}", book.id);
    spin(cx, window, |w, _| {
        w.try_find(book_id.clone())
            .is_some_and(|b| b.disabled() != Some(true))
    });
    cx.update_window(window, |_, w, cx| w.click(book_id.clone(), cx))
        .unwrap();
    spin(cx, window, |w, _| {
        w.try_find("workspace-books")
            .is_some_and(|b| b.disabled() != Some(true))
    });
    let (editor_window, editor) = cx.update(|cx| {
        gpui_kit::open_window(WindowOptions::default(), cx, |w, cx| {
            cx.new(|cx| {
                anynote_desktop::document_editor::DocumentEditor::from_snapshot(snapshot, w, cx)
            })
        })
        .unwrap()
    });
    let expected = cx
        .update_window(editor_window, |_, w, cx| {
            use gpui_kit::Focusable;
            w.render_frame(cx);
            editor.focus_handle(cx).focus(w, cx);
            w.render_frame(cx);
            w.input("切库前保存的草稿", cx);
            editor.read(cx).source().to_owned()
        })
        .unwrap();
    cx.update_window(window, |_, w, cx| w.click("workspace-books", cx))
        .unwrap();
    spin(cx, window, |w, _| w.try_find(book_id.clone()).is_some());
    let Reply::Document(saved) = reply(&backend.client, Command::OpenDocument { id: node.id })
    else {
        panic!()
    };
    assert_eq!(saved.content().body(), expected);
    cx.update_window(editor_window, |_, w, _| w.remove_window())
        .unwrap();
    cx.update_window(window, |_, w, _| w.remove_window())
        .unwrap();
}

#[track_caller]
fn spin(
    cx: &mut TestAppContext,
    window: gpui_kit::AnyWindowHandle,
    condition: impl Fn(&mut gpui_kit::Window, &mut gpui_kit::App) -> bool,
) {
    let mut status = None;
    for _ in 0..400 {
        cx.executor()
            .advance_clock(std::time::Duration::from_millis(50));
        cx.run_until_parked();
        if cx
            .update_window(window, |_, w, cx| {
                w.render_frame(cx);
                status = w
                    .try_find("workspace-status")
                    .and_then(|v| v.label().map(str::to_owned));
                condition(w, cx)
            })
            .unwrap()
        {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    panic!("workspace did not settle: {status:?}");
}

#[gpui_kit::test]
fn directory_drag_updates_real_parent_and_keyboard_remains_operable(cx: &mut TestAppContext) {
    cx.background_executor.allow_parking();
    let backend = Backend::new();
    let WorkspaceReply::Book(book) = workspace_reply(
        &backend,
        WorkspaceCommand::CreateBook {
            title: "目录".into(),
        },
    ) else {
        panic!()
    };
    let WorkspaceReply::Node(folder) = workspace_reply(
        &backend,
        WorkspaceCommand::CreateNode {
            book: book.id,
            parent: None,
            title: "文件夹".into(),
            folder: true,
        },
    ) else {
        panic!()
    };
    let WorkspaceReply::Node(note) = workspace_reply(
        &backend,
        WorkspaceCommand::CreateNode {
            book: book.id,
            parent: None,
            title: "拖动笔记".into(),
            folder: false,
        },
    ) else {
        panic!()
    };
    cx.update(|cx| {
        gpui_kit::init(cx);
        anynote_desktop::shell::install_actions(cx);
        BackendSession::install(backend.client.clone(), cx);
    });
    let (window, _) = cx.update(|cx| {
        gpui_kit::open_window(WindowOptions::default(), cx, |w, cx| {
            cx.new(|cx| Workspace::new(w, cx))
        })
        .unwrap()
    });
    let book_id = format!("book-{}", book.id);
    let note_id = format!("node-{}", note.id.note());
    let folder_id = format!("node-{}", folder.id.note());
    spin(cx, window, |w, _| {
        w.try_find(book_id.clone())
            .is_some_and(|b| b.disabled() != Some(true))
    });
    cx.update_window(window, |_, w, cx| w.click(book_id.clone(), cx))
        .unwrap();
    spin(cx, window, |w, _| w.try_find(note_id.clone()).is_some());
    cx.update_window(window, |_, w, cx| {
        w.drag_to(note_id.clone(), folder_id.clone(), cx)
    })
    .unwrap();
    spin(
        cx,
        window,
        |_, _| matches!(workspace_reply(&backend,WorkspaceCommand::Nodes{book:book.id,trash:false,offset:0}),WorkspaceReply::Nodes{entries,..} if entries.iter().any(|n|n.id==note.id&&n.parent==Some(folder.id.note()))),
    );
    cx.update_window(window, |_, w, _| w.remove_window())
        .unwrap();
}
