use anynote_editor::board::{
    Board, Command, EditStamp, ElementKind, Geometry, Layer, Point, Scene,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const INPUT: &str = include_str!("../../../tests/fixtures/rust-migration/corpus/scene-input.json");
const READBACK: &str =
    include_str!("../../../tests/fixtures/rust-migration/corpus/scene-readback.json");
fn board() -> Board {
    Board::new(Scene::parse(INPUT).unwrap(), 128)
}
fn stamp() -> EditStamp {
    EditStamp::new(100, 42)
}
fn select(board: &mut Board, ids: &[&str]) {
    board.select(ids.iter().map(|id| id.to_string())).unwrap();
}
fn style(value: Value) -> Command {
    Command::Style {
        properties: value.as_object().unwrap().clone(),
    }
}
fn apply(board: &mut Board, command: Command) {
    assert!(board.apply(command, stamp()).unwrap());
}

#[test]
fn original_scenes_are_byte_exact_and_known_fields_are_typed() {
    for source in [INPUT, READBACK] {
        let scene = Scene::parse(source).unwrap();
        assert_eq!(scene.serialize().unwrap(), source);
        assert_eq!(scene.elements().len(), 11);
        assert_eq!(
            scene.element("element-3").unwrap().kind(),
            ElementKind::Text
        );
        assert_eq!(
            scene.element("element-7").unwrap().field("fileId"),
            Some(&json!("sample"))
        );
        assert_eq!(
            scene
                .element("element-5")
                .unwrap()
                .geometry()
                .unwrap()
                .local_to_world(Point::new(20.0, 20.0)),
            Point::new(170.0, 30.0)
        );
    }
}
#[test]
fn unknown_json_and_unknown_types_survive_edits() {
    let mut value: Value = serde_json::from_str(INPUT).unwrap();
    value["future"] = json!({"nested":[null,9007199254740993_u64,{"opaque":"原文"}]});
    value["elements"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"future","type":"future-shape","opaque":[1,2]}));
    value["elements"][0]["startBinding"] = json!({"elementId":"future","futureFocus":42});
    let unknown = value["elements"][11].clone();
    let mut board = Board::new(Scene::from_json(value.clone()).unwrap(), 4);
    select(&mut board, &["element-0"]);
    apply(&mut board, style(json!({"opacity":40})));
    let result = board.scene().to_json();
    assert_eq!(result["future"], value["future"]);
    assert_eq!(result["elements"][11], unknown);
    assert_eq!(
        result["elements"][0]["startBinding"],
        value["elements"][0]["startBinding"]
    );
    select(&mut board, &["future"]);
    assert!(board.apply(Command::Delete, stamp()).is_err());
}
#[test]
fn malformed_input_and_invalid_commands_are_atomic() {
    for value in [
        json!({}),
        json!({"elements":{}}),
        json!({"elements":[],"files":[]}),
    ] {
        assert!(Scene::from_json(value).is_err());
    }
    let mut value: Value = serde_json::from_str(INPUT).unwrap();
    value["elements"][1]["id"] = json!("element-0");
    assert!(Scene::from_json(value).is_err());
    let mut board = board();
    select(&mut board, &["element-0"]);
    assert!(
        board
            .apply_batch(
                &[
                    style(json!({"opacity":50})),
                    Command::Translate {
                        delta: Point::new(f64::NAN, 0.0)
                    }
                ],
                stamp()
            )
            .is_err()
    );
    assert_eq!(board.scene().serialize().unwrap(), INPUT);
    assert!(!board.has_undo());
    assert!(
        board
            .apply(style(json!({"id":"replacement"})), stamp())
            .is_err()
    );
    assert!(board.select(["missing".into()]).is_err());
    assert!(board.selected_ids().contains("element-0"));
}
#[test]
fn undo_redo_restores_every_byte_and_new_edits_drop_only_redo() {
    let mut board = board();
    select(&mut board, &["element-0", "element-3", "element-7"]);
    let original = board.scene().serialize().unwrap();
    apply(
        &mut board,
        Command::Translate {
            delta: Point::new(12.0, -4.0),
        },
    );
    let moved = board.scene().serialize().unwrap();
    apply(&mut board, style(json!({"opacity":55})));
    let styled = board.scene().serialize().unwrap();
    assert!(board.undo());
    assert_eq!(board.scene().serialize().unwrap(), moved);
    assert!(board.undo());
    assert_eq!(board.scene().serialize().unwrap(), original);
    assert!(board.redo());
    assert_eq!(board.scene().serialize().unwrap(), moved);
    assert!(board.redo());
    assert_eq!(board.scene().serialize().unwrap(), styled);
    assert!(!board.redo());
    assert!(board.undo());
    assert!(
        !board
            .apply(
                Command::Translate {
                    delta: Point::new(0.0, 0.0)
                },
                stamp()
            )
            .unwrap()
    );
    assert!(board.has_redo());
    assert!(board.apply(style(json!({"opacity":200})), stamp()).is_err());
    assert!(board.has_redo());
    apply(&mut board, style(json!({"opacity":35})));
    assert!(!board.has_redo());
}
#[test]
fn gesture_batch_has_one_history_entry_and_one_version_increment() {
    let mut board = board();
    select(&mut board, &["element-0"]);
    assert!(
        board
            .apply_batch(
                &[
                    Command::Translate {
                        delta: Point::new(1.0, 2.0)
                    },
                    style(json!({"strokeColor":"#ff0000"}))
                ],
                stamp()
            )
            .unwrap()
    );
    let e = board.scene().element("element-0").unwrap();
    assert_eq!(e.field("version"), Some(&json!(2)));
    assert_eq!(e.field("versionNonce"), Some(&json!(42)));
    assert_eq!(e.field("updated"), Some(&json!(100)));
    assert!(board.undo());
    assert!(!board.undo());
    assert_eq!(board.scene().serialize().unwrap(), INPUT);
}
#[test]
fn history_limit_is_enforced() {
    let mut board = Board::new(Scene::parse(INPUT).unwrap(), 2);
    select(&mut board, &["element-0"]);
    for _ in 0..3 {
        apply(
            &mut board,
            Command::Translate {
                delta: Point::new(1.0, 0.0),
            },
        );
    }
    assert!(board.undo());
    assert!(board.undo());
    assert!(!board.undo());
    assert_eq!(
        board
            .scene()
            .element("element-0")
            .unwrap()
            .geometry()
            .unwrap()
            .x(),
        1.0
    );
}
#[test]
fn text_image_and_rotated_geometry_use_scene_coordinates() {
    let geometry = Geometry::new(10.0, 20.0, 100.0, 50.0, std::f64::consts::FRAC_PI_2).unwrap();
    for point in [
        Point::new(0.0, 0.0),
        Point::new(33.0, 12.0),
        Point::new(100.0, 50.0),
    ] {
        let restored = geometry.world_to_local(geometry.local_to_world(point));
        assert!(
            (point.x() - restored.x()).abs() < 1e-10 && (point.y() - restored.y()).abs() < 1e-10
        );
    }
    let mut board = board();
    apply(
        &mut board,
        Command::Text {
            id: "element-3".into(),
            text: "第一行\n😀第二行".into(),
            geometry,
        },
    );
    assert_eq!(
        board
            .scene()
            .element("element-3")
            .unwrap()
            .field("originalText"),
        Some(&json!("第一行\n😀第二行"))
    );
    let files = board.scene().field("files").cloned();
    apply(
        &mut board,
        Command::Geometry {
            id: "element-7".into(),
            geometry,
        },
    );
    assert_eq!(board.scene().field("files"), files.as_ref());
    assert_eq!(
        board.scene().element("element-7").unwrap().field("scale"),
        Some(&json!([1, 1]))
    );
}
#[test]
fn pressure_and_path_validation_preserve_unknown_fields() {
    let mut board = board();
    apply(
        &mut board,
        Command::Points {
            id: "element-6".into(),
            points: vec![
                Point::new(0.0, 0.0),
                Point::new(-5.0, 6.0),
                Point::new(10.0, 20.0),
            ],
            pressures: Some(vec![0.0, 0.3, 1.0]),
        },
    );
    let e = board.scene().element("element-6").unwrap();
    assert_eq!(e.geometry().unwrap().width(), 15.0);
    assert_eq!(e.field("customData"), Some(&json!({"unknown":"preserve"})));
    let before = board.scene().serialize().unwrap();
    assert!(
        board
            .apply(
                Command::Points {
                    id: "element-6".into(),
                    points: vec![Point::new(0.0, 0.0), Point::new(1.0, 1.0)],
                    pressures: Some(vec![2.0])
                },
                stamp()
            )
            .is_err()
    );
    assert_eq!(board.scene().serialize().unwrap(), before);
}
#[test]
fn nested_group_selection_and_layer_order_are_reversible() {
    let mut board = board();
    select(&mut board, &["element-0", "element-2"]);
    apply(&mut board, Command::Group { id: "g1".into() });
    assert_eq!(
        board
            .scene()
            .elements()
            .take(3)
            .map(|e| e.id())
            .collect::<Vec<_>>(),
        ["element-1", "element-0", "element-2"]
    );
    select(&mut board, &["element-0"]);
    assert!(board.selected_ids().contains("element-2"));
    select(&mut board, &["element-0", "element-3"]);
    apply(&mut board, Command::Group { id: "g2".into() });
    assert_eq!(
        board
            .scene()
            .element("element-0")
            .unwrap()
            .field("groupIds"),
        Some(&json!(["g1", "g2"]))
    );
    apply(&mut board, Command::Ungroup { id: "g2".into() });
    select(&mut board, &["element-0"]);
    assert_eq!(board.selected_ids().len(), 2);
    apply(
        &mut board,
        Command::Layer {
            layer: Layer::Front,
        },
    );
    let ids: Vec<_> = board.scene().elements().map(|e| e.id()).collect();
    assert_eq!(&ids[9..], ["element-0", "element-2"]);
    let indices: Vec<_> = board
        .scene()
        .elements()
        .map(|e| e.field("index").unwrap().as_str().unwrap())
        .collect();
    assert!(indices.windows(2).all(|pair| pair[0] < pair[1]));
    while board.undo() {}
    assert_eq!(board.scene().serialize().unwrap(), INPUT);
}
#[test]
fn binding_updates_both_sides_and_open_binding_move_is_rejected() {
    let mut board = board();
    apply(
        &mut board,
        Command::BindText {
            text: "element-3".into(),
            container: Some("element-0".into()),
        },
    );
    apply(
        &mut board,
        Command::BindArrow {
            arrow: "element-5".into(),
            end: true,
            binding: Some(json!({"elementId":"element-0","focus":0,"gap":1,"future":42})),
        },
    );
    let target = board.scene().element("element-0").unwrap();
    assert_eq!(
        target
            .field("boundElements")
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        2
    );
    select(&mut board, &["element-0"]);
    assert!(board.selected_ids().contains("element-3"));
    let before = board.scene().serialize().unwrap();
    assert!(
        board
            .apply(
                Command::Translate {
                    delta: Point::new(10.0, 0.0)
                },
                stamp()
            )
            .is_err()
    );
    assert_eq!(board.scene().serialize().unwrap(), before);
    select(&mut board, &["element-0", "element-5"]);
    apply(
        &mut board,
        Command::Translate {
            delta: Point::new(10.0, 0.0),
        },
    );
    assert_eq!(
        board
            .scene()
            .element("element-5")
            .unwrap()
            .field("endBinding")
            .unwrap()["future"],
        42
    );
    select(&mut board, &["element-0"]);
    apply(&mut board, Command::Delete);
    assert!(board.scene().element("element-3").unwrap().is_deleted());
    assert_eq!(
        board
            .scene()
            .element("element-5")
            .unwrap()
            .field("endBinding"),
        Some(&Value::Null)
    );
    assert!(board.undo());
    assert_eq!(
        board
            .scene()
            .element("element-5")
            .unwrap()
            .field("endBinding")
            .unwrap()["elementId"],
        "element-0"
    );
}
#[test]
fn two_arrow_ends_on_one_target_keep_reverse_binding_until_both_detached() {
    let mut board = board();
    for end in [false, true] {
        apply(
            &mut board,
            Command::BindArrow {
                arrow: "element-5".into(),
                end,
                binding: Some(json!({"elementId":"element-0","focus":0,"gap":1})),
            },
        );
    }
    apply(
        &mut board,
        Command::BindArrow {
            arrow: "element-5".into(),
            end: false,
            binding: None,
        },
    );
    assert_eq!(
        board
            .scene()
            .element("element-0")
            .unwrap()
            .field("boundElements")
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    apply(
        &mut board,
        Command::BindArrow {
            arrow: "element-5".into(),
            end: true,
            binding: None,
        },
    );
    assert!(
        board
            .scene()
            .element("element-0")
            .unwrap()
            .field("boundElements")
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
}
#[test]
fn duplicate_remaps_internal_ids_and_keeps_file_identity() {
    let mut board = board();
    apply(
        &mut board,
        Command::BindText {
            text: "element-3".into(),
            container: Some("element-0".into()),
        },
    );
    select(&mut board, &["element-0", "element-7"]);
    apply(&mut board, Command::Group { id: "g".into() });
    let ids = BTreeMap::from([
        ("element-0".into(), "copy-shape".into()),
        ("element-3".into(), "copy-text".into()),
        ("element-7".into(), "copy-image".into()),
    ]);
    apply(
        &mut board,
        Command::Duplicate {
            ids,
            groups: BTreeMap::from([("g".into(), "copy-group".into())]),
            delta: Point::new(20.0, 20.0),
        },
    );
    assert_eq!(
        board
            .scene()
            .element("copy-text")
            .unwrap()
            .field("containerId"),
        Some(&json!("copy-shape"))
    );
    assert_eq!(
        board
            .scene()
            .element("copy-shape")
            .unwrap()
            .field("boundElements")
            .unwrap()[0]["id"],
        "copy-text"
    );
    assert_eq!(
        board.scene().element("copy-image").unwrap().field("fileId"),
        Some(&json!("sample"))
    );
    let order: Vec<_> = board
        .scene()
        .elements()
        .map(|element| element.id())
        .collect();
    let first = order.iter().position(|id| *id == "copy-shape").unwrap();
    assert_eq!(
        &order[first..first + 3],
        ["copy-shape", "copy-text", "copy-image"]
    );
    assert_eq!(order[first - 1], "element-7");

    assert_eq!(
        board
            .scene()
            .field("files")
            .unwrap()
            .as_object()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn insert_image_is_atomic_on_file_collision_and_missing_file() {
    let mut board = board();
    let mut image = board.scene().element("element-7").unwrap().to_json();
    image["id"] = json!("new-image");
    image["fileId"] = json!("new-file");
    assert!(
        board
            .apply(
                Command::Insert {
                    elements: vec![image.clone()],
                    files: Default::default()
                },
                stamp()
            )
            .is_err()
    );
    assert_eq!(board.scene().serialize().unwrap(), INPUT);
    apply(
        &mut board,
        Command::Insert {
            elements: vec![image],
            files: serde_json::from_value(
                json!({"new-file":{"resourceId":"resource-123","unknown":true}}),
            )
            .unwrap(),
        },
    );
    assert_eq!(
        board.scene().field("files").unwrap()["new-file"]["resourceId"],
        "resource-123"
    );
    assert!(board.undo());
    assert_eq!(board.scene().serialize().unwrap(), INPUT);
}
#[test]
fn locked_elements_reject_changes_and_view_remains_persistent() {
    let mut board = board();
    select(&mut board, &["element-0"]);
    apply(&mut board, Command::Lock { locked: true });
    assert!(board.apply(Command::Delete, stamp()).is_err());
    apply(
        &mut board,
        Command::View {
            properties: serde_json::from_value(
                json!({"scrollX":33,"zoom":{"value":2,"future":true}}),
            )
            .unwrap(),
        },
    );
    assert_eq!(
        board.scene().field("appState").unwrap()["zoom"]["future"],
        true
    );
    apply(&mut board, Command::Lock { locked: false });
    apply(&mut board, Command::Delete);
}
#[test]
fn frame_membership_selection_and_undo() {
    let mut board = board();
    select(&mut board, &["element-0", "element-7"]);
    apply(
        &mut board,
        Command::Frame {
            id: Some("element-8".into()),
        },
    );
    select(&mut board, &["element-8"]);
    assert_eq!(board.selected_ids().len(), 3);
    apply(
        &mut board,
        Command::Translate {
            delta: Point::new(10.0, 20.0),
        },
    );
    assert_eq!(
        board
            .scene()
            .element("element-7")
            .unwrap()
            .geometry()
            .unwrap()
            .x(),
        220.0
    );
    assert!(board.undo());
    assert!(board.undo());
    assert_eq!(board.scene().serialize().unwrap(), INPUT);
}

fn normalized(scene: &Scene) -> Value {
    let mut value = scene.to_json();
    for element in value["elements"].as_array_mut().unwrap() {
        for key in ["version", "versionNonce", "updated", "index"] {
            element.as_object_mut().unwrap().remove(key);
        }
    }
    value
}
#[test]
fn upstream_action_sequence_matches_and_undo_redo_replays_every_state() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/rust-board/actions.json"
    ))
    .unwrap();
    let original = serde_json::to_string(&fixture["initial"]).unwrap();
    let mut board = Board::new(Scene::parse(&original).unwrap(), 128);
    let mut snapshots = vec![normalized(board.scene())];
    for step in fixture["steps"].as_array().unwrap() {
        let ids = step["selected"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| id.as_str().unwrap().to_owned());
        board.select(ids).unwrap();
        let command: Command = serde_json::from_value(step["command"].clone()).unwrap();
        let changed = board.apply(command, stamp()).unwrap();
        assert_json_matches(
            &normalized(board.scene()),
            &step["expected"],
            &step["action"].to_string(),
        );
        if changed {
            snapshots.push(normalized(board.scene()));
        }
    }
    for expected in snapshots.iter().rev().skip(1) {
        assert!(board.undo());
        assert_eq!(&normalized(board.scene()), expected);
    }
    assert!(!board.undo());
    assert_eq!(board.scene().serialize().unwrap(), original);
    for expected in snapshots.iter().skip(1) {
        assert!(board.redo());
        assert_eq!(&normalized(board.scene()), expected);
    }
    assert!(!board.redo());
}

fn assert_json_matches(actual: &Value, expected: &Value, path: &str) {
    match (actual, expected) {
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(
                a.keys().collect::<Vec<_>>(),
                b.keys().collect::<Vec<_>>(),
                "keys at {path}"
            );
            for (key, value) in a {
                assert_json_matches(value, &b[key], &format!("{path}/{key}"));
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "length at {path}");
            for (ix, (a, b)) in a.iter().zip(b).enumerate() {
                assert_json_matches(a, b, &format!("{path}/{ix}"));
            }
        }
        (Value::Number(a), Value::Number(b)) => {
            assert_eq!(a.as_f64(), b.as_f64(), "number at {path}")
        }
        _ => assert_eq!(actual, expected, "value at {path}"),
    }
}

