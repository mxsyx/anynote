#![cfg(feature = "ui-tests")]
use anynote_desktop::board::{BoardView, install_actions};
use anynote_editor::board::Scene;
use gpui_kit::{
    AppContext, Bounds, MouseButton, TestAppContext, WindowBounds, WindowOptions,
    component::{Theme, ThemeMode},
    point, px, size,
    test::{TestEventExt, TestQueryExt, TestWindowExt},
};

fn primary(key: &str) -> String {
    format!(
        "{}-{key}",
        if cfg!(target_os = "macos") {
            "cmd"
        } else {
            "ctrl"
        }
    )
}
#[gpui_kit::test]
fn native_pointer_keyboard_clipboard_history_theme_and_dpi(cx: &mut TestAppContext) {
    cx.background_executor.allow_parking();
    cx.update(|cx| {
        gpui_kit::init(cx);
        install_actions(cx);
    });
    let (window, view) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(1000.), px(700.)),
                ))),
                ..Default::default()
            },
            cx,
            |w, cx| cx.new(|cx| BoardView::new(Scene::parse("{\"elements\":[]}").unwrap(), w, cx)),
        )
        .unwrap()
    });
    cx.update_window(window, |_, w, cx| {
        w.render_frame(cx);
        w.click("board-rectangle", cx);
        let origin = w.find("board-canvas").bounds().origin;
        w.pointer_down(origin + point(px(100.), px(100.)), MouseButton::Left, cx);
        w.pointer_move(
            origin + point(px(240.), px(180.)),
            Some(MouseButton::Left),
            cx,
        );
        assert_eq!(view.read(cx).scene().elements().len(), 0);
        w.pointer_up(origin + point(px(240.), px(180.)), MouseButton::Left, cx);
        assert_eq!(view.read(cx).scene().elements().len(), 1);
        w.press(&primary("z"), cx);
        assert_eq!(view.read(cx).scene().elements().len(), 0);
        w.press(&primary("shift-z"), cx);
        assert_eq!(view.read(cx).scene().elements().len(), 1);
        w.press("v", cx);
        w.press("right", cx);
        assert_eq!(
            view.read(cx)
                .scene()
                .elements()
                .next()
                .unwrap()
                .geometry()
                .unwrap()
                .x(),
            101.
        );
        w.press(&primary("c"), cx);
        assert!(
            cx.read_from_clipboard()
                .unwrap()
                .text()
                .unwrap()
                .contains("excalidraw/clipboard")
        );
        w.press(&primary("v"), cx);
        assert_eq!(view.read(cx).scene().elements().len(), 2);
        w.press("delete", cx);
        assert_eq!(
            view.read(cx)
                .scene()
                .elements()
                .filter(|e| !e.is_deleted())
                .count(),
            1
        );
        w.press(&primary("z"), cx);
        assert_eq!(
            view.read(cx)
                .scene()
                .elements()
                .filter(|e| !e.is_deleted())
                .count(),
            2
        );
        Theme::change(ThemeMode::Dark, Some(w), cx);
        w.render_frame(cx);
        assert!(w.find("board-canvas").visible());
    })
    .unwrap();
    cx.simulate_window_resize(window, size(px(680.), px(500.)));
    cx.simulate_window_scale_factor_change(window, 2.);
    cx.update_window(window, |_, w, cx| {
        w.render_frame(cx);
        assert!(w.find("board-canvas").bounds().size.height > px(100.));
        w.click("board-ellipse", cx);
        let origin = w.find("board-canvas").bounds().origin;
        w.pointer_down(origin + point(px(40.), px(200.)), MouseButton::Left, cx);
        w.pointer_move(
            origin + point(px(140.), px(300.)),
            Some(MouseButton::Left),
            cx,
        );
        w.press("escape", cx);
        w.pointer_up(origin + point(px(140.), px(300.)), MouseButton::Left, cx);
        assert_eq!(
            view.read(cx)
                .scene()
                .elements()
                .filter(|e| !e.is_deleted())
                .count(),
            2
        );
        w.remove_window();
    })
    .unwrap();
}

