use anynote_editor::{
    history::HistoryBudget,
    inline::{Format, InlineContent, Link, Mark, Marks},
    model::{Document, SegmentKind},
    selection::{
        Affinity, Position, Selection, TextRange, TextUnit, byte_offset, byte_range,
        deletion_range, offset_from_byte,
    },
    source::SourceError,
    transaction::{EditError, EditKind, Editor, Patch, Transaction},
};
use std::collections::BTreeSet;
use unicode_segmentation::UnicodeSegmentation;

fn editor(text: &str) -> Editor {
    Editor::new(Document::new(text.into()), HistoryBudget::default())
}
fn generation(editor: &Editor) -> u64 {
    editor.document().generation()
}
fn replace(
    editor: &mut Editor,
    range: std::ops::Range<usize>,
    text: &str,
    kind: EditKind,
    millis: u64,
) {
    editor
        .replace(
            TextRange::new(generation(editor), range, TextUnit::Utf8),
            text,
            kind,
            millis,
        )
        .unwrap();
}
fn inline(editor: &Editor) -> InlineContent {
    InlineContent::for_block(editor.document(), editor.document().blocks()[0].id())
        .unwrap()
        .remove(0)
}
fn invariant(editor: &Editor) {
    let doc = editor.document();
    editor.selection().validate(doc).unwrap();
    let mut end = 0;
    let mut ids = BTreeSet::new();
    for segment in doc.segments() {
        assert_eq!(segment.span().start, end);
        end = segment.span().end;
        assert!(doc.source().is_char_boundary(end));
        if let SegmentKind::Block(id) = segment.kind() {
            assert!(ids.insert(*id));
            assert_eq!(doc.block(*id).unwrap().span(), segment.span());
        }
    }
    assert_eq!(end, doc.source().len());
    for point in [editor.selection().anchor(), editor.selection().head()] {
        if let Some((id, local)) = point.block_position(doc) {
            assert_eq!(doc.source_offset(id, local), Some(point.offset()));
        }
    }
}

#[test]
fn unicode_coordinates_are_exact_and_grapheme_deletes_are_whole() {
    let text = "a😀e\u{301}👩‍👩‍👧‍👦🇨🇳\r\nz";
    for (ix, (byte, _)) in text.grapheme_indices(true).enumerate() {
        assert_eq!(byte_offset(text, ix, TextUnit::Grapheme), Ok(byte));
        assert_eq!(offset_from_byte(text, byte, TextUnit::Grapheme), Ok(ix));
        let utf16 = offset_from_byte(text, byte, TextUnit::Utf16).unwrap();
        assert_eq!(byte_offset(text, utf16, TextUnit::Utf16), Ok(byte));
        let next = byte_offset(text, ix + 1, TextUnit::Grapheme).unwrap();
        assert_eq!(deletion_range(text, byte, false), Ok(byte..next));
        assert_eq!(deletion_range(text, next, true), Ok(byte..next));
    }
    assert!(byte_offset(text, 2, TextUnit::Utf8).is_err());
    assert!(byte_offset(text, 2, TextUnit::Utf16).is_err());
    assert!(offset_from_byte(text, 6, TextUnit::Grapheme).is_err());
    assert!(deletion_range(text, 6, true).is_err());
    assert!(byte_range(text, std::ops::Range { start: 8, end: 2 }, TextUnit::Utf8).is_err());
    assert!(byte_offset(text, usize::MAX, TextUnit::Utf16).is_err());
    assert_eq!(byte_offset("", 0, TextUnit::Grapheme), Ok(0));
}

