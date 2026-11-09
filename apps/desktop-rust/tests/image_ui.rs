#![cfg(feature = "ui-tests")]
use anynote_core::{backend::*, document_session::*, image::*};
use anynote_desktop::{
    backend_session::BackendSession,
    document_editor::{self, DocumentEditor},
};
use core::prelude::v1::test;
use gpui_kit::{
    test::{TestEventExt, TestQueryExt, TestWindowExt},
    *,
};
use std::time::Duration;
use uuid::Uuid;
#[path = "support/media_ui.rs"]
mod media_ui;
use media_ui::{Backend, click_label, reply, spin};
#[gpui_kit::test]
fn paste_width_reader_rotate_version_and_close_use_production_controls(cx: &mut TestAppContext) {
    cx.background_executor.allow_parking();
    let backend = Backend::new();
    let Reply::Document(snapshot) = reply(&backend.client, Command::CreateDocument) else {
        panic!()
    };
    cx.update(|cx| {
        gpui_kit::init(cx);
        document_editor::install_actions(cx);
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
            |w, cx| cx.new(|cx| DocumentEditor::from_snapshot(snapshot.clone(), w, cx)),
        )
        .unwrap()
    });
    let mut bytes = std::io::Cursor::new(vec![]);
    image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        120,
        80,
        image::Rgba([255, 50, 80, 255]),
    ))
    .write_to(&mut bytes, image::ImageFormat::Png)
    .unwrap();
    let original = bytes.into_inner();
    cx.update_window(window, |_, w, cx| {
        w.render_frame(cx);
        cx.write_to_clipboard(ClipboardItem::new_image(&Image::from_bytes(
            ImageFormat::Png,
            original.clone(),
        )));
        editor.focus_handle(cx).focus(w, cx);
        w.press(
            if cfg!(target_os = "macos") {
                "cmd-v"
            } else {
                "ctrl-v"
            },
            cx,
        );
    })
    .unwrap();
    spin(cx, window, |w, _| {
        w.try_find_by_label("查看图片")
            .is_some_and(|b| b.disabled() != Some(true))
    });
    let source = cx.update(|cx| editor.read(cx).source().to_owned());
    assert!(anynote_editor::image::parse(source.trim()).is_some());
    cx.update_window(window, |_, w, cx| {
        click_label(w, "显示宽度…", cx);
        w.click("image-width-input", cx);
        w.input("320", cx);
        w.click("apply-image-width", cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(window, |_, w, cx| w.click("save-document", cx))
        .unwrap();
    cx.update(|cx| assert!(editor.read(cx).source().contains("\"width\":320")));
    spin(
        cx,
        window,
        |_, cx| matches!(reply(&backend.client,Command::OpenDocument{id:snapshot.id().clone()}),Reply::Document(d) if d.content().body()==editor.read(cx).source()),
    );
    let Reply::Document(before) = reply(
        &backend.client,
        Command::OpenDocument {
            id: snapshot.id().clone(),
        },
    ) else {
        panic!()
    };
    cx.update_window(window, |_, w, cx| click_label(w, "查看图片", cx))
        .unwrap();
    spin(cx, window, |w, _| w.try_find("image-metadata").is_some());
    cx.update_window(window, |_, w, cx| {
        assert!(
            w.find("image-metadata")
                .label()
                .unwrap()
                .contains("120 × 80")
        );
        assert_eq!(w.find("image-save-version").disabled(), Some(true));
        w.click("image-zoom-in", cx);
        w.click("image-actual", cx);
        w.click("image-fit", cx);
        w.click("image-mark", cx);
        let center = w.find("image-canvas").bounds().center();
        w.pointer_down(center - point(px(20.), px(10.)), MouseButton::Left, cx);
        w.pointer_move(
            center + point(px(20.), px(10.)),
            Some(MouseButton::Left),
            cx,
        );
        w.pointer_up(center + point(px(20.), px(10.)), MouseButton::Left, cx);
        assert_ne!(w.find("image-annotate").disabled(), Some(true));
        w.click("image-annotate", cx);
        w.click("image-annotation-input", cx);
        w.input("区域批注", cx);
        w.click("confirm-image-annotation", cx);
    })
    .unwrap();
    spin(cx, window, |w, _| w.try_find_by_label("删除批注").is_some());
    let resource = *before.resources().keys().next().unwrap();
    let scope = ImageScope {
        document: before.id().clone(),
        revision: before.head(),
        resource,
    };
    let Reply::Image(ImageReply::Annotations { annotations }) = reply(
        &backend.client,
        Command::Image(ImageCommand::Annotations { scope }),
    ) else {
        panic!()
    };
    assert_eq!(annotations.len(), 1);
    assert!(annotations[0].rectangles[0].is_valid());
    cx.update_window(window, |_, w, cx| {
        w.click("image-copy", cx);
        w.click("image-rotate", cx);
    })
    .unwrap();
    assert_eq!(
        cx.read_from_clipboard()
            .unwrap()
            .entries()
            .iter()
            .find_map(|e| if let ClipboardEntry::Image(i) = e {
                Some(i.bytes().to_vec())
            } else {
                None
            })
            .unwrap(),
        original
    );
    spin(cx, window, |w, _| {
        w.try_find("image-metadata")
            .and_then(|b| b.label().map(|s| s.contains("90°")))
            .unwrap_or(false)
    });
    let export = backend.root.join("original.png");
    cx.update_window(window, |_, w, cx| w.click("image-export", cx))
        .unwrap();
    cx.run_until_parked();
    cx.simulate_new_path_selection(|_| Some(export.clone()));
    spin(cx, window, |w, _| {
        export.exists() && w.find("image-save-version").disabled() != Some(true)
    });
    assert_eq!(std::fs::read(&export).unwrap(), original);
    cx.update_window(window, |_, w, cx| w.click("image-save-version", cx))
        .unwrap();
    spin(cx, window, |w, _| {
        w.try_find("image-metadata")
            .and_then(|b| b.label().map(|s| s.contains("80 × 120")))
            .unwrap_or(false)
    });
    cx.update_window(window, |_, w, cx| w.click("image-history", cx))
        .unwrap();
    spin(cx, window, |w, _| {
        w.try_find(before.head().to_string()).is_some()
    });
    cx.update_window(window, |_, w, cx| w.click(before.head().to_string(), cx))
        .unwrap();
    spin(cx, window, |w, _| {
        w.try_find("image-metadata")
            .and_then(|b| b.label().map(|s| s.contains("120 × 80")))
            .unwrap_or(false)
    });
    cx.update_window(window, |_, w, cx| {
        assert_eq!(w.find("image-mark").disabled(), Some(true));
        w.click("image-current", cx);
    })
    .unwrap();
    spin(cx, window, |w, _| {
        w.try_find("image-metadata")
            .and_then(|b| b.label().map(|s| s.contains("80 × 120")))
            .unwrap_or(false)
    });
    cx.update_window(window, |_, w, cx| {
        w.click("close-image-reader", cx);
        assert!(w.try_find("image-rotate").is_none());
    })
    .unwrap();
    let Reply::Document(saved) = reply(
        &backend.client,
        Command::OpenDocument {
            id: snapshot.id().clone(),
        },
    ) else {
        panic!()
    };
    assert!(saved.revision() >= 4);
    let remote_body = format!("remote edit\n\n{}", saved.content().body());
    let Reply::DocumentSaved(_) = reply(
        &backend.client,
        Command::SaveDocument(SaveDocument::new(
            Uuid::new_v4(),
            99,
            DocumentSnapshot::new(
                saved.id().clone(),
                saved.revision(),
                saved.head(),
                saved.content().with_body(remote_body.clone()),
            ),
        )),
    ) else {
        panic!()
    };
    cx.update_window(window, |_, w, cx| {
        click_label(w, "显示宽度…", cx);
        w.click("image-width-input", cx);
        w.press(
            if cfg!(target_os = "macos") {
                "cmd-a"
            } else {
                "ctrl-a"
            },
            cx,
        );
        w.input("512", cx);
        w.click("apply-image-width", cx);
        w.click("save-document", cx);
    })
    .unwrap();
    spin(cx, window, |w, _| {
        w.try_find("save-conflict-copy").is_some()
    });
    cx.update_window(window, |_, w, cx| w.click("save-conflict-copy", cx))
        .unwrap();
    spin(
        cx,
        window,
        |_, cx| matches!(reply(&backend.client,Command::OpenLastDocument),Reply::Document(d) if d.id()!=saved.id() && d.revision()>1 && d.content().body()==editor.read(cx).source()),
    );
    let Reply::Document(copy) = reply(&backend.client, Command::OpenLastDocument) else {
        panic!()
    };
    assert_eq!(copy.resources(), saved.resources());
    assert!(copy.content().body().contains("\"width\":512"));
    let Reply::Document(remote) = reply(
        &backend.client,
        Command::OpenDocument {
            id: saved.id().clone(),
        },
    ) else {
        panic!()
    };
    assert_eq!(remote.content().body(), remote_body);

    cx.update_window(window, |_, w, _| w.remove_window())
        .unwrap();
}

#[gpui_kit::test]
fn file_selection_external_drop_and_cancel_use_production_import(cx: &mut TestAppContext) {
    cx.background_executor.allow_parking();
    let backend = Backend::new();
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
    let file = backend.root.join("drop.svg");
    std::fs::write(&file,br#"<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="red"/></svg>"#).unwrap();
    cx.update_window(window, |_, w, cx| {
        w.click("insert-content", cx);
        click_label(w, "图片…", cx);
    })
    .unwrap();
    cx.run_until_parked();
    assert!(cx.did_prompt_for_paths());
    cx.simulate_path_prompt_response(|options| {
        assert!(options.multiple);
        Some(vec![file.clone()])
    });
    spin(cx, window, |w, _| {
        w.try_find_by_label("查看图片")
            .is_some_and(|b| b.disabled() != Some(true))
    });
    let first = cx.update(|cx| editor.read(cx).source().to_owned());
    cx.update_window(window, |_, w, cx| {
        let position = point(px(100.), px(240.));
        w.dispatch_event(
            PlatformInput::FileDrop(FileDropEvent::Entered {
                position,
                paths: ExternalPaths(vec![file.clone()].into()),
            }),
            cx,
        );
        w.render_frame(cx);
        w.dispatch_event(
            PlatformInput::FileDrop(FileDropEvent::Submit { position }),
            cx,
        );
    })
    .unwrap();
    spin(cx, window, |_, cx| {
        editor
            .read(cx)
            .source()
            .matches("anynote-resource:")
            .count()
            == 2
    });
    spin(
        cx,
        window,
        |_, cx| matches!(reply(&backend.client,Command::OpenDocument{id:snapshot.id().clone()}),Reply::Document(d) if d.content().body()==editor.read(cx).source()),
    );
    assert!(cx.update(|cx| editor.read(cx).source().contains(first.trim())));
    cx.update_window(window, |_, w, cx| {
        w.click("insert-content", cx);
        click_label(w, "图片…", cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.simulate_path_prompt_response(|_| None);
    cx.run_until_parked();
    assert_eq!(
        cx.update(|cx| editor
            .read(cx)
            .source()
            .matches("anynote-resource:")
            .count()),
        2
    );
    cx.update_window(window, |_, w, cx| {
        click_label(w, "查看图片", cx);
        w.click("close-image-reader", cx);
    })
    .unwrap();
    for _ in 0..20 {
        cx.run_until_parked();
        std::thread::sleep(Duration::from_millis(5));
    }
    cx.update_window(window, |_, w, cx| {
        w.render_frame(cx);
        assert!(w.try_find("image-rotate").is_none());
        w.remove_window();
    })
    .unwrap();
}
