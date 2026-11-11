use super::{assets, clipboard, input::stamp, text};
use anynote_editor::board::{Board, Command, Element, Point, Scene};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::json;
use std::{io::Cursor, sync::atomic::AtomicBool};

#[test]
fn clipboard_remaps_group_binding_and_file_ids_without_touching_originals() {
    let source = json!({"elements":[
        {"id":"shape","type":"rectangle","x":10,"y":20,"width":100,"height":50,"angle":0,"groupIds":["group"],"boundElements":[{"id":"text","type":"text"}],"customData":{"future":true}},
        {"id":"text","type":"text","x":10,"y":20,"width":100,"height":50,"angle":0,"groupIds":["group"],"containerId":"shape","text":"hello"},
        {"id":"image","type":"image","x":120,"y":20,"width":100,"height":50,"angle":0,"groupIds":["group"],"fileId":"shared"}],"files":{"shared":{"id":"shared","dataURL":"data:image/png;base64,AQID","future":42}}});
    let mut board = Board::new(Scene::from_json(source.clone()).unwrap(), 128);
    board.select(["shape".into()]).unwrap();
    let encoded = clipboard::copy(&board).unwrap();
    let command = clipboard::paste(&encoded, Point::new(300., 400.)).unwrap();
    board.apply(command, stamp()).unwrap();
    assert_eq!(board.scene().elements().len(), 6);
    let copies: Vec<_> = board
        .scene()
        .elements()
        .filter(|e| board.selected_ids().contains(e.id()))
        .collect();
    let shape = copies
        .iter()
        .find(|e| e.type_name() == "rectangle")
        .unwrap();
    let text = copies.iter().find(|e| e.type_name() == "text").unwrap();
    assert_ne!(shape.id(), "shape");
    assert_eq!(text.field("containerId").unwrap(), shape.id());
    assert_eq!(shape.field("boundElements").unwrap()[0]["id"], text.id());
    assert_eq!(shape.field("customData").unwrap(), &json!({"future":true}));
    let image = copies.iter().find(|e| e.type_name() == "image").unwrap();
    assert_ne!(image.field("fileId").unwrap(), "shared");
    assert_eq!(
        board.scene().field("files").unwrap()["shared"],
        source["files"]["shared"]
    );
    board.undo();
    assert_eq!(board.scene().to_json(), source);
}
#[test]
fn clipboard_rejects_non_board_and_missing_files() {
    assert!(clipboard::paste("plain text", Point::new(0., 0.)).is_err());
    let missing = json!({"type":"excalidraw/clipboard","elements":[{"id":"image","type":"image","x":0,"y":0,"width":10,"height":10,"angle":0,"fileId":"missing"}],"files":{}});
    assert!(clipboard::paste(&missing.to_string(), Point::new(0., 0.)).is_err());
    assert!(assets::decode_data_url("https://example.com/image.png").is_err());
    assert!(assets::decode_data_url("file:///tmp/image.png").is_err());
}
#[test]
fn native_text_uses_real_font_outlines_and_escapes_markup() {
    let element=Element::from_json(json!({"id":"t","type":"text","x":0,"y":0,"width":1,"height":1,"angle":0,"fontSize":24,"fontFamily":2})).unwrap();
    let layout = text::layout(&element, "中文 & <native>\n第二行").unwrap();
    assert!(layout.paths.len() >= 2);
    assert!(layout.width > 50.);
    assert_eq!(layout.height, 60.);
    let mut pixmap = resvg::tiny_skia::Pixmap::new(400, 80).unwrap();
    pixmap.fill(resvg::tiny_skia::Color::WHITE);
    let mut paint = resvg::tiny_skia::Paint::default();
    paint.set_color_rgba8(0, 0, 0, 255);
    for path in &layout.paths {
        pixmap.fill_path(
            path,
            &paint,
            resvg::tiny_skia::FillRule::Winding,
            resvg::tiny_skia::Transform::identity(),
            None,
        );
    }
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm23");
    std::fs::create_dir_all(&directory).unwrap();
    pixmap.save_png(directory.join("native-text.png")).unwrap();
}
#[test]
fn image_crop_flip_rotation_and_opacity_render_off_thread_inputs() {
    let mut source = image::RgbaImage::from_pixel(4, 2, image::Rgba([255, 0, 0, 255]));
    for y in 0..2 {
        for x in 2..4 {
            source.put_pixel(x, y, image::Rgba([0, 0, 255, 255]));
        }
    }
    let mut png = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(source)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let scene=Scene::from_json(json!({"elements":[{"id":"image","type":"image","x":20,"y":20,"width":200,"height":100,"angle":std::f64::consts::FRAC_PI_2,"opacity":50,"fileId":"f","scale":[-1,1],"crop":{"x":2,"y":0,"width":2,"height":2,"naturalWidth":4,"naturalHeight":2}}],"files":{"f":{"dataURL":format!("data:image/png;base64,{}",STANDARD.encode(png.into_inner()))}}})).unwrap();
    let assets = assets::Assets::load(&scene, &AtomicBool::new(false));
    assert!(assets.errors.is_empty(), "{:?}", assets.errors);
    let image = assets.images.get("image").unwrap();
    let size = image.size(0);
    let bytes = image.as_bytes(0).unwrap();
    let index = ((size.height.0 / 2 * size.width.0 + size.width.0 / 2) * 4) as usize;
    assert_eq!(&bytes[index..index + 4], &[255, 0, 0, 128]);
}
#[test]
fn moving_media_does_not_reload_but_text_changes_do() {
    let scene=Scene::from_json(json!({"elements":[{"id":"t","type":"text","x":10,"y":20,"width":80,"height":25,"angle":0,"text":"hello"}]})).unwrap();
    let mut board = Board::new(scene.clone(), 128);
    board.select(["t".into()]).unwrap();
    board
        .apply(
            Command::Translate {
                delta: Point::new(50., 50.),
            },
            stamp(),
        )
        .unwrap();
    assert!(assets::same_inputs(&scene, board.scene()));
    let g = board.scene().element("t").unwrap().geometry().unwrap();
    board
        .apply(
            Command::Text {
                id: "t".into(),
                text: "changed".into(),
                geometry: g,
            },
            stamp(),
        )
        .unwrap();
    assert!(!assets::same_inputs(&scene, board.scene()));
}

#[test]
fn clipboard_duplicate_in_editing_group_remaps_only_child_groups() {
    let mut board = Board::new(Scene::from_json(json!({"elements":[
        {"id":"a","type":"rectangle","x":0,"y":0,"width":10,"height":10,"angle":0,"groupIds":["child","parent"]},
        {"id":"b","type":"rectangle","x":20,"y":0,"width":10,"height":10,"angle":0,"groupIds":["child","parent"]},
        {"id":"c","type":"rectangle","x":40,"y":0,"width":10,"height":10,"angle":0,"groupIds":["parent"]}
    ]})).unwrap(), 8);
    board.edit_group(Some("parent".into())).unwrap();
    board.select(["a".into()]).unwrap();
    let before = board.scene().serialize().unwrap();
    let command = clipboard::duplicate(&board, Point::new(10.0, 10.0));
    board.apply(command, stamp()).unwrap();
    assert_eq!(board.selected_ids().len(), 2);
    for id in board.selected_ids() {
        let groups = board
            .scene()
            .element(id)
            .unwrap()
            .field("groupIds")
            .unwrap();
        assert_ne!(groups[0], "child");
        assert_eq!(groups[1], "parent");
    }
    assert!(board.undo());
    assert_eq!(board.scene().serialize().unwrap(), before);
}