#[test]
fn atomic_multi_patch_maps_reverse_selection_and_preserves_outside_bytes() {
    let original = "\u{feff}first\r\n\r\n中文😀 tail\r\n\r\nlast\r\n";
    let mut e = editor(original);
    let first = original.find("first").unwrap();
    let last = original.find("last").unwrap();
    let middle_id = e.document().blocks()[1].id();
    let anchor = Position::new(last + 4, Affinity::After);
    let head = Position::new(first, Affinity::Before);
    e.set_selection(Selection::new(0, anchor, head)).unwrap();
    let before = e.selection();
    let result = e
        .apply(Transaction::new(
            0,
            vec![
                Patch::new(first..first + 5, "first", "首"),
                Patch::new(last..last + 4, "last", "末尾"),
            ],
            EditKind::Paste,
            1,
        ))
        .unwrap();
    assert_eq!(generation(&e), 1);
    assert_eq!(result.changes().len(), 2);
    assert_eq!(
        e.document().source(),
        original.replace("first", "首").replace("last", "末尾")
    );
    assert_eq!(e.document().blocks()[1].id(), middle_id);
    assert_eq!(e.selection().head(), head);
    assert_eq!(
        e.selection().anchor().offset(),
        e.document().source().len() - 2
    );
    assert!(e.undo().unwrap());
    assert_eq!(e.document().source(), original);
    assert_eq!(e.selection().anchor(), before.anchor());
    assert_eq!(e.selection().head(), before.head());
    assert!(e.redo().unwrap());
    invariant(&e);
}

#[test]
fn invalid_batches_and_selections_leave_source_history_generation_and_redo_unchanged() {
    let mut e = editor("a😀bc");
    replace(&mut e, 0..1, "z", EditKind::Source, 0);
    e.undo().unwrap();
    let old = (
        e.document().source().to_owned(),
        generation(&e),
        e.selection(),
        e.history_bytes(),
        e.redo_steps(),
    );
    let bad = vec![
        Transaction::new(0, vec![], EditKind::Source, 0),
        Transaction::new(
            generation(&e),
            vec![Patch::new(0..1, "a", "x"), Patch::new(5..6, "wrong", "y")],
            EditKind::Source,
            0,
        ),
        Transaction::new(
            generation(&e),
            vec![Patch::new(0..1, "a", "x"), Patch::new(2..3, "", "y")],
            EditKind::Source,
            0,
        ),
        Transaction::new(
            generation(&e),
            vec![Patch::new(0..5, "a😀", "x"), Patch::new(1..5, "😀", "y")],
            EditKind::Source,
            0,
        ),
        Transaction::new(
            generation(&e),
            vec![Patch::new(0..1, "a", "x")],
            EditKind::Source,
            0,
        )
        .with_selection(Selection::caret(generation(&e), 200)),
        Transaction::new(
            generation(&e),
            vec![Patch::new(0..1, "a", "x")],
            EditKind::Source,
            0,
        )
        .with_selection(Selection::caret(0, 0)),
    ];
    for transaction in bad {
        assert!(e.apply(transaction).is_err());
        assert_eq!(
            (
                e.document().source().to_owned(),
                generation(&e),
                e.selection(),
                e.history_bytes(),
                e.redo_steps()
            ),
            old
        );
    }
    assert!(
        e.set_selection(Selection::caret(generation(&e), 2))
            .is_err()
    );
    assert!(e.redo().unwrap());
    assert_eq!(e.document().source(), "z😀bc");
}

#[test]
fn affinity_at_insertions_is_explicit_and_block_positions_resolve() {
    let mut e = editor("ab");
    let block = e.document().blocks()[0].id();
    let before = Position::from_block(e.document(), block, 1, Affinity::Before).unwrap();
    let after = Position::from_block(e.document(), block, 1, Affinity::After).unwrap();
    e.set_selection(Selection::new(0, before, after)).unwrap();
    e.apply(Transaction::new(
        0,
        vec![Patch::new(1..1, "", "😀")],
        EditKind::Source,
        0,
    ))
    .unwrap();
    assert_eq!(e.selection().anchor().offset(), 1);
    assert_eq!(e.selection().head().offset(), 5);
    invariant(&e);
}

