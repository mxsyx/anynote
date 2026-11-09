use anynote_desktop::board::{BoardInput, Tool, Viewport, hit_test};
use anynote_editor::board::{Command, Point, Scene};
use serde_json::json;

fn point(x: f64, y: f64) -> Point {
    Point::new(x, y)
}
fn empty() -> Scene {
    Scene::parse("{\"elements\":[],\"files\":{},\"appState\":{}}").unwrap()
}
fn shape(id: &str, kind: &str, x: f64, y: f64, w: f64, h: f64, angle: f64) -> serde_json::Value {
    json!({"id":id,"type":kind,"x":x,"y":y,"width":w,"height":h,"angle":angle,"backgroundColor":"transparent","strokeWidth":2})
}
#[test]
fn zoom_keeps_anchor_and_inverse_at_extremes() {
    let mut v = Viewport::default();
    v.pan_by(point(-212., 450.));
    let anchor = point(337., 121.);
    let before = v.to_world(anchor);
    for factor in [2., 0.001, 1e8, 0.5] {
        v.zoom_at(factor, anchor);
        let after = v.to_world(anchor);
        assert!((before.x() - after.x()).abs() < 1e-9);
        assert!((before.y() - after.y()).abs() < 1e-9);
        let p = point(-120.5, 777.25);
        let back = v.to_world(v.to_screen(p));
        assert!((back.x() - p.x()).abs() < 1e-9);
        assert!((back.y() - p.y()).abs() < 1e-9);
    }
    let zoom = v.zoom();
    v.zoom_at(f64::NAN, anchor);
    assert_eq!(v.zoom(), zoom);
}
#[test]
fn rotated_hollow_shapes_and_negative_path_use_visible_geometry_and_z_order() {
    let mut rectangle = shape(
        "rect",
        "rectangle",
        100.,
        100.,
        120.,
        40.,
        std::f64::consts::FRAC_PI_2,
    );
    let mut line = shape("line", "line", 200., 200., 100., 60., 0.);
    line["points"] = json!([[0, 0], [-100, -60]]);
    let mut locked = shape("locked", "rectangle", 140., 60., 40., 120., 0.);
    locked["locked"] = json!(true);
    locked["backgroundColor"] = json!("#fff");
    let scene = Scene::from_json(json!({"elements":[rectangle,line,locked]})).unwrap();
    assert_eq!(
        hit_test(&scene, point(140., 100.), 1.).as_deref(),
        Some("rect")
    );
    assert_eq!(hit_test(&scene, point(160., 120.), 1.), None);
    assert_eq!(
        hit_test(&scene, point(150., 170.), 1.).as_deref(),
        Some("line")
    );
    assert_eq!(hit_test(&scene, point(200., 120.), 1.), None);
    rectangle = scene.element("rect").unwrap().to_json();
    rectangle["backgroundColor"] = json!("#ff0000");
    let scene = Scene::from_json(json!({"elements":[rectangle]})).unwrap();
    assert_eq!(
        hit_test(&scene, point(160., 120.), 8.).as_deref(),
        Some("rect")
    );
}
#[test]
fn gestures_preview_without_mutating_history_commit_once_and_cancel() {
    let scene = empty();
    let original = scene.serialize().unwrap();
    let mut input = BoardInput::new(scene);
    input.set_tool(Tool::Rectangle);
    input.begin(point(10., 20.), false, false);
    for x in 30..80 {
        input.update(point(x as f64, 60.), false);
    }
    assert_eq!(input.board().scene().serialize().unwrap(), original);
    assert_eq!(input.scene().elements().len(), 1);
    input.finish();
    assert_eq!(input.board().scene().elements().len(), 1);
    input.undo();
    assert_eq!(input.board().scene().serialize().unwrap(), original);
    assert!(!input.board().has_undo());
    input.redo();
    input.set_tool(Tool::Select);
    let committed = input.board().scene().serialize().unwrap();
    input.begin(point(10., 40.), false, false);
    input.update(point(40., 70.), false);
    input.cancel();
    assert_eq!(input.board().scene().serialize().unwrap(), committed);
    input.set_tool(Tool::Ellipse);
    input.begin(point(100., 100.), false, false);
    input.finish();
    assert_eq!(input.board().scene().serialize().unwrap(), committed);
}
#[test]
fn rotated_resize_keeps_opposite_corner_and_one_history_step() {
    let scene =
        Scene::from_json(json!({"elements":[shape("r","rectangle",100.,100.,120.,40.,0.7)]}))
            .unwrap();
    let original = scene.element("r").unwrap().geometry().unwrap();
    let mut input = BoardInput::new(scene);
    input.select(["r".into()]);
    input.begin(original.corners()[2], false, false);
    input.update(original.local_to_world(point(180., 90.)), false);
    input.finish();
    let g = input
        .board()
        .scene()
        .element("r")
        .unwrap()
        .geometry()
        .unwrap();
    assert!((g.width() - 180.).abs() < 1e-9);
    assert!((g.height() - 90.).abs() < 1e-9);
    assert!((g.corners()[0].x() - original.corners()[0].x()).abs() < 1e-9);
    assert!((g.corners()[0].y() - original.corners()[0].y()).abs() < 1e-9);
    input.undo();
    assert_eq!(
        input
            .board()
            .scene()
            .element("r")
            .unwrap()
            .geometry()
            .unwrap(),
        original
    );
}
#[test]
fn rejected_open_binding_gesture_leaves_scene_and_redo_intact() {
    let mut rect = shape("r", "rectangle", 10., 10., 100., 80., 0.);
    rect["boundElements"] = json!([{"id":"a","type":"arrow"}]);
    let mut arrow = shape("a", "arrow", 110., 50., 100., 0., 0.);
    arrow["points"] = json!([[0, 0], [100, 0]]);
    arrow["startBinding"] = json!({"elementId":"r","focus":0,"gap":0});
    let scene = Scene::from_json(json!({"elements":[rect,arrow]})).unwrap();
    let mut input = BoardInput::new(scene);
    input.select(["r".into()]);
    input.execute(&[Command::Style {
        properties: json!({"opacity":80}).as_object().unwrap().clone(),
    }]);
    input.undo();
    let before = input.board().scene().serialize().unwrap();
    input.begin(point(10., 50.), false, false);
    input.update(point(20., 60.), false);
    input.finish();
    assert!(input.error().unwrap().contains("binding"));
    assert!(input.board().has_redo());
    assert_eq!(input.board().scene().serialize().unwrap(), before);
}
#[test]
fn group_selection_marquee_escape_and_lock_respect_core_rules() {
    let mut a = shape("a", "rectangle", 10., 10., 40., 40., 0.);
    a["groupIds"] = json!(["g"]);
    let mut b = shape("b", "ellipse", 80., 10., 40., 40., 0.);
    b["groupIds"] = json!(["g"]);
    let scene = Scene::from_json(json!({"elements":[a,b]})).unwrap();
    let mut input = BoardInput::new(scene);
    input.begin(point(10., 30.), false, false);
    input.finish();
    assert_eq!(input.board().selected_ids().len(), 2);
    input.begin(point(0., 0.), false, false);
    input.update(point(5., 5.), false);
    assert!(input.board().selected_ids().is_empty());
    input.cancel();
    assert_eq!(input.board().selected_ids().len(), 2);
    input.execute(&[Command::Lock { locked: true }]);
    assert_eq!(hit_test(input.scene(), point(10., 30.), 1.), None);
    input.execute(&[Command::Translate {
        delta: point(30., 30.),
    }]);
    assert!(input.error().unwrap().contains("locked"));
}
