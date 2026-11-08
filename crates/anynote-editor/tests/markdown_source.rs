use anynote_core::protocol::{
    markdown::parse_blocks,
    rich::{Content, MarkdownNode, OpaqueReason, rich_blocks},
};
use anynote_editor::{
    model::{Document, SegmentKind},
    source::{SourceEdit, SourceError, newline_at},
};
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn corpus() -> Vec<Value> {
    serde_json::from_str(include_str!("../../../tests/fixtures/markdown/rm15.json")).unwrap()
}
fn body(fixture: &Value) -> String {
    fixture["parts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|part| {
            part["text"]
                .as_str()
                .unwrap()
                .repeat(part["repeat"].as_u64().unwrap() as usize)
        })
        .collect()
}
fn assert_coverage(doc: &Document) {
    let mut end = 0;
    let mut joined = String::new();
    let mut ids = BTreeSet::new();
    for segment in doc.segments() {
        let span = segment.span();
        assert_eq!(span.start, end);
        assert!(span.end <= doc.source().len());
        joined.push_str(&doc.source()[span.clone()]);
        end = span.end;
        if let SegmentKind::Block(id) = segment.kind() {
            assert!(ids.insert(*id));
            assert_eq!(doc.block(*id).unwrap().span(), span);
        }
    }
    assert_eq!(end, doc.source().len());
    assert_eq!(joined.as_bytes(), doc.source().as_bytes());
}

#[test]
fn shared_ts_corpus_matches_ranges_safety_and_directives() {
    let mut differences = Vec::new();
    for fixture in corpus() {
        let source = body(&fixture);
        let segments: Vec<_> = parse_blocks(&source)
            .iter()
            .map(|segment| {
                let span = segment.span();
                let mut value = json!({"start":span.start,"end":span.end});
                if let Some(directive) = segment.directive() {
                    value["attrs"] = json!(directive.attrs());
                    value["data"] = json!(directive.data());
                    value["validJson"] = json!(directive.data().is_some());
                }
                value
            })
            .collect();
        let blocks: Vec<_> = rich_blocks(&source).iter().map(|block| json!({
            "start":block.span().start,"end":block.span().end,"reason":block.reason().map(|reason| reason.as_str())
        })).collect();
        let actual = json!({"segments":segments,"blocks":blocks});
        if actual != fixture["expected"] {
            differences.push(
                json!({"name":fixture["name"],"actual":actual,"expected":fixture["expected"]}),
            );
        }
    }
    assert!(
        differences.is_empty(),
        "{}",
        serde_json::to_string_pretty(&differences).unwrap()
    );
}

#[test]
fn every_fixture_roundtrips_and_segments_cover_every_byte() {
    for fixture in corpus() {
        let source = body(&fixture);
        let doc = Document::new(source.clone());
        assert_eq!(
            doc.serialize().as_bytes(),
            source.as_bytes(),
            "{}",
            fixture["name"]
        );
        assert_coverage(&doc);
    }
}

#[test]
fn local_serialization_preserves_every_untouched_byte_and_ids() {
    let original = "\u{feff}# 标题\r\n\r\n普通 😀 文本\n\n[r]: /url\r\n\n尾段\r\n";
    let mut doc = Document::new(original.into());
    let ids: Vec<_> = doc.blocks().iter().map(|b| b.id()).collect();
    let start = original.find("普通").unwrap();
    let map = doc
        .replace_source(
            0,
            SourceEdit::new(start..start + "普通".len(), "普通", "新的正文"),
        )
        .unwrap();
    assert_eq!(&doc.source()[..start], &original[..start]);
    assert_eq!(
        &doc.source()[map.new_range().end..],
        &original[map.old_range().end..]
    );
    assert_eq!(doc.blocks().iter().map(|b| b.id()).collect::<Vec<_>>(), ids);
    assert_eq!(map.map_offset(original.len(), true), doc.source().len());
    assert_eq!(map.map_offset(start + 1, false), start);
    assert_eq!(map.map_offset(start + 1, true), map.new_range().end);
    assert_coverage(&doc);
}