#[test]
fn typing_delete_merging_respects_time_cursor_block_and_command_boundaries() {
    let mut e = editor("x");
    e.set_selection(Selection::caret(0, 1)).unwrap();
    replace(&mut e, 1..1, "a", EditKind::Typing, 10);
    replace(&mut e, 2..2, "😀", EditKind::Typing, 20);
    assert_eq!(e.undo_steps(), 1);
    e.undo().unwrap();
    assert_eq!(e.document().source(), "x");
    e.redo().unwrap();
    assert_eq!(e.document().source(), "xa😀");
    replace(&mut e, 6..6, "z", EditKind::Typing, 30);
    assert_eq!(e.undo_steps(), 2); // undo/redo ends the previous group
    replace(&mut e, 7..7, "q", EditKind::Typing, 1000);
    assert_eq!(e.undo_steps(), 3);
    e.set_selection(e.selection()).unwrap();
    replace(&mut e, 8..8, "r", EditKind::Typing, 1001);
    assert_eq!(e.undo_steps(), 4);
    replace(&mut e, 9..9, "!", EditKind::Paste, 1002);
    replace(&mut e, 10..10, "s", EditKind::Typing, 1003);
    assert_eq!(e.undo_steps(), 6);
    replace(&mut e, 10..11, "", EditKind::BackwardDelete, 1004);
    replace(&mut e, 9..10, "", EditKind::BackwardDelete, 1005);
    assert_eq!(e.undo_steps(), 7);
    e.undo().unwrap();
    assert!(e.document().source().ends_with("!s"));
    let mut e = editor("abcdef");
    replace(&mut e, 0..1, "", EditKind::ForwardDelete, 1);
    replace(&mut e, 0..1, "", EditKind::ForwardDelete, 2);
    assert_eq!(e.undo_steps(), 1);
    e.undo().unwrap();
    assert_eq!(e.document().source(), "abcdef");
    let mut e = editor("a\n\nb");
    replace(&mut e, 1..1, "x", EditKind::Typing, 1);
    replace(&mut e, 5..5, "y", EditKind::Typing, 2);
    assert_eq!(e.undo_steps(), 2);
}

#[test]
fn history_limits_drop_old_steps_never_body_and_new_input_invalidates_redo() {
    let original = "x".repeat(200_000);
    let mut e = Editor::new(
        Document::new(original.clone()),
        HistoryBudget::new(2, 4096, 0),
    );
    for ix in 0..4 {
        replace(&mut e, ix..ix, "z", EditKind::Paste, ix as u64);
    }
    assert_eq!(e.undo_steps(), 2);
    assert!(e.history_bytes() < 4096);
    let text = e.document().source().to_owned();
    e.undo().unwrap();
    e.undo().unwrap();
    assert!(!e.undo().unwrap());
    assert_eq!(e.document().source().len(), original.len() + 2);
    e.redo().unwrap();
    e.redo().unwrap();
    assert_eq!(e.document().source(), text);
    e.undo().unwrap();
    replace(&mut e, 0..0, "new", EditKind::Typing, 10);
    assert!(!e.redo().unwrap());
    let big = "😀".repeat(20_000);
    replace(&mut e, 0..0, &big, EditKind::Paste, 11);
    assert_eq!(e.undo_steps(), 0);
    assert!(e.document().source().starts_with(&big));
    let mut e = Editor::new(Document::new("a".into()), HistoryBudget::new(0, 0, 0));
    replace(&mut e, 1..1, "b", EditKind::Typing, 0);
    assert_eq!(e.document().source(), "ab");
    assert!(!e.undo().unwrap());
}