#[gpui_kit::test]
fn text_dialog_uses_native_input_and_preserves_canvas_history(cx: &mut TestAppContext) {
    cx.background_executor.allow_parking();
    cx.update(|cx| {
        gpui_kit::init(cx);
        install_actions(cx);
    });
    let (window, view) = cx.update(|cx| {
        gpui_kit::open_window(WindowOptions::default(), cx, |w, cx| {
            cx.new(|cx| BoardView::new(Scene::parse("{\"elements\":[]}").unwrap(), w, cx))
        })
        .unwrap()
    });
    cx.update_window(window, |_, w, cx| {
        w.render_frame(cx);
        w.click("board-text", cx);
        let p = w.find("board-canvas").bounds().center();
        w.pointer_down(p, MouseButton::Left, cx);
        w.pointer_up(p, MouseButton::Left, cx);
        let text = w
            .find_all_by_label("白板文字内容")
            .into_iter()
            .find(|e| e.visible())
            .unwrap()
            .bounds()
            .center();
        w.pointer_down(text, MouseButton::Left, cx);
        w.pointer_up(text, MouseButton::Left, cx);
        w.input("中文 & <native> 🦀", cx);
        w.click("board-apply-text", cx);
        let element = view.read(cx).scene().elements().next().unwrap();
        assert_eq!(element.field("text").unwrap(), "中文 & <native> 🦀");
        assert!(element.geometry().unwrap().width() > 10.);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(window, |_, w, cx| {
        w.render_frame(cx);
        w.press(&primary("z"), cx);
        assert_eq!(view.read(cx).scene().elements().len(), 0);
        w.remove_window();
    })
    .unwrap();
}

#[gpui_kit::test]
fn native_image_clipboard_and_selection_menu_use_production_routes(cx: &mut TestAppContext) {
    cx.background_executor.allow_parking();
    cx.update(|cx| {
        gpui_kit::init(cx);
        install_actions(cx);
    });
    let (window, view) = cx.update(|cx| {
        gpui_kit::open_window(WindowOptions::default(), cx, |w, cx| {
            cx.new(|cx| BoardView::new(Scene::parse("{\"elements\":[]}").unwrap(), w, cx))
        })
        .unwrap()
    });
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        100,
        60,
        image::Rgba([20, 80, 200, 255]),
    ))
    .write_to(&mut png, image::ImageFormat::Png)
    .unwrap();
    cx.update_window(window, |_, w, cx| {
        w.render_frame(cx);
        cx.write_to_clipboard(gpui_kit::ClipboardItem::new_image(
            &gpui_kit::Image::from_bytes(gpui_kit::ImageFormat::Png, png.into_inner()),
        ));
        w.press(&primary("v"), cx);
    })
    .unwrap();
    let mut ready = false;
    for _ in 0..400 {
        cx.run_until_parked();
        ready = cx
            .update_window(window, |_, w, cx| {
                w.render_frame(cx);
                view.read(cx).scene().elements().len() == 1 && !view.read(cx).is_loading()
            })
            .unwrap();
        if ready {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(ready, "native image import did not finish");
    cx.update_window(window, |_, w, cx| {
        let element = view.read(cx).scene().elements().next().unwrap();
        assert_eq!(element.type_name(), "image");
        assert_eq!(element.geometry().unwrap().width(), 100.);
        w.press(&primary("d"), cx);
        assert_eq!(view.read(cx).scene().elements().len(), 2);
        w.press(&primary("a"), cx);
        w.click("board-more", cx);
        let p = w
            .find_all_by_label("组合")
            .into_iter()
            .find(|e| e.visible())
            .unwrap()
            .bounds()
            .center();
        w.pointer_down(p, MouseButton::Left, cx);
        w.pointer_up(p, MouseButton::Left, cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(window, |_, w, cx| {
        w.render_frame(cx);
        let groups: Vec<_> = view
            .read(cx)
            .scene()
            .elements()
            .map(|e| e.field("groupIds").unwrap().clone())
            .collect();
        assert_eq!(groups[0], groups[1]);
        assert_eq!(groups[0].as_array().unwrap().len(), 1);
        w.press(&primary("z"), cx);
        assert!(
            view.read(cx).scene().elements().all(|e| e
                .field("groupIds")
                .unwrap()
                .as_array()
                .unwrap()
                .is_empty())
        );
        w.remove_window();
    })
    .unwrap();
}
