use anynote_desktop::board::{BoardInput, hit_test, preview};
use anynote_editor::board::{Command, Point, Scene, linear_strokes};
use serde_json::{Value, json};
fn p(x: f64, y: f64) -> Point {
    Point::new(x, y)
}
fn rect(id: &str, x: f64) -> Value {
    json!({"id":id,"type":"rectangle","x":x,"y":20,"width":80,"height":60,"angle":0,"roughness":0,"strokeWidth":2,"backgroundColor":"transparent","groupIds":["g"]})
}
#[test]
fn editing_group_preview_commit_cancel_and_history_use_the_same_selection() {
    let mut input = BoardInput::new(
        Scene::from_json(json!({"elements":[rect("a",10.),rect("b",120.)]})).unwrap(),
    );
    input.enter_group("a");
    assert_eq!(input.board().editing_group(), Some("g"));
    assert_eq!(input.board().selected_ids().len(), 1);
    let before = input.board().scene().serialize().unwrap();
    input.begin(p(10., 50.), false, false);
    input.update(p(30., 65.), false);
    assert_eq!(
        input.scene().element("b").unwrap().geometry().unwrap().x(),
        120.
    );
    assert_eq!(input.board().scene().serialize().unwrap(), before);
    assert!(input.finish(), "{:?}", input.error());
    assert_eq!(
        input
            .board()
            .scene()
            .element("a")
            .unwrap()
            .geometry()
            .unwrap()
            .x(),
        30.
    );
    assert_eq!(
        input
            .board()
            .scene()
            .element("b")
            .unwrap()
            .geometry()
            .unwrap()
            .x(),
        120.
    );
    input.undo();
    assert_eq!(input.board().scene().serialize().unwrap(), before);
    input.redo();
    input.begin(p(30., 65.), false, false);
    input.update(p(90., 100.), false);
    input.cancel();
    assert_eq!(input.board().editing_group(), Some("g"));
    input.edit_group(None);
    input.select(["a".into()]);
    assert_eq!(input.board().selected_ids().len(), 2);
}
#[test]
fn rotated_path_point_drag_uses_kernel_normalization_and_preserves_untouched_vertices() {
    let scene = Scene::from_json(json!({"elements":[{"id":"p","type":"line","x":100,"y":100,"width":100,"height":80,"angle":0.6,"points":[[0,0],[100,80]],"seed":1,"roughness":0}]})).unwrap();
    let original = scene.element("p").unwrap().world_points().unwrap();
    let before = scene.serialize().unwrap();
    let mut input = BoardInput::new(scene);
    input.select(["p".into()]);
    input.begin(original[0], false, false);
    input.update(p(original[0].x() + 20., original[0].y() + 10.), false);
    assert!(input.finish(), "{:?}", input.error());
    let next = input.scene().element("p").unwrap().world_points().unwrap();
    assert!((next[0].x() - original[0].x() - 20.).abs() < 1e-8);
    assert!((next[0].y() - original[0].y() - 10.).abs() < 1e-8);
    assert!((next[1].x() - original[1].x()).abs() < 1e-8);
    assert!((next[1].y() - original[1].y()).abs() < 1e-8);
    input.undo();
    assert_eq!(input.scene().serialize().unwrap(), before);
}
#[test]
fn crop_is_one_kernel_transaction_and_escape_keeps_redo() {
    let scene = Scene::from_json(json!({"elements":[{"id":"i","type":"image","x":0,"y":0,"width":200,"height":100,"angle":0,"scale":[1,1],"crop":null}]})).unwrap();
    let before = scene.serialize().unwrap();
    let mut input = BoardInput::new(scene);
    input.start_crop("i".into(), [400., 200.]);
    input.begin(p(200., 100.), false, false);
    input.update(p(100., 70.), false);
    assert_eq!(input.board().scene().serialize().unwrap(), before);
    assert!(input.finish(), "{:?}", input.error());
    assert_eq!(
        input.scene().element("i").unwrap().field("crop").unwrap()["width"],
        200.
    );
    input.undo();
    assert_eq!(input.scene().serialize().unwrap(), before);
    input.start_crop("i".into(), [400., 200.]);
    input.begin(p(200., 100.), false, false);
    input.update(p(150., 80.), false);
    input.end_crop();
    assert_eq!(input.scene().serialize().unwrap(), before);
    assert!(input.board().has_redo());
}
#[test]
fn seeded_curve_hit_uses_the_drawn_curve_instead_of_control_polygon() {
    let scene=Scene::from_json(json!({"elements":[{"id":"p","type":"line","x":100,"y":100,"width":200,"height":100,"angle":0,"points":[[0,0],[100,100],[200,0]],"roundness":{"type":2},"roughness":0,"seed":17,"strokeWidth":1}]})).unwrap();
    let curves = linear_strokes(scene.element("p").unwrap()).unwrap();
    let [a, b, c, d] = curves[0];
    let middle = p(
        (a.x() + 3. * b.x() + 3. * c.x() + d.x()) / 8.,
        (a.y() + 3. * b.y() + 3. * c.y() + d.y()) / 8.,
    );
    assert_eq!(hit_test(&scene, middle, 8.).as_deref(), Some("p"));
    assert_eq!(hit_test(&scene, p(150., 150.), 8.), None);
    assert_eq!(curves, linear_strokes(scene.element("p").unwrap()).unwrap());
}
#[test]
fn frame_clips_hits_and_png_and_arrowhead_area_is_selectable() {
    let scene = Scene::from_json(json!({"elements":[
        {"id":"f","type":"frame","x":0,"y":0,"width":100,"height":100,"angle":0,"roughness":0,"strokeWidth":0},
        {"id":"r","type":"rectangle","x":50,"y":30,"width":100,"height":40,"angle":0,"roughness":0,"backgroundColor":"#ff0000","strokeWidth":0,"fillStyle":"solid","frameId":"f"}
    ]})).unwrap();
    assert_eq!(hit_test(&scene, p(75., 50.), 1.).as_deref(), Some("r"));
    assert_eq!(hit_test(&scene, p(125., 50.), 1.), None);
    let png = preview::png(&scene).unwrap();
    let pixels = image::load_from_memory(&png).unwrap().to_rgba8();
    assert_eq!(pixels.get_pixel(91, 66).0, [255, 0, 0, 255]);
    assert_eq!(pixels.get_pixel(141, 66).0, [255, 255, 255, 255]);
    let scene = Scene::from_json(json!({"elements":[{"id":"a","type":"arrow","x":0,"y":50,"width":100,"height":0,"angle":0,"points":[[0,0],[100,0]],"roughness":0,"seed":1,"strokeWidth":1,"endArrowhead":"triangle"}]})).unwrap();
    assert_eq!(hit_test(&scene, p(84., 56.), 8.).as_deref(), Some("a"));
}
#[test]
fn fit_does_not_consume_scene_history() {
    let mut input = BoardInput::new(Scene::from_json(json!({"elements":[rect("a",10.)]})).unwrap());
    input.select(["a".into()]);
    input.execute(&[Command::Translate { delta: p(2., 0.) }]);
    input.undo();
    input
        .viewport_mut()
        .fit([-100., -40., 300., 60.], p(800., 600.));
    assert_eq!(input.viewport().to_screen(p(100., 10.)), p(400., 300.));
    assert!(input.board().has_redo());
    let zoom = input.viewport().zoom();
    input
        .viewport_mut()
        .fit([0., 0., 100., 100.], p(f64::NAN, 400.));
    assert_eq!(input.viewport().zoom(), zoom);
}

#[test]
fn cancelled_move_outside_an_editing_group_restores_group_context() {
    let mut outside = rect("outside", 300.);
    outside["groupIds"] = json!([]);
    let mut input = BoardInput::new(
        Scene::from_json(json!({"elements":[rect("a",10.), rect("b",120.), outside]})).unwrap(),
    );
    input.enter_group("a");
    input.begin(p(300., 50.), false, false);
    input.update(p(320., 60.), false);
    assert_eq!(input.board().editing_group(), None);
    input.cancel();
    assert_eq!(input.board().editing_group(), Some("g"));
    assert_eq!(
        input
            .board()
            .selected_ids()
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        vec!["a"]
    );
}