#[test]
fn composition_is_ephemeral_cancel_preserves_redo_and_commit_is_one_step() {
    let mut e = editor("a😀z");
    replace(&mut e, 0..1, "b", EditKind::Source, 0);
    e.undo().unwrap();
    let before = e.selection();
    let revision = generation(&e);
    let token = e
        .begin_composition(revision, 1..3, TextUnit::Utf16)
        .unwrap();
    for text in ["n", "ni", "你", "你好👩‍💻"] {
        let length = text.encode_utf16().count();
        e.update_composition(token, text.into(), length..length, TextUnit::Utf16)
            .unwrap();
        assert_eq!(e.document().serialize(), "a😀z");
        assert_eq!(generation(&e), revision);
    }
    assert_eq!(e.display_source(), "a你好👩‍💻z");
    assert_eq!(e.redo_steps(), 1);
    assert_eq!(e.undo(), Err(EditError::CompositionActive));
    assert!(
        e.replace(
            TextRange::new(revision, 0..0, TextUnit::Utf8),
            "oops",
            EditKind::Typing,
            0
        )
        .is_err()
    );
    assert!(e.set_selection(before).is_err());
    assert!(e.begin_composition(revision, 0..0, TextUnit::Utf8).is_err());
    assert!(
        e.update_composition(token, "😀".into(), 1..1, TextUnit::Utf16)
            .is_err()
    );
    assert_eq!(e.display_source(), "a你好👩‍💻z");
    e.cancel_composition(token).unwrap();
    assert_eq!(e.selection(), before);
    assert_eq!(generation(&e), revision);
    assert_eq!(e.redo_steps(), 1);
    let new_token = e
        .begin_composition(revision, 1..3, TextUnit::Utf16)
        .unwrap();
    assert_eq!(
        e.commit_composition(token, Some("bad"), 0).unwrap_err(),
        EditError::StaleComposition
    );
    e.update_composition(new_token, "你".into(), 3..3, TextUnit::Utf8)
        .unwrap();
    e.commit_composition(new_token, Some("你好"), 1).unwrap();
    assert_eq!(e.document().source(), "a你好z");
    assert_eq!(generation(&e), revision + 1);
    assert_eq!(e.undo_steps(), 1);
    assert_eq!(e.redo_steps(), 0);
    assert!(e.commit_composition(new_token, Some("你好"), 2).is_err());
    e.undo().unwrap();
    assert_eq!(e.document().source(), "a😀z");
    assert_eq!(e.selection().head(), before.head());
    e.redo().unwrap();
    assert_eq!(e.document().source(), "a你好z");
    invariant(&e);
}

#[test]
fn composition_empty_commit_deletes_selection_and_noop_commit_preserves_history() {
    let mut e = editor("abc");
    let token = e.begin_composition(0, 1..2, TextUnit::Utf8).unwrap();
    e.commit_composition(token, Some(""), 0).unwrap();
    assert_eq!(e.document().source(), "ac");
    e.undo().unwrap();
    let g = generation(&e);
    let token = e.begin_composition(g, 1..2, TextUnit::Utf8).unwrap();
    let result = e.commit_composition(token, Some("b"), 0).unwrap();
    assert!(!result.is_changed());
    assert_eq!(generation(&e), g);
    assert_eq!(e.redo_steps(), 1);
}

#[test]
fn marks_partial_removal_nested_styles_and_links_roundtrip_through_one_history() {
    let source = "\u{feff}# a **bold** and *soft* 中文\r\n\r\n::: anynote future\r\n{\"keep\":true}\r\n:::\r\n";
    let mut e = editor(source);
    let text = inline(&e).text();
    for format in [
        Format::Mark(Mark::Strong, true),
        Format::Mark(Mark::Emphasis, true),
        Format::Mark(Mark::Strike, true),
    ] {
        let transaction = inline(&e)
            .format(0..text.len(), TextUnit::Utf8, format, 1)
            .unwrap();
        e.apply(transaction).unwrap();
        assert_eq!(inline(&e).text(), text);
        assert!(
            e.document()
                .source()
                .ends_with("\r\n\r\n::: anynote future\r\n{\"keep\":true}\r\n:::\r\n")
        );
    }
    let start = text.find("bold").unwrap();
    let transaction = inline(&e)
        .format(
            start + 1..start + 3,
            TextUnit::Utf8,
            Format::Mark(Mark::Strong, false),
            2,
        )
        .unwrap();
    e.apply(transaction).unwrap();
    assert!(
        inline(&e)
            .runs()
            .iter()
            .any(|run| run.text() == "ol" && !run.marks().has(Mark::Strong))
    );
    let link = Link::new(
        "anynote://notebook/note?a=1&b=2".into(),
        Some("a \"title\"".into()),
    )
    .unwrap();
    let transaction = inline(&e)
        .format(
            start..start + 4,
            TextUnit::Utf8,
            Format::Link(Some(link.clone())),
            3,
        )
        .unwrap();
    e.apply(transaction).unwrap();
    assert!(
        inline(&e)
            .runs()
            .iter()
            .any(|run| run.marks().link() == Some(&link))
    );
    let transaction = inline(&e)
        .format(start..start + 4, TextUnit::Utf8, Format::Link(None), 4)
        .unwrap();
    e.apply(transaction).unwrap();
    let final_source = e.document().source().to_owned();
    while e.undo().unwrap() {}
    assert_eq!(e.document().source(), source);
    while e.redo().unwrap() {}
    assert_eq!(e.document().source(), final_source);
    invariant(&e);
}

