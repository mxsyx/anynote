#![cfg(feature = "ui-tests")]
use anynote_desktop::board::{BoardView, install_actions};
use anynote_editor::board::Scene;
use gpui_kit::{
    AppContext, Bounds, MouseButton, TestAppContext, WindowBounds, WindowOptions, point, px, size,
    test::{TestEventExt, TestQueryExt, TestWindowExt},
};
use serde_json::json;
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
fn property_validation_search_and_library_run_through_production_controls(cx: &mut TestAppContext) {
    cx.background_executor.allow_parking();
    cx.update(|cx| {
        gpui_kit::init(cx);
        install_actions(cx);
    });
    let (window,view)=cx.update(|cx| gpui_kit::open_window(WindowOptions {
        window_bounds:Some(WindowBounds::Windowed(Bounds::new(Default::default(),size(px(1100.),px(850.))))), ..Default::default()
    },cx,|w,cx|cx.new(|cx|BoardView::new(Scene::from_json(json!({"elements":[
        {"id":"r","type":"rectangle","x":50,"y":50,"width":120,"height":80,"angle":0,"roughness":0,"strokeColor":"#112233","backgroundColor":"transparent","strokeWidth":2,"opacity":100},
        {"id":"t","type":"text","x":300,"y":200,"width":180,"height":25,"angle":0,"text":"搜索目标","fontSize":20}
    ]})).unwrap(),w,cx))).unwrap());
    cx.update_window(window, |_, w, cx| {
        w.render_frame(cx);
        let origin = w.find("board-canvas").bounds().origin;
        w.pointer_down(origin + point(px(50.), px(90.)), MouseButton::Left, cx);
        w.pointer_up(origin + point(px(50.), px(90.)), MouseButton::Left, cx);
        w.click("board-properties", cx);
        w.click("board-property-opacity", cx);
        w.press(&primary("a"), cx);
        w.input("150", cx);
        w.click("board-apply-properties", cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(window, |_, w, cx| {
        w.render_frame(cx);
        assert_eq!(
            view.read(cx)
                .scene()
                .element("r")
                .unwrap()
                .field("opacity")
                .unwrap(),
            100
        );
        assert!(w.find("board-apply-properties").visible());
        w.click("board-property-opacity", cx);
        w.press(&primary("a"), cx);
        w.input("45", cx);
        w.click("board-strokeStyle-dashed", cx);
        w.click("board-apply-properties", cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(window, |_, w, cx| {
        w.render_frame(cx);
        assert_eq!(
            view.read(cx)
                .scene()
                .element("r")
                .unwrap()
                .field("opacity")
                .unwrap(),
            45.
        );
        assert_eq!(
            view.read(cx)
                .scene()
                .element("r")
                .unwrap()
                .field("strokeStyle")
                .unwrap(),
            "dashed"
        );
        w.press(&primary("z"), cx);
        assert_eq!(
            view.read(cx)
                .scene()
                .element("r")
                .unwrap()
                .field("opacity")
                .unwrap(),
            100
        );
        w.click("board-search", cx);
        w.click("board-search-query", cx);
        w.input("目标", cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(window, |_, w, cx| {
        w.render_frame(cx);
        w.click("board-search-t", cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(window, |_, w, cx| {
        w.render_frame(cx);
        assert_eq!(
            view.read(cx)
                .input()
                .board()
                .selected_ids()
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["t"]
        );
        w.click("board-more", cx);
        let p = w
            .find_all_by_label("将选中图形加入图库")
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
        let p = w
            .find_all_by_label("插入 搜索目标")
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
        assert_eq!(view.read(cx).scene().elements().len(), 3);
        assert_eq!(
            view.read(cx)
                .scene()
                .elements()
                .filter(|e| e.field("text") == Some(&json!("搜索目标")))
                .count(),
            2
        );
        w.press(&primary("z"), cx);
        assert_eq!(view.read(cx).scene().elements().len(), 2);
        w.remove_window();
    })
    .unwrap();
}
