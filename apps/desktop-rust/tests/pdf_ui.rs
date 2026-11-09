#![cfg(all(feature = "ui-tests", feature = "media"))]
#[path = "support/pdf_backend.rs"]
mod support;
use anynote_core::backend::*;
use anynote_desktop::{
    backend_session::BackendSession,
    document_editor::{self, DocumentEditor},
    pdf::{PdfView, Zoom},
};
use gpui_kit::{
    App, AppContext, Bounds, Entity, Focusable, TestAppContext, Window, WindowBounds,
    WindowOptions, px, size,
    test::{TestEventExt, TestQueryExt, TestWindowExt},
};
use support::PdfBackend;
fn spin(
    cx: &mut TestAppContext,
    window: gpui_kit::AnyWindowHandle,
    condition: impl Fn(&mut Window, &mut App) -> bool,
) {
    for _ in 0..1000 {
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
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    panic!("PDF view did not settle");
}
fn reader(cx: &mut TestAppContext, f: &PdfBackend) -> (gpui_kit::AnyWindowHandle, Entity<PdfView>) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(1000.), px(800.)),
                ))),
                ..Default::default()
            },
            cx,
            |w, cx| cx.new(|cx| PdfView::new(f.scope.clone(), f.client.clone(), w, cx)),
        )
        .unwrap()
    })
}
#[gpui_kit::test]
fn navigation_zoom_thumbnails_and_close_use_real_controls(cx: &mut TestAppContext) {
    cx.background_executor.allow_parking();
    let f = PdfBackend::new("geometry.pdf");
    let (window, view) = reader(cx, &f);
    spin(cx, window, |_, cx| view.read(cx).raster().is_some());
    cx.update_window(window, |_, w, cx| {
        assert_eq!(w.find("pdf-previous").disabled(), Some(true));
        assert!(w.find("pdf-status").label().unwrap().contains("1 / 8"));
        w.click("pdf-next", cx);
        w.click("pdf-next", cx);
    })
    .unwrap();
    spin(cx, window, |_, cx| {
        view.read(cx).raster().is_some_and(|r| r.page() == 2)
    });
    cx.update_window(window, |_, w, cx| {
        view.focus_handle(cx).focus(w, cx);
        w.press("end", cx);
    })
    .unwrap();
    spin(cx, window, |_, cx| {
        view.read(cx).raster().is_some_and(|r| r.page() == 7)
    });
    cx.update_window(window, |_, w, cx| {
        assert_eq!(w.find("pdf-next").disabled(), Some(true));
        w.click("pdf-page-input", cx);
        w.press(
            if cfg!(target_os = "macos") {
                "cmd-a"
            } else {
                "ctrl-a"
            },
            cx,
        );
        w.input("2", cx);
        w.click("pdf-jump", cx);
    })
    .unwrap();
    spin(cx, window, |_, cx| {
        view.read(cx).raster().is_some_and(|r| r.page() == 1)
    });
    for _ in 0..20 {
        cx.run_until_parked();
        cx.update_window(window, |_, w, cx| {
            w.render_frame(cx);
            assert!(
                !view.read(cx).is_loading(),
                "fit-page must settle across frames"
            );
            assert!(view.read(cx).raster().is_some());
        })
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    cx.update_window(window, |_, w, cx| {
        w.click("pdf-fit-width", cx);
        assert_eq!(view.read(cx).zoom(), Zoom::FitWidth);
    })
    .unwrap();
    spin(cx, window, |_, cx| view.read(cx).raster().is_some());
    cx.update_window(window, |_, w, cx| {
        w.click("pdf-zoom-in", cx);
        assert!(matches!(view.read(cx).zoom(), Zoom::Scale(_)));
    })
    .unwrap();
    spin(cx, window, |_, cx| view.read(cx).raster().is_some());
    cx.update_window(window, |_, w, cx| w.click("pdf-thumbnails", cx))
        .unwrap();
    spin(cx, window, |_, cx| {
        view.read(cx).cached_texture_count() == 6
    });
    cx.update_window(window, |_, w, cx| {
        let point = w.find_by_label("第 5 页").bounds().center();
        w.pointer_down(point, gpui_kit::MouseButton::Left, cx);
        w.pointer_up(point, gpui_kit::MouseButton::Left, cx);
    })
    .unwrap();
    spin(cx, window, |_, cx| {
        view.read(cx).raster().is_some_and(|r| r.page() == 4)
    });
    cx.update_window(window, |_, w, cx| {
        w.click("pdf-next", cx);
        view.update(cx, |v, cx| v.close(w, cx));
        assert_eq!(view.read(cx).cached_texture_count(), 0);
    })
    .unwrap();
    for _ in 0..30 {
        cx.run_until_parked();
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    cx.update(|cx| {
        assert!(view.read(cx).raster().is_none());
        assert_eq!(view.read(cx).cached_texture_count(), 0);
    });
}
#[gpui_kit::test]
fn password_retry_and_pdf_snapshot_entry(cx: &mut TestAppContext) {
    cx.background_executor.allow_parking();
    let f = PdfBackend::new("encrypted.pdf");
    let (window, view) = reader(cx, &f);
    spin(cx, window, |w, _| w.try_find("pdf-password").is_some());
    cx.update_window(window, |_, w, cx| {
        w.click("pdf-password", cx);
        w.input("wrong", cx);
        w.click("pdf-retry", cx);
    })
    .unwrap();
    spin(cx, window, |w, _| w.try_find("pdf-password").is_some());
    cx.update_window(window, |_, w, cx| {
        w.click("pdf-password", cx);
        w.input("rm25-test", cx);
        w.click("pdf-retry", cx);
    })
    .unwrap();
    spin(cx, window, |_, cx| view.read(cx).raster().is_some());
    cx.update_window(window, |_, w, cx| view.update(cx, |v, cx| v.close(w, cx)))
        .unwrap();
    let f = PdfBackend::new("geometry.pdf");
    let Reply::Document(snapshot) = f.reply(Command::OpenDocument {
        id: f.scope.document().clone(),
    }) else {
        panic!()
    };
    cx.update(|cx| {
        document_editor::install_actions(cx);
        BackendSession::install(f.client.clone(), cx);
    });
    let (window, _) = cx.update(|cx| {
        gpui_kit::open_window(WindowOptions::default(), cx, |w, cx| {
            cx.new(|cx| DocumentEditor::from_snapshot(snapshot, w, cx))
        })
        .unwrap()
    });
    spin(cx, window, |w, _| {
        w.try_find("pdf-status")
            .is_some_and(|s| s.label().is_some_and(|s| s.contains("1 / 8")))
    });
    cx.update_window(window, |_, w, _| {
        assert!(w.try_find("save-document").is_none())
    })
    .unwrap();
}