#[test]
fn rich_literal_punctuation_code_fences_and_utf16_ranges_preserve_semantics() {
    let mut e = editor("hello 😀 world");
    let transaction = inline(&e)
        .replace(
            6..8,
            TextUnit::Utf16,
            "*[x] & | <tag> `code`",
            Marks::default(),
            0,
        )
        .unwrap();
    e.apply(transaction).unwrap();
    assert_eq!(inline(&e).text(), "hello *[x] & | <tag> `code` world");
    for text in ["a`b", "``foo``", " a ", "   ", "a|b", "😀e\u{301}"] {
        let mut e = editor("before after");
        let transaction = inline(&e)
            .replace(0..6, TextUnit::Utf8, text, Marks::default(), 0)
            .unwrap();
        e.apply(transaction).unwrap();
        let transaction = inline(&e)
            .format(
                0..text.len(),
                TextUnit::Utf8,
                Format::Mark(Mark::Code, true),
                1,
            )
            .unwrap();
        e.apply(transaction).unwrap();
        assert_eq!(inline(&e).text(), format!("{text} after"));
        assert!(inline(&e).runs()[0].marks().has(Mark::Code));
        e.undo().unwrap();
        e.undo().unwrap();
        assert_eq!(e.document().source(), "before after");
    }
    assert!(Link::new("javascript:alert(1)".into(), None).is_err());
    assert!(Link::new("http://bad\nurl".into(), None).is_err());
}

#[test]
fn inline_targets_work_inside_lists_quotes_tables_and_keep_other_cells_bytes() {
    for source in [
        "- first\n- second\n",
        "> first\n> second\n",
        "| first | second |\n| --- | --- |\n| a | b |\n",
    ] {
        let mut e = editor(source);
        let content = inline(&e);
        let span = content.span();
        let text = content.text();
        let transaction = content
            .format(
                0..5,
                TextUnit::Grapheme,
                Format::Mark(Mark::Strong, true),
                0,
            )
            .unwrap();
        e.apply(transaction).unwrap();
        assert!(e.document().source().starts_with(&source[..span.start]));
        assert!(e.document().source().ends_with(&source[span.end..]));
        assert_eq!(inline(&e).text(), text);
        e.undo().unwrap();
        assert_eq!(e.document().source(), source);
    }
}

#[test]
fn stale_inline_projection_cannot_overwrite_subsequent_source_edits() {
    let mut e = editor("text");
    let transaction = inline(&e)
        .format(0..4, TextUnit::Utf8, Format::Mark(Mark::Strong, true), 0)
        .unwrap();
    replace(&mut e, 4..4, "!", EditKind::Typing, 1);
    assert_eq!(
        e.apply(transaction).unwrap_err(),
        EditError::Source(SourceError::Stale)
    );
    assert_eq!(e.document().source(), "text!");
    assert_eq!(e.undo_steps(), 1);
    let e = editor("[opaque][ref]\n\n[ref]: https://example.test\n");
    assert!(InlineContent::for_block(e.document(), e.document().blocks()[0].id()).is_err());
}

