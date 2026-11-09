use anynote_editor::{builtin::*, history::HistoryBudget, model::Document, transaction::Editor};

#[test]
fn known_fields_keep_fences_versions_unknown_json_and_single_history() {
    let source = "before\r\n\r\n:::anynote{type=\"garden.reading.card\" version=\"1\" id=\"stable\" extra=\"keep\"}\r\n {\"quote\":\"old\",\"thought\":\"思考\",\"future\":{\"n\":900719925474099312345,\"resourceId\":\"keep\"}} \r\n:::\r\nafter";
    let document = Document::new(source.into());
    let id = document
        .blocks()
        .iter()
        .find_map(|b| BuiltinBlock::read(&document, b.id()).map(|_| b.id()))
        .unwrap();
    let mut editor = Editor::new(document, HistoryBudget::default());
    let tx = edit_fields(
        editor.document(),
        id,
        0,
        &[("quote", "新📚\n摘录".into()), ("thought", "更新".into())],
        1,
    )
    .unwrap();
    editor.apply(tx).unwrap();
    assert_eq!(editor.undo_steps(), 1);
    let output = editor.document().source();
    assert!(output.starts_with("before\r\n\r\n:::anynote{type=\"garden.reading.card\" version=\"1\" id=\"stable\" extra=\"keep\"}\r\n"));
    assert!(output.ends_with(" \r\n:::\r\nafter"));
    assert!(output.contains("900719925474099312345"));
    assert!(output.contains("resourceId"));
    assert!(edit_fields(editor.document(), id, 0, &[("quote", "stale".into())], 2).is_err());
    editor.undo().unwrap();
    assert_eq!(editor.document().source(), source);
    editor.redo().unwrap();
    assert_eq!(
        BuiltinBlock::read(editor.document(), id).unwrap().fields()[0].value(),
        "新📚\n摘录"
    );
}
#[test]
fn unknown_malformed_future_version_and_fields_remain_source_only() {
    for source in [
        ":::anynote{type=\"unknown.card\" version=\"1\"}\n{}\n:::\n",
        ":::anynote{type=\"garden.reading.card\" version=\"2\"}\n{}\n:::\n",
        ":::anynote{type=\"garden.reading.card\" version=\"1\"}\n{bad}\n:::\n",
        ":::anynote{type=\"garden.reading.card\" version=\"1\"}\n{\"quote\":42}\n:::\n",
    ] {
        let document = Document::new(source.into());
        assert!(BuiltinBlock::read(&document, document.blocks()[0].id()).is_none());
        assert_eq!(document.serialize(), source);
    }
    let document = Document::new(insert("core.details", "stable").unwrap());
    let id = document.blocks()[0].id();
    assert_eq!(
        BuiltinBlock::read(&document, id).unwrap().presentation(),
        Presentation::Details
    );
    assert!(edit_fields(&document, id, 0, &[("extra", "x".into())], 0).is_err());
    assert!(edit_fields(&document, id, 0, &[("body", "📚".repeat(1001))], 0).is_err());
}
#[test]
fn capture_cards_are_bounded_inert_and_explicitly_marked() {
    use anynote_editor::capture_card::parse;
    let source = include_str!("../../../tests/fixtures/import/rm07-chatgpt.md");
    assert!(parse(source).is_some());
    assert!(parse("<div>not marked</div>").is_none());
    assert!(parse("<div data-anynote-card=\"1\"><script>alert(1)</script></div>").is_none());
    assert!(
        parse("<div data-anynote-card=\"1\"><iframe src=\"https://example.com\"></iframe></div>")
            .is_none()
    );
    let card = parse("<div data-anynote-card=\"1\" onclick=\"run()\" style=\"background:url(https://secret);position:fixed;flex-direction:row\"><strong>safe &amp; text</strong></div>").unwrap();
    assert!(card.is_row());
    assert!(card.styles().is_empty());
    assert_eq!(card.children()[0].children()[0].text(), "safe & text");
    let deep = format!(
        "<div data-anynote-card=\"1\">{}x{}</div>",
        "<div>".repeat(33),
        "</div>".repeat(33)
    );
    assert!(parse(&deep).is_none());
}

#[test]
fn capture_styles_preserve_safe_visual_values_and_reject_active_css() {
    use anynote_editor::capture_card::{CardLength as L, CardStyle as S, parse};
    let card = parse("<div data-anynote-card=1 style='color:#1234;background-color:rgba(22,163,74,0.08);padding:1em 12px;max-width:100%;border:1px solid #dfe3ea;line-height:1.6;position:fixed;background:url(file:///secret);font-size:90000px;gap:NaNpx'></div>").unwrap();
    assert_eq!(
        card.styles(),
        &[
            S::Color("color", 0x11223344),
            S::Color("background", 0x16a34a14),
            S::Lengths("padding", vec![L::Em(1.), L::Pixels(12.)]),
            S::Lengths("max-width", vec![L::Fraction(1.)]),
            S::Border(1., 0xdfe3eaff),
            S::LineHeight(1.6),
        ]
    );
}