#[test]
fn malformed_stale_and_non_scalar_ranges_never_mutate() {
    let mut doc = Document::new("😀 hello".into());
    for (generation, edit, error) in [
        (0, SourceEdit::new(1..4, "", "x"), SourceError::InvalidRange),
        (
            0,
            SourceEdit::new(0..999, "", "x"),
            SourceError::InvalidRange,
        ),
        (0, SourceEdit::new(0..4, "wrong", "x"), SourceError::Stale),
        (1, SourceEdit::new(0..4, "😀", "x"), SourceError::Stale),
    ] {
        assert_eq!(doc.replace_source(generation, edit), Err(error));
        assert_eq!(doc.source(), "😀 hello");
        assert_eq!(doc.generation(), 0);
    }
    assert_eq!(doc.source_offset(doc.blocks()[0].id(), 1), None);
    assert!(doc.block_positions(1).is_empty());
    assert_eq!(doc.source_offset(doc.blocks()[0].id(), 4), Some(4));
    let no_change = doc
        .replace_source(0, SourceEdit::new(0..4, "😀", "😀"))
        .unwrap();
    assert_eq!(no_change.map_offset(4, false), 4);
    assert_eq!(doc.generation(), 0);
}

#[test]
fn directive_field_update_preserves_future_json_numbers_attrs_resources_and_fences() {
    let original = "before\r\n\r\n:::anynote{type=\"future\" version=\"99\" future=\"keep\"}\r\n {\"width\":200,\"big\":900719925474099312345,\"decimal\":1.234567890123456789,\"nested\":{\"future\":[null,true,\"😀\"],\"resourceId\":\"11111111-1111-4111-8111-111111111111\"}} \r\n:::\r\nafter";
    let mut doc = Document::new(original.into());
    let block = doc
        .blocks()
        .iter()
        .find(|block| matches!(block.parsed().content(), Content::Directive(_)))
        .unwrap();
    let id = block.id();
    let Content::Directive(before) = block.parsed().content() else {
        unreachable!()
    };
    let payload = before.payload_span();
    let unknown = before.data().unwrap()["nested"].clone();
    doc.set_directive_field(0, id, "width", json!(200)).unwrap();
    assert_eq!(doc.source(), original);
    assert_eq!(doc.generation(), 0);
    let map = doc.set_directive_field(0, id, "width", json!(300)).unwrap();
    assert_eq!(&doc.source()[..payload.start], &original[..payload.start]);
    assert_eq!(
        &doc.source()[map.new_range().end..],
        &original[payload.end..]
    );
    let Content::Directive(after) = doc.block(id).unwrap().parsed().content() else {
        unreachable!()
    };
    assert_eq!(after.data().unwrap()["nested"], unknown);
    assert_eq!(after.data().unwrap()["width"], 300);
    assert!(doc.source().contains("900719925474099312345"));
    assert!(doc.source().contains("1.234567890123456789"));
    assert_coverage(&doc);
}

#[test]
fn invalid_json_rejects_field_edit_but_remains_source_editable() {
    let mut doc = Document::new(":::anynote{}\n{bad}\n:::\n".into());
    let id = doc.blocks()[0].id();
    assert_eq!(
        doc.set_directive_field(0, id, "x", json!(1)),
        Err(SourceError::InvalidDirective)
    );
    let start = doc.source().find("{bad}").unwrap();
    doc.replace_source(0, SourceEdit::new(start..start + 5, "{bad}", "{}"))
        .unwrap();
    doc.set_directive_field(1, id, "x", json!(1)).unwrap();
    assert!(doc.source().contains("\"x\":1"));
}

#[test]
fn references_are_reparsed_beyond_the_edited_block() {
    let mut doc = Document::new("[r]\n\n[r]: /one\n\nlast".into());
    let id = doc.blocks()[0].id();
    assert_eq!(
        doc.block(id).unwrap().parsed().reason(),
        Some(OpaqueReason::Reference)
    );
    let span = doc.blocks()[1].span();
    doc.replace_source(0, SourceEdit::new(span, "[r]: /one", "ordinary"))
        .unwrap();
    assert!(doc.block(id).unwrap().parsed().is_editable());
    assert_eq!(doc.source(), "[r]\n\nordinary\n\nlast");
}

#[test]
fn semantic_tree_keeps_marks_links_lists_tables_and_source_positions() {
    let source = "- [x] **中文** [link](/url)\n  - child\n\n| a | b |\n| - | - |\n| 1 | 2 |";
    let doc = Document::new(source.into());
    let Content::Markdown { node, source_base } = doc.blocks()[0].parsed().content() else {
        panic!("Markdown expected")
    };
    let MarkdownNode::List(list) = node.as_ref() else {
        panic!("list expected")
    };
    let MarkdownNode::ListItem(item) = &list.children[0] else {
        panic!("item expected")
    };
    assert_eq!(item.checked, Some(true));
    let mut stack = vec![node.as_ref()];
    let mut strong = false;
    let mut link = false;
    while let Some(node) = stack.pop() {
        let p = node.position().unwrap();
        assert!(
            source
                .get(source_base + p.start.offset..source_base + p.end.offset)
                .is_some()
        );
        if let MarkdownNode::Strong(_) = node {
            strong = true;
        }
        if let MarkdownNode::Link(link_node) = node {
            link = link_node.url == "/url";
        }
        if let Some(children) = node.children() {
            stack.extend(children);
        }
    }
    assert!(strong && link);
    assert!(
        matches!(doc.blocks()[1].parsed().content(), Content::Markdown {node, ..} if matches!(node.as_ref(), MarkdownNode::Table(_)))
    );
}