#[test]
fn fixed_seed_unicode_edits_replay_source_selection_and_structural_invariants() {
    let original = "\u{feff}# 标题\r\n\r\nemoji 👩‍💻 e\u{301}\r\n\r\n::: anynote future\r\n{\"asset\":\"anynote-resource:keep\"}\r\n:::\r\n";
    for seed in [0x16a11u64, 0xc0ffee, 0xdeadbeef] {
        let mut random = seed;
        let mut e = Editor::new(
            Document::new(original.into()),
            HistoryBudget::new(2000, 8_000_000, 750),
        );
        let mut snapshots = Vec::new();
        for step in 0..300 {
            random = random
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let source = e.document().source();
            let positions: Vec<_> = source
                .grapheme_indices(true)
                .map(|(at, _)| at)
                .chain(std::iter::once(source.len()))
                .collect();
            let a = (random as usize) % positions.len();
            let b = ((random >> 32) as usize) % positions.len();
            let range = positions[a.min(b)]..positions[a.max(b)];
            let text = ["中文", "😀", "e\u{301}", "👩‍👩‍👧‍👦", "\r\n", "**", "", "x"][step % 8];
            let before = (source.to_owned(), e.selection());
            let mut expected = before.0.clone();
            expected.replace_range(range.clone(), text);
            if step % 5 == 0 {
                let token = e
                    .begin_composition(generation(&e), range.clone(), TextUnit::Utf8)
                    .unwrap();
                e.update_composition(token, text.into(), text.len()..text.len(), TextUnit::Utf8)
                    .unwrap();
                if step % 10 == 0 {
                    e.cancel_composition(token).unwrap();
                    assert_eq!(e.document().source(), before.0);
                    continue;
                }
                e.commit_composition(token, None, step as u64).unwrap();
            } else {
                replace(&mut e, range, text, EditKind::Source, step as u64);
            }
            assert_eq!(e.document().source(), expected, "seed {seed} step {step}");
            if e.document().source() != before.0 {
                snapshots.push((before, (e.document().source().to_owned(), e.selection())));
            }
            invariant(&e);
        }
        for (before, _) in snapshots.iter().rev() {
            assert!(e.undo().unwrap(), "seed {seed}");
            assert_eq!(e.document().source(), before.0, "seed {seed}");
            assert_eq!(e.selection().anchor(), before.1.anchor());
            assert_eq!(e.selection().head(), before.1.head());
            invariant(&e);
        }
        assert_eq!(e.document().source(), original);
        assert!(!e.undo().unwrap());
        for (_, after) in &snapshots {
            assert!(e.redo().unwrap());
            assert_eq!(e.document().source(), after.0, "seed {seed}");
            assert_eq!(e.selection().anchor(), after.1.anchor());
            assert_eq!(e.selection().head(), after.1.head());
            invariant(&e);
        }
        assert!(!e.redo().unwrap());
    }
}

#[test]
fn fixed_seed_overlapping_marks_and_links_keep_text_and_replay_exact_source() {
    let source = "ASCII中文😀e\u{301} words `punct`";
    let mut e = Editor::new(
        Document::new(source.into()),
        HistoryBudget::new(1000, 8_000_000, 750),
    );
    let text = inline(&e).text();
    let count = text.graphemes(true).count();
    let mut random = 0x16f04a7u64;
    for step in 0..240 {
        random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
        let start = random as usize % count;
        let end = start + 1 + ((random >> 32) as usize % (count - start));
        let enabled = step % 3 != 0;
        let format = match step % 5 {
            0 => Format::Mark(Mark::Strong, enabled),
            1 => Format::Mark(Mark::Emphasis, enabled),
            2 => Format::Mark(Mark::Strike, enabled),
            3 => Format::Mark(Mark::Code, enabled),
            _ => Format::Link(
                enabled
                    .then(|| Link::new("https://example.test/a_(b)?x=1&y=2".into(), None).unwrap()),
            ),
        };
        let transaction = inline(&e)
            .format(start..end, TextUnit::Grapheme, format, step)
            .unwrap_or_else(|err| panic!("step {step} {start}..{end}: {err:?}"));
        e.apply(transaction).unwrap();
        assert_eq!(inline(&e).text(), text, "step {step}");
        invariant(&e);
    }
    let final_source = e.document().source().to_owned();
    while e.undo().unwrap() {}
    assert_eq!(e.document().source(), source);
    while e.redo().unwrap() {}
    assert_eq!(e.document().source(), final_source);
}

