#![cfg(feature = "ui-tests")]
use anynote_core::{backend::*, workspace::*};
use anynote_desktop::{backend_session::BackendSession, workspace::Workspace};
use gpui_kit::{
    AppContext, Bounds, TestAppContext, WindowBounds, WindowOptions, px, size,
    test::{TestQueryExt, TestWindowExt},
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
fn notebook_create_read_search_history_theme_and_dialog_focus(cx: &mut TestAppContext) {
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
        assert_eq!(cx.windows().len(), 1);
        let content = w.find("document-content").bounds();
        assert!(
            content.left()
                >= w.find(format!("open-{}", entries[0].id.note()))
                    .bounds()
                    .right()
        );
        assert!(content.size.height > px(300.));
        w.click("document-content", cx);
        w.input("A", cx);
        w.press(
            if cfg!(target_os = "macos") {
                "cmd-z"
            } else {
                "ctrl-z"
            },
            cx,
        );
        w.press(
            if cfg!(target_os = "macos") {
                "cmd-shift-z"
            } else {
                "ctrl-shift-z"
            },
            cx,
        );
        w.click("workspace-history", cx);
    })
    .unwrap();
    let id = entries[0].id.clone();
    spin(cx, window, |_, _| {
        matches!(reply(&backend.client, Command::OpenDocument { id: id.clone() }), Reply::Document(saved)
            if markdown::to_html(saved.content().body()) == "<p>A</p>")
    });
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
        assert!(w.try_find("document-content").is_none());
        w.click("workspace-current-revision", cx);
        w.render_frame(cx);
        assert!(w.try_find("document-content").is_some());
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
    cx.update_window(window, |_, w, cx| {
        w.click("document-content", cx);
        w.press("end", cx);
        w.input("Z", cx);
        w.press(
            if cfg!(target_os = "macos") {
                "cmd-w"
            } else {
                "ctrl-w"
            },
            cx,
        );
    })
    .unwrap();
    for _ in 0..400 {
        cx.executor()
            .advance_clock(std::time::Duration::from_millis(50));
        cx.run_until_parked();
        if cx.update(|cx| cx.windows().is_empty()) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    cx.update(|cx| assert!(cx.windows().is_empty()));
    let Reply::Document(saved) = reply(&backend.client, Command::OpenDocument { id }) else {
        panic!()
    };
    assert_eq!(markdown::to_html(saved.content().body()), "<p>AZ</p>");
}
#[gpui_kit::test]
fn switching_notebook_saves_draft_and_restores_selection(cx: &mut TestAppContext) {
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
    let WorkspaceReply::Book(target) = workspace_reply(
        &backend,
        WorkspaceCommand::CreateBook {
            title: "另一个笔记本".into(),
        },
    ) else {
        panic!()
    };
    let mut preferences = Preferences::default();
    preferences.active_book = Some(book.id);
    workspace_reply(&backend, WorkspaceCommand::SetPreferences(preferences));
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
    spin(cx, window, |w, _| {
        w.try_find("workspace-notebooks").is_some_and(|b| {
            b.disabled() != Some(true) && b.label() == Some("切换笔记本：保存测试")
        })
    });
    cx.update_window(window, |_, w, cx| {
        w.click(format!("open-{}", node.id.note()), cx)
    })
    .unwrap();
    spin(cx, window, |w, _| {
        w.try_find("document-content").is_some()
            && w.find("workspace-edit").disabled() != Some(true)
    });
    let expected = "切库前保存的草稿";
    cx.update_window(window, |_, w, cx| {
        assert_eq!(cx.windows().len(), 1);
        assert!(
            w.find("document-content").bounds().size.height > px(100.),
            "{:?}",
            w.find("document-content")
        );
        w.click("document-content", cx);
        assert_eq!(w.find("document-content").focused(), Some(true));
        w.input(expected, cx);
    })
    .unwrap();
    cx.update_window(window, |_, w, cx| {
        w.click("workspace-notebooks", cx);
        w.render_frame(cx);
        click_label(w, "另一个笔记本", cx);
    })
    .unwrap();
    spin(cx, window, |w, _| {
        w.try_find("workspace-notebooks").is_some_and(|b| {
            b.disabled() != Some(true) && b.label() == Some("切换笔记本：另一个笔记本")
        })
    });
    let Reply::Document(saved) = reply(&backend.client, Command::OpenDocument { id: node.id })
    else {
        panic!()
    };
    assert_eq!(
        markdown::to_html(saved.content().body()),
        format!("<p>{expected}</p>")
    );
    cx.update_window(window, |_, w, _| w.remove_window())
        .unwrap();
    let WorkspaceReply::Preferences(preferences) =
        workspace_reply(&backend, WorkspaceCommand::Preferences)
    else {
        panic!()
    };
    assert_eq!(preferences.active_book, Some(target.id));
    let (reopened, _) = cx.update(|cx| {
        gpui_kit::open_window(WindowOptions::default(), cx, |w, cx| {
            cx.new(|cx| Workspace::new(w, cx))
        })
        .unwrap()
    });
    spin(cx, reopened, |w, _| {
        w.try_find("workspace-notebooks").is_some_and(|b| {
            b.disabled() != Some(true) && b.label() == Some("切换笔记本：另一个笔记本")
        })
    });
    let WorkspaceReply::Books(books) = workspace_reply(&backend, WorkspaceCommand::Books) else {
        panic!()
    };
    let expected_book = &books[0];
    cx.update_window(reopened, |_, w, cx| {
        w.click("workspace-notebooks", cx);
        w.press("escape", cx);
        assert_eq!(w.find("workspace-notebooks").focused(), Some(true));
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(reopened, |_, w, cx| w.press("space", cx))
        .unwrap();
    spin(cx, reopened, |w, _| {
        w.try_find_by_label(&expected_book.title).is_some()
    });
    cx.update_window(reopened, |_, w, cx| {
        w.press("down", cx);
        w.press("enter", cx);
    })
    .unwrap();
    spin(cx, reopened, |w, _| {
        let button = w.find("workspace-notebooks");
        button.disabled() != Some(true)
            && button.label() == Some(format!("切换笔记本：{}", expected_book.title).as_str())
    });
    cx.update_window(reopened, |_, w, _| w.remove_window())
        .unwrap();
}

#[gpui_kit::test]
fn inline_navigation_saves_notes_and_keeps_conflicted_draft_open(cx: &mut TestAppContext) {
    cx.background_executor.allow_parking();
    let backend = Backend::new();
    let WorkspaceReply::Book(book) = workspace_reply(
        &backend,
        WorkspaceCommand::CreateBook {
            title: "内嵌编辑".into(),
        },
    ) else {
        panic!()
    };
    let notes = ["第一篇", "第二篇"].map(|title| {
        let WorkspaceReply::Node(node) = workspace_reply(
            &backend,
            WorkspaceCommand::CreateNode {
                book: book.id,
                parent: None,
                title: title.into(),
                folder: false,
            },
        ) else {
            panic!()
        };
        node
    });
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
    let first = format!("open-{}", notes[0].id.note());
    let second = format!("open-{}", notes[1].id.note());
    spin(cx, window, |w, _| {
        w.try_find(first.clone()).is_some()
            && w.find("workspace-notebooks").disabled() != Some(true)
    });
    cx.update_window(window, |_, w, cx| w.click(first.clone(), cx))
        .unwrap();
    spin(cx, window, |w, _| {
        w.try_find("document-content").is_some()
            && w.find("workspace-edit").disabled() != Some(true)
    });
    cx.update_window(window, |_, w, cx| {
        w.click("document-content", cx);
        w.input("A", cx);
        w.click(second.clone(), cx);
    })
    .unwrap();
    spin(cx, window, |w, _| {
        w.try_find("document-content").is_some()
            && w.find("workspace-edit").disabled() != Some(true)
    });
    let Reply::Document(saved) = reply(
        &backend.client,
        Command::OpenDocument {
            id: notes[0].id.clone(),
        },
    ) else {
        panic!()
    };
    assert_eq!(markdown::to_html(saved.content().body()), "<p>A</p>");
    cx.update_window(window, |_, w, cx| {
        assert_eq!(cx.windows().len(), 1);
        w.click("document-content", cx);
        w.input("B", cx);
        w.dispatch_action(Box::new(anynote_desktop::workspace::CloseNote), cx);
    })
    .unwrap();
    spin(cx, window, |w, _| {
        w.try_find("document-content").is_none()
            && w.try_find("workspace-edit").is_none()
            && w.find("workspace-notebooks").disabled() != Some(true)
    });
    let Reply::Document(saved_second) = reply(
        &backend.client,
        Command::OpenDocument {
            id: notes[1].id.clone(),
        },
    ) else {
        panic!()
    };
    assert_eq!(markdown::to_html(saved_second.content().body()), "<p>B</p>");
    cx.update_window(window, |_, w, cx| w.click(first.clone(), cx))
        .unwrap();
    spin(cx, window, |w, _| {
        w.try_find("document-content").is_some()
            && w.find("workspace-edit").disabled() != Some(true)
    });
    cx.update_window(window, |_, w, cx| {
        assert_eq!(w.find_all("document-content").len(), 1);
        w.click("workspace-edit", cx);
    })
    .unwrap();
    spin(cx, window, |w, _| {
        w.find("workspace-edit").label() == Some("编辑")
            && w.find("workspace-edit").disabled() != Some(true)
    });
    cx.update_window(window, |_, w, cx| {
        assert!(w.try_find("document-content").is_none());
        w.click("workspace-edit", cx);
        w.click("document-content", cx);
        w.press("end", cx);
        w.input(" draft", cx);
    })
    .unwrap();
    workspace_reply(
        &backend,
        WorkspaceCommand::Patch {
            id: notes[0].id.clone(),
            expected: saved.revision(),
            title: Some("远端修改".into()),
            tags: None,
            favorite: None,
        },
    );
    cx.update_window(window, |_, w, cx| {
        w.dispatch_action(Box::new(anynote_desktop::shell::CloseWindow), cx);
    })
    .unwrap();
    spin(cx, window, |w, _| {
        w.try_find("save-conflict-copy").is_some()
            && w.find("workspace-edit").disabled() != Some(true)
    });
    cx.update_window(window, |_, w, cx| {
        assert_eq!(cx.windows().len(), 1);
        w.click("copy-draft", cx);
        let draft = cx.read_from_clipboard().unwrap().text().unwrap();
        assert_eq!(markdown::to_html(&draft), "<p>A draft</p>");
        w.remove_window();
    })
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
    let note_id = format!("node-{}", note.id.note());
    let folder_id = format!("node-{}", folder.id.note());
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