#[test]
fn generated_edits_preserve_prefix_suffix_coverage_and_unique_ids() {
    let mut seed = 15_u64;
    let mut doc = Document::new("\u{feff}# start\r\n\r\nhello 😀\n\nend\r\n".into());
    for _ in 0..200 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let original = doc.source().to_owned();
        let boundaries: Vec<_> = original
            .char_indices()
            .map(|(ix, _)| ix)
            .chain([original.len()])
            .collect();
        let at = seed as usize % boundaries.len();
        let end = (at + (seed >> 32) as usize % 3).min(boundaries.len() - 1);
        let range = boundaries[at]..boundaries[end];
        let replacement = ["x", "😀", "\r\n", "", "*a*"][seed as usize % 5];
        let map = doc
            .replace_source(
                doc.generation(),
                SourceEdit::new(range.clone(), &original[range.clone()], replacement),
            )
            .unwrap();
        assert_eq!(
            doc.source(),
            format!(
                "{}{}{}",
                &original[..range.start],
                replacement,
                &original[range.end..]
            )
        );
        assert_eq!(
            &doc.source()[..map.new_range().start],
            &original[..map.old_range().start]
        );
        assert_eq!(
            &doc.source()[map.new_range().end..],
            &original[map.old_range().end..]
        );
        assert_coverage(&doc);
    }
}

#[test]
fn new_text_uses_local_newline_without_rewriting_existing_lines() {
    let source = "first\r\nsecond\nlast";
    assert_eq!(newline_at(source, 2), Ok("\r\n"));
    assert_eq!(newline_at(source, 9), Ok("\n"));
    assert_eq!(newline_at("abc", 3), Ok("\n"));
    assert_eq!(newline_at("a\rb", 0), Ok("\r"));
    assert_eq!(newline_at("😀", 1), Err(SourceError::InvalidRange));
    assert_eq!(newline_at("x", 9), Err(SourceError::InvalidRange));
}

#[test]
fn boundary_insertions_keep_identity_and_new_blocks_never_reuse_it() {
    for at in [0, 5] {
        let mut doc = Document::new("hello\n\nhello".into());
        let first = doc.blocks()[0].id();
        let second = doc.blocks()[1].id();
        doc.replace_source(0, SourceEdit::new(at..at, "", "x"))
            .unwrap();
        assert_eq!(doc.blocks()[0].id(), first);
        assert_eq!(doc.blocks()[1].id(), second);
        assert_coverage(&doc);
    }
    let mut doc = Document::new("a".into());
    let first = doc.blocks()[0].id();
    doc.replace_source(0, SourceEdit::new(0..0, "", "b\n\n"))
        .unwrap();
    assert_ne!(doc.blocks()[0].id(), first);
    assert_eq!(doc.blocks()[1].id(), first);
    assert_coverage(&doc);
}

#[test]
fn rm01_frozen_markdown_corpus_preserves_original_bytes() {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!(
        "../../../tests/fixtures/rust-migration/corpus/markdown.json"
    ))
    .unwrap();
    for fixture in fixtures {
        let source = fixture["source"].as_str().unwrap();
        let doc = Document::new(source.into());
        assert_eq!(
            doc.serialize().as_bytes(),
            source.as_bytes(),
            "{}",
            fixture["id"]
        );
        assert_coverage(&doc);
    }
}

#[test]
fn unprojectable_json_is_preserved_and_cannot_be_replaced_by_an_empty_object() {
    for payload in [
        format!("{}0{}", "[".repeat(200), "]".repeat(200)),
        r#"{"future":"\ud800"}"#.into(),
    ] {
        let source = format!(":::anynote{{type=\"future\"}}\n{payload}\n:::\n");
        let mut doc = Document::new(source.clone());
        let id = doc.blocks()[0].id();
        assert_eq!(
            doc.set_directive_field(0, id, "width", json!(1)),
            Err(SourceError::InvalidDirective)
        );
        assert_eq!(doc.source(), source);
        assert_coverage(&doc);
    }
}