#[test]
fn format_noop_keeps_original_spelling_and_hard_breaks_keep_crlf() {
    let original = "**bold** and text  \r\nnext\r\n";
    let mut e = editor(original);
    let transaction = inline(&e)
        .format(0..4, TextUnit::Utf8, Format::Mark(Mark::Strong, true), 0)
        .unwrap();
    assert!(!e.apply(transaction).unwrap().is_changed());
    assert_eq!(e.document().source(), original);
    assert_eq!(generation(&e), 0);
    assert_eq!(e.undo_steps(), 0);
    let text = inline(&e).text();
    let transaction = inline(&e)
        .format(
            0..text.len(),
            TextUnit::Utf8,
            Format::Mark(Mark::Emphasis, true),
            0,
        )
        .unwrap();
    e.apply(transaction).unwrap();
    assert_eq!(inline(&e).text(), text);
    assert!(e.document().source().contains("\\\r\n"));
    e.undo().unwrap();
    assert_eq!(e.document().source(), original);
}

#[test]
fn table_code_and_link_pipe_are_encoded_without_changing_cell_structure() {
    let original = "| left | right |\n| --- | --- |\n| a | b |\n";
    let mut e = editor(original);
    let transaction = inline(&e)
        .replace(0..4, TextUnit::Utf8, "a|b", Marks::default(), 0)
        .unwrap();
    e.apply(transaction).unwrap();
    let transaction = inline(&e)
        .format(0..3, TextUnit::Utf8, Format::Mark(Mark::Code, true), 1)
        .unwrap();
    e.apply(transaction).unwrap();
    assert_eq!(inline(&e).text(), "a|b");
    let link = Link::new("https://example.test/a|b".into(), Some("left|right".into())).unwrap();
    let transaction = inline(&e)
        .format(0..3, TextUnit::Utf8, Format::Link(Some(link)), 2)
        .unwrap();
    e.apply(transaction).unwrap();
    let cells = InlineContent::for_block(e.document(), e.document().blocks()[0].id()).unwrap();
    assert_eq!(
        cells.iter().map(|cell| cell.text()).collect::<Vec<_>>(),
        ["a|b", "right", "a", "b"]
    );
    while e.undo().unwrap() {}
    assert_eq!(e.document().source(), original);
}

#[test]
fn rich_composition_commits_literal_syntax_once_and_failed_commit_keeps_preedit() {
    let mut e = editor("hello 😀");
    let frozen = inline(&e);
    let token = e.begin_composition(0, 6..10, TextUnit::Utf8).unwrap();
    e.update_composition(token, "**你好**".into(), 10..10, TextUnit::Utf8)
        .unwrap();
    let invalid = Transaction::new(
        0,
        vec![Patch::new(0..1, "wrong", "bad")],
        EditKind::Source,
        0,
    );
    assert!(e.commit_composition_transaction(token, invalid).is_err());
    assert!(e.composition().is_some());
    assert_eq!(e.document().source(), "hello 😀");
    let transaction = frozen
        .replace(6..8, TextUnit::Utf16, "**你好**", Marks::default(), 0)
        .unwrap();
    e.commit_composition_transaction(token, transaction)
        .unwrap();
    assert!(e.composition().is_none());
    assert_eq!(e.undo_steps(), 1);
    assert_eq!(inline(&e).text(), "hello **你好**");
    assert!(
        !inline(&e)
            .runs()
            .iter()
            .any(|run| run.marks().has(Mark::Strong))
    );
    e.undo().unwrap();
    assert_eq!(e.document().source(), "hello 😀");
}