#[test]
fn negative_path_points_rotate_about_their_actual_center() {
    let mut scene: Value = serde_json::from_str(INPUT).unwrap();
    scene["elements"][4]["points"] = json!([[0, 0], [-20, 10]]);
    scene["elements"][4]["angle"] = json!(std::f64::consts::PI);
    scene["elements"][4]["height"] = json!(10);
    let scene = Scene::from_json(scene).unwrap();
    let points = scene.element("element-4").unwrap().world_points().unwrap();
    assert!((points[0].x() - 100.0).abs() < 1e-10);
    assert!((points[0].y() - 20.0).abs() < 1e-10);
    assert!((points[1].x() - 120.0).abs() < 1e-10);
    assert!((points[1].y() - 10.0).abs() < 1e-10);
}

#[test]
fn unsupported_geometry_and_reference_conflicts_never_mutate_scene() {
    let mut board = board();
    let initial = board.scene().serialize().unwrap();
    for command in [
        Command::Geometry {
            id: "element-4".into(),
            geometry: Geometry::new(1.0, 2.0, 3.0, 4.0, 0.0).unwrap(),
        },
        Command::BindText {
            text: "element-3".into(),
            container: Some("element-7".into()),
        },
        Command::BindArrow {
            arrow: "element-5".into(),
            end: true,
            binding: Some(json!({"elementId":"missing","focus":0,"gap":1})),
        },
    ] {
        assert!(board.apply(command, stamp()).is_err());
        assert_eq!(board.scene().serialize().unwrap(), initial);
    }
}

#[test]
fn structural_order_keys_cross_base62_integer_boundaries() {
    let scene = Scene::from_json(json!({"elements":[],"files":{}})).unwrap();
    let mut board = Board::new(scene, 1);
    let template: Value = serde_json::from_str(INPUT).unwrap();
    let elements = (0..130)
        .map(|ix| {
            let mut value = template["elements"][0].clone();
            value["id"] = json!(format!("shape-{ix}"));
            value
        })
        .collect();
    apply(
        &mut board,
        Command::Insert {
            elements,
            files: Default::default(),
        },
    );
    let keys: Vec<_> = board
        .scene()
        .elements()
        .map(|e| e.field("index").unwrap().as_str().unwrap())
        .collect();
    assert_eq!(keys[0], "a0");
    assert_eq!(keys[61], "az");
    assert_eq!(keys[62], "b00");
    assert_eq!(keys[124], "b10");
    assert!(keys.windows(2).all(|pair| pair[0] < pair[1]));
}
