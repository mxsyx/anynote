#![cfg(all(feature = "ui-tests", feature = "media"))]
use anynote_core::{backend::*, document_session::*, image::*};
use anynote_desktop::{
    board::{self, BoardView},
    document_editor::{self, DocumentEditor},
    image::ImageView,
    pdf::PdfView,
};
use anynote_editor::board::Scene;
use core::prelude::v1::test;
use gpui_kit::{
    component::{Theme, ThemeMode},
    test::{TestEventExt, TestWindowExt},
    *,
};
use uuid::Uuid;
#[path = "support/pdf_backend.rs"]
mod pdf_support;
#[path = "support/media_ui.rs"]
mod support;

#[gpui_kit::test]
fn hundred_document_board_image_cycles_release_entities(cx: &mut TestAppContext) {
    cx.background_executor.allow_parking();
    let backend = support::Backend::new();
    let Reply::Document(document) = support::reply(&backend.client, Command::CreateDocument) else {
        panic!()
    };
    let resource = Uuid::new_v4();
    let mut encoded = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        120,
        80,
        image::Rgba([255, 50, 80, 255]),
    ))
    .write_to(&mut encoded, image::ImageFormat::Png)
    .unwrap();
    support::reply(
        &backend.client,
        Command::Image(ImageCommand::Upload {
            document: document.id().clone(),
            resource,
            name: "pixel.png".into(),
            offset: 0,
            bytes: encoded.into_inner(),
            complete: true,
        }),
    );
    let Reply::DocumentSaved(saved) = support::reply(
        &backend.client,
        Command::SaveDocument(
            SaveDocument::new(
                Uuid::new_v4(),
                1,
                DocumentSnapshot::new(
                    document.id().clone(),
                    document.revision(),
                    document.head(),
                    document.content().with_body(
                        anynote_editor::image::markdown(&resource.to_string(), "image").unwrap(),
                    ),
                ),
            )
            .with_resources(vec![resource]),
        ),
    ) else {
        panic!()
    };
    let scope = ImageScope {
        document: document.id().clone(),
        revision: saved.snapshot().head(),
        resource,
    };
    cx.update(|cx| {
        gpui_kit::init(cx);
        document_editor::install_actions(cx);
        board::install_actions(cx);
    });
    for cycle in 0..100 {
        let (window, view) = cx.update(|cx| {
            gpui_kit::open_window(window_options(), cx, |w, cx| {
                cx.new(|cx| DocumentEditor::new(format!("cycle {cycle}"), w, cx))
            })
            .unwrap()
        });
        cx.update_window(window, |_, w, cx| {
            w.render_frame(cx);
            view.focus_handle(cx).focus(w, cx);
            w.render_frame(cx);
            w.input("x", cx);
            assert!(
                view.read(cx).text().contains('x'),
                "cycle={cycle}, focused={}, source={:?}, viewport={:?}",
                view.focus_handle(cx).is_focused(w),
                view.read(cx).source(),
                w.viewport_size()
            );
            w.remove_window();
        })
        .unwrap();
        let document_weak = view.downgrade();
        drop(view);
        let (window, view) = cx.update(|cx| {
            gpui_kit::open_window(window_options(), cx, |w, cx| {
                cx.new(|cx| {
                    BoardView::new(
                        Scene::parse("{\"elements\":[],\"files\":{},\"appState\":{}}").unwrap(),
                        w,
                        cx,
                    )
                })
            })
            .unwrap()
        });
        cx.update_window(window, |_, w, cx| {
            w.render_frame(cx);
            w.click("board-rectangle", cx);
            assert!(w.find("board-canvas").visible());
            let at = w.find("board-canvas").bounds().origin + point(px(80.), px(80.));
            w.pointer_down(at, MouseButton::Left, cx);
            w.pointer_move(at + point(px(60.), px(40.)), Some(MouseButton::Left), cx);
            w.pointer_up(at + point(px(60.), px(40.)), MouseButton::Left, cx);
            assert_eq!(view.read(cx).scene().elements().len(), 1);
            Theme::change(
                if cycle % 2 == 0 {
                    ThemeMode::Dark
                } else {
                    ThemeMode::Light
                },
                Some(w),
                cx,
            );
            w.render_frame(cx);
            w.remove_window();
        })
        .unwrap();
        let board_weak = view.downgrade();
        drop(view);
        let (window, view) = cx.update(|cx| {
            gpui_kit::open_window(window_options(), cx, |w, cx| {
                cx.new(|cx| {
                    ImageView::new(
                        scope.clone(),
                        backend.client.clone(),
                        false,
                        "fixture".into(),
                        w,
                        cx,
                    )
                })
            })
            .unwrap()
        });
        support::spin(cx, window, |_, cx| view.read(cx).dimensions().is_some());
        cx.simulate_window_resize(window, size(px(900.), px(700.)));
        cx.update_window(window, |_, w, cx| {
            w.click("image-zoom-in", cx);
            support::click_label(w, "实际尺寸", cx);
            w.click("image-fit", cx);
            view.update(cx, |v, cx| v.close(w, cx));
            w.remove_window();
        })
        .unwrap();
        let image_weak = view.downgrade();
        drop(view);
        cx.run_until_parked();
        assert!(
            document_weak.upgrade().is_none(),
            "document retained at cycle {cycle}"
        );
        assert!(
            board_weak.upgrade().is_none(),
            "board retained at cycle {cycle}"
        );
        assert!(
            image_weak.upgrade().is_none(),
            "image retained at cycle {cycle}"
        );
        cx.update(|cx| assert!(cx.windows().is_empty(), "window retained at cycle {cycle}"));
    }
    assert!(matches!(
        support::reply(&backend.client, Command::Ping),
        Reply::Pong
    ));
}

#[gpui_kit::test]
fn hundred_pdf_cancelled_page_cycles_release_entities(cx: &mut TestAppContext) {
    cx.background_executor.allow_parking();
    let pdf = pdf_support::PdfBackend::new("geometry.pdf");
    cx.update(gpui_kit::init);
    for cycle in 0..100 {
        let (window, view) = cx.update(|cx| {
            gpui_kit::open_window(window_options(), cx, |w, cx| {
                cx.new(|cx| PdfView::new(pdf.scope.clone(), pdf.client.clone(), w, cx))
            })
            .unwrap()
        });
        eprintln!("cycle {cycle}: loading PDF");
        support::spin(cx, window, |_, cx| view.read(cx).raster().is_some());
        cx.update_window(window, |_, w, cx| {
            w.click("pdf-next", cx);
            view.update(cx, |v, cx| v.close(w, cx));
            assert_eq!(view.read(cx).cached_texture_count(), 0);
            w.remove_window();
        })
        .unwrap();
        let pdf_weak = view.downgrade();
        drop(view);
        cx.run_until_parked();
        assert!(
            pdf_weak.upgrade().is_none(),
            "PDF retained at cycle {cycle}"
        );
        cx.update(|cx| assert!(cx.windows().is_empty()));
    }
    assert!(matches!(pdf.reply(Command::Ping), Reply::Pong));
}

fn window_options() -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
            Default::default(),
            size(px(1200.), px(800.)),
        ))),
        ..Default::default()
    }
}
