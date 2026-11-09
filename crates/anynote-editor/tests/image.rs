use anynote_editor::{history::HistoryBudget, image, model::Document, transaction::Editor};
const ID: &str = "10000000-0000-4000-8000-000000000001";
fn editor(source: &str) -> Editor {
    Editor::new(
        Document::new(source.into()),
        HistoryBudget::new(100, 1024 * 1024, 750),
    )
}
#[test]
fn standalone_images_resize_in_one_undo_and_preserve_neighbors() {
    let image = image::markdown(ID, "a [b] 🦀").unwrap();
    assert_eq!(image::parse(&image).unwrap().alt, "a [b] 🦀");
    let source = format!("before\r\n\r\n{image}\r\n\r\nafter  \r\n");
    let mut e = editor(&source);
    let id = e.document().blocks()[1].id();
    let tx = image::resize(e.document(), id, Some(320), 1).unwrap();
    e.apply(tx).unwrap();
    assert_eq!(e.undo_steps(), 1);
    assert!(
        e.document()
            .source()
            .starts_with("before\r\n\r\n:::anynote")
    );
    assert!(e.document().source().ends_with("\r\n\r\nafter  \r\n"));
    e.undo().unwrap();
    assert_eq!(e.document().source(), source);
    e.redo().unwrap();
    assert!(e.document().source().contains("\"width\":320"));
}
#[test]
fn directive_unknown_fields_attributes_and_large_numbers_survive_auto_width() {
    let source = format!(
        ":::anynote{{type=\"core.image\" version=\"1\" id=\"x\" future=\"yes\"}}\r\n{{\"resourceId\":\"{ID}\",\"width\":4096,\"title\":\"t\",\"future\":{{\"n\":900719925474099312345}}}}\r\n:::\r\n"
    );
    let mut e = editor(&source);
    let id = e.document().blocks()[0].id();
    let tx = image::resize(e.document(), id, None, 1).unwrap();
    e.apply(tx).unwrap();
    assert!(e.document().source().contains("future=\"yes\""));
    assert!(e.document().source().contains("900719925474099312345"));
    assert_eq!(image::parse(e.document().source()).unwrap().width, None);
    e.undo().unwrap();
    assert_eq!(e.document().source(), source);
}
#[test]
fn mixed_remote_future_or_invalid_width_remains_opaque() {
    assert!(image::parse(&format!("text ![x](anynote-resource:{ID})")).is_none());
    assert!(image::parse("![x](https://example.com/image.png)").is_none());
    for (version, width) in [
        ("2", "320"),
        ("1", "31"),
        ("1", "4097"),
        ("1", "1.5"),
        ("1", "null"),
    ] {
        let source = format!(
            ":::anynote{{type=\"core.image\" version=\"{version}\" id=\"x\"}}\n{{\"resourceId\":\"{ID}\",\"width\":{width}}}\n:::"
        );
        assert!(image::parse(&source).is_none(), "{source}");
    }
    let e = editor(&image::markdown(ID, "a").unwrap());
    let id = e.document().blocks()[0].id();
    assert!(image::resize(e.document(), id, Some(31), 1).is_err());
    assert!(image::resize(e.document(), id, Some(4097), 1).is_err());
}
