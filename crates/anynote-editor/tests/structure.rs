use anynote_editor::{
    history::HistoryBudget,
    inline::{Mark, Marks},
    model::Document,
    selection::{Selection, TextRange, TextUnit},
    structure::{
        BlockSide, CellAddress, CellDirection, ListStyle, NodeKind, Structure, StructureError,
        atom_position, block_selection, delete_blocks, move_blocks, paste_blocks,
    },
    transaction::{EditKind, Editor, Transaction},
};

fn editor(source: &str) -> Editor {
    Editor::new(
        Document::new(source.into()),
        HistoryBudget::new(2000, 8 * 1024 * 1024, 750),
    )
}
fn structure(e: &Editor) -> Structure<'_> {
    Structure::for_block(e.document(), e.document().blocks()[0].id()).unwrap()
}
fn apply(e: &mut Editor, transaction: Transaction) {
    e.apply(transaction).unwrap();
    e.selection().validate(e.document()).unwrap();
}
fn undo_all(e: &mut Editor, original: &str) {
    let final_source = e.document().source().to_owned();
    let final_selection = e.selection();
    let count = e.undo_steps();
    for _ in 0..count {
        assert!(e.undo().unwrap());
        e.selection().validate(e.document()).unwrap();
    }
    assert_eq!(e.document().source(), original);
    for _ in 0..count {
        assert!(e.redo().unwrap());
        e.selection().validate(e.document()).unwrap();
    }
    assert_eq!(e.document().source(), final_source);
    assert_eq!(e.selection().head(), final_selection.head());
}

#[test]
fn split_join_marks_unicode_and_crlf_restore_exact_source() {
    let source = "# **中文😀 tail**\r\n\r\nuntouched  \r\n";
    let mut e = editor(source);
    let tail = e.document().blocks()[1].id();
    let t = structure(&e).split(&[0], 4, TextUnit::Utf16, 1).unwrap();
    apply(&mut e, t);
    assert_eq!(e.document().blocks().len(), 3);
    assert_eq!(structure(&e).root().node(&[0]).unwrap().text(), "中文😀");
    assert_eq!(e.document().blocks()[2].id(), tail);
    assert!(e.document().source().ends_with("\r\n\r\nuntouched  \r\n"));
    let s = Structure::for_blocks(
        e.document(),
        e.document().blocks()[0].id(),
        e.document().blocks()[1].id(),
    )
    .unwrap();
    let t = s.join(&[1], 2).unwrap();
    apply(&mut e, t);
    assert_eq!(
        structure(&e).root().node(&[0]).unwrap().text(),
        "中文😀 tail"
    );
    assert!(
        structure(&e).root().node(&[0]).unwrap().runs()[0]
            .marks()
            .has(Mark::Strong)
    );
    undo_all(&mut e, source);
}

#[test]
fn list_split_resets_task_and_keeps_nested_contents() {
    let source = "- [x] **one two**\n  - child\n- [ ] next";
    let mut e = editor(source);
    let t = structure(&e)
        .split(&[0, 0, 0], 3, TextUnit::Utf8, 0)
        .unwrap();
    apply(&mut e, t);
    let s = structure(&e);
    let list = s.root().node(&[0]).unwrap();
    assert_eq!(list.children().len(), 3);
    assert_eq!(
        list.children()[0].kind(),
        &NodeKind::Item {
            checked: Some(true)
        }
    );
    assert_eq!(
        list.children()[1].kind(),
        &NodeKind::Item {
            checked: Some(false)
        }
    );
    assert_eq!(list.children()[1].children()[0].text(), " two");
    assert_eq!(
        list.children()[1].children()[1].children()[0].children()[0].text(),
        "child"
    );
    let t = s.join(&[0, 1], 1).unwrap();
    apply(&mut e, t);
    assert_eq!(
        structure(&e).root().node(&[0, 0, 0]).unwrap().text(),
        "one two"
    );
    undo_all(&mut e, source);
}

#[test]
fn nested_list_indent_lift_and_top_level_exit() {
    let source = "1. first\n2. second\n3. third";
    let mut e = editor(source);
    let t = structure(&e).indent(&[0, 1], 0).unwrap();
    apply(&mut e, t);
    assert_eq!(
        structure(&e).root().node(&[0, 0, 1, 0, 0]).unwrap().text(),
        "second"
    );
    let t = structure(&e).outdent(&[0, 0, 1, 0], 1).unwrap();
    apply(&mut e, t);
    assert_eq!(
        structure(&e).root().node(&[0, 1, 0]).unwrap().text(),
        "second"
    );
    let t = structure(&e).outdent(&[0, 1], 2).unwrap();
    apply(&mut e, t);
    assert_eq!(e.document().blocks().len(), 3);
    let s = Structure::for_block(e.document(), e.document().blocks()[1].id()).unwrap();
    assert_eq!(s.root().node(&[0]).unwrap().text(), "second");
    undo_all(&mut e, source);
}

#[test]
fn task_and_quote_conversion_preserves_links_and_noop_history() {
    let source = "[resource](anynote-resource://book/hash) **text**";
    let mut e = editor(source);
    let t = structure(&e).set_list(&[0], ListStyle::Task, 0).unwrap();
    apply(&mut e, t);
    let t = structure(&e).set_checked(&[0, 0], true, 1).unwrap();
    apply(&mut e, t);
    let count = e.undo_steps();
    let t = structure(&e).set_checked(&[0, 0], true, 2).unwrap();
    apply(&mut e, t);
    assert_eq!(e.undo_steps(), count);
    let t = structure(&e).set_quote(&[0], true, 3).unwrap();
    apply(&mut e, t);
    assert!(
        e.document()
            .source()
            .contains("anynote-resource://book/hash")
    );
    let t = structure(&e).set_quote(&[0], false, 4).unwrap();
    apply(&mut e, t);
    undo_all(&mut e, source);
}

#[test]
fn rich_paste_splits_inline_and_keeps_nested_blocks() {
    let source = "**beforeafter**";
    let mut e = editor(source);
    let t = structure(&e)
        .paste(
            &[0],
            6..6,
            TextUnit::Utf8,
            "start\n\n> quote\n>\n> - nested\n\n| h |\n| - |\n| v |\n\nend",
            0,
        )
        .unwrap();
    apply(&mut e, t);
    assert_eq!(e.document().blocks().len(), 4);
    assert_eq!(
        structure(&e).root().node(&[0]).unwrap().text(),
        "beforestart"
    );
    let last = Structure::for_block(e.document(), e.document().blocks()[3].id()).unwrap();
    assert_eq!(last.root().node(&[0]).unwrap().text(), "endafter");
    assert_eq!(e.undo_steps(), 1);
    undo_all(&mut e, source);
}

#[test]
fn table_create_empty_cells_edit_and_navigate() {
    let source = "replace";
    let mut e = editor(source);
    let t = structure(&e).create_table(&[0], 3, 2, 0).unwrap();
    apply(&mut e, t);
    assert_eq!(structure(&e).table_size(&[0]).unwrap(), (3, 2));
    let t = structure(&e)
        .replace_text(
            &[0, 1, 1],
            0..0,
            TextUnit::Utf8,
            "中文 | ` 😀",
            Marks::default().with_mark(Mark::Strong, true),
            1,
        )
        .unwrap();
    apply(&mut e, t);
    assert_eq!(
        structure(&e).root().node(&[0, 1, 1]).unwrap().text(),
        "中文 | ` 😀"
    );
    let s = structure(&e);
    assert_eq!(
        s.adjacent_cell(&[0], CellAddress::new(0, 1), CellDirection::Next)
            .unwrap(),
        Some(CellAddress::new(1, 0))
    );
    assert_eq!(
        s.adjacent_cell(&[0], CellAddress::new(0, 0), CellDirection::Previous)
            .unwrap(),
        None
    );
    let t = s.tab(&[0], CellAddress::new(0, 0), false, 2).unwrap();
    apply(&mut e, t);
    assert_eq!(e.undo_steps(), 2);
    let t = structure(&e)
        .tab(&[0], CellAddress::new(2, 1), false, 3)
        .unwrap();
    apply(&mut e, t);
    assert_eq!(structure(&e).table_size(&[0]).unwrap(), (4, 2));
    undo_all(&mut e, source);
}

#[test]
fn table_rows_columns_header_promotion_and_removal() {
    let source = "| h1 | h2 |\n| --- | --- |\n| a | b |\n| c | d |";
    let mut e = editor(source);
    let t = structure(&e).insert_row(&[0], 1, 0).unwrap();
    apply(&mut e, t);
    let t = structure(&e).insert_column(&[0], 0, 1).unwrap();
    apply(&mut e, t);
    let t = structure(&e).delete_row(&[0], 0, 2).unwrap();
    apply(&mut e, t);
    let t = structure(&e).delete_column(&[0], 0, 3).unwrap();
    apply(&mut e, t);
    assert_eq!(structure(&e).table_size(&[0]).unwrap(), (3, 2));
    assert_eq!(structure(&e).root().node(&[0, 1, 1]).unwrap().text(), "b");
    let t = structure(&e).delete_column(&[0], 1, 4).unwrap();
    apply(&mut e, t);
    let t = structure(&e).delete_column(&[0], 0, 5).unwrap();
    apply(&mut e, t);
    assert_eq!(e.document().source(), "");
    undo_all(&mut e, source);
}

#[test]
fn table_inside_list_quote_and_code_content_survive_structure_changes() {
    let source = "> - first\n>\n>   | h |\n>   | --- |\n>   | `a\\|b` |\n>\n>   ~~~~rust\n>   let x = \"~~~\";\n>   ~~~~";
    let mut e = editor(source);
    let t = structure(&e).insert_column(&[0, 0, 0, 1], 1, 0).unwrap();
    apply(&mut e, t);
    assert_eq!(
        structure(&e)
            .root()
            .node(&[0, 0, 0, 1, 1, 0])
            .unwrap()
            .text(),
        "a|b"
    );
    assert_eq!(
        structure(&e).root().node(&[0, 0, 0, 2]).unwrap().text(),
        "let x = \"~~~\";"
    );
    undo_all(&mut e, source);
}

#[test]
fn opaque_atoms_move_paste_select_and_delete_without_rewriting_payload() {
    let atom = "```anynote future.atom\n{\"resource\":\"anynote-resource://book/hash\",\"unknown\": [1,2]}\n```";
    let source = format!("first\n\n{atom}\n\nlast");
    let mut e = editor(&source);
    let ids: Vec<_> = e.document().blocks().iter().map(|b| b.id()).collect();
    let before = atom_position(e.document(), ids[1], BlockSide::Before).unwrap();
    let after = atom_position(e.document(), ids[1], BlockSide::After).unwrap();
    assert_eq!(&source[before.offset()..after.offset()], atom);
    let selection = block_selection(e.document(), ids[2], ids[0]).unwrap();
    assert!(selection.anchor().offset() > selection.head().offset());
    let t = move_blocks(e.document(), ids[1], ids[1], ids[2], BlockSide::After, 0).unwrap();
    apply(&mut e, t);
    assert!(e.document().source().ends_with(atom));
    let id = e.document().blocks().last().unwrap().id();
    let point = atom_position(e.document(), id, BlockSide::After).unwrap();
    let t = paste_blocks(
        e.document(),
        Selection::caret(e.document().generation(), point.offset()),
        "new\n\n- [x] task",
        1,
    )
    .unwrap();
    apply(&mut e, t);
    assert!(e.document().source().contains(atom));
    let ids: Vec<_> = e.document().blocks().iter().map(|b| b.id()).collect();
    let t = delete_blocks(e.document(), ids[0], ids[1], 2).unwrap();
    apply(&mut e, t);
    undo_all(&mut e, &source);
}

#[test]
fn unsafe_stale_invalid_and_composing_commands_are_atomic() {
    for source in [
        "| x |\n| :- |",
        "a \\* b",
        "<div>html</div>",
        "[x][ref]\n\n[ref]: https://x",
    ] {
        let e = editor(source);
        assert!(matches!(
            Structure::for_block(e.document(), e.document().blocks()[0].id()),
            Err(StructureError::Unsupported)
        ));
        assert_eq!(e.document().source(), source);
    }
    let mut e = editor("😀hello");
    assert!(structure(&e).split(&[0], 1, TextUnit::Utf8, 0).is_err());
    assert!(structure(&e).split(&[99], 0, TextUnit::Utf8, 0).is_err());
    assert!(
        structure(&e)
            .create_table(&[0], usize::MAX, usize::MAX, 0)
            .is_err()
    );
    let t = structure(&e).split(&[0], 4, TextUnit::Utf8, 0).unwrap();
    e.replace(
        TextRange::new(0, 4..4, TextUnit::Utf8),
        "x",
        EditKind::Typing,
        0,
    )
    .unwrap();
    assert!(e.apply(t).is_err());
    e.undo().unwrap();
    let t = structure(&e).set_quote(&[0], true, 1).unwrap();
    let token = e
        .begin_composition(e.document().generation(), 0..0, TextUnit::Utf8)
        .unwrap();
    assert!(e.apply(t).is_err());
    assert_eq!(e.redo_steps(), 1);
    assert_eq!(e.document().source(), "😀hello");
    e.cancel_composition(token).unwrap();
}

#[test]
fn every_rich_shared_fixture_can_be_wrapped_without_losing_editable_content() {
    let fixtures: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("../../../tests/fixtures/markdown/rm15.json")).unwrap();
    let mut checked = 0;
    for fixture in fixtures {
        let source: String = fixture["parts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                p["text"]
                    .as_str()
                    .unwrap()
                    .repeat(p["repeat"].as_u64().unwrap() as usize)
            })
            .collect();
        let doc = Document::new(source);
        for block in doc.blocks().iter().filter(|b| b.parsed().is_editable()) {
            let mut e = editor(doc.source());
            let s = Structure::for_block(e.document(), block.id())
                .unwrap_or_else(|error| panic!("{}: {error:?}", fixture["name"]));
            let t = match s.set_quote(&[0], true, 0) {
                Ok(t) => t,
                Err(StructureError::Budget) if fixture["name"] == "at-utf16-budget" => continue,
                Err(error) => panic!("{}: {error:?}", fixture["name"]),
            };
            apply(&mut e, t);
            undo_all(&mut e, doc.source());
            checked += 1;
        }
    }
    assert!(checked >= 20, "checked {checked} rich blocks");
}

#[test]
fn fixed_seed_table_edits_match_independent_matrix_and_replay() {
    for seed in [0x17ab1eu64, 0xc0ffee, 0xdeadbeef] {
        let source = "table";
        let mut e = editor(source);
        let t = structure(&e).create_table(&[0], 3, 2, 0).unwrap();
        apply(&mut e, t);
        let mut matrix = vec![vec![String::new(); 2]; 3];
        let mut random = seed;
        for step in 0..200 {
            random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
            let s = structure(&e);
            let rows = matrix.len();
            let columns = matrix[0].len();
            let row = (random >> 8) as usize % rows;
            let column = (random >> 24) as usize % columns;
            let t = match random % 5 {
                0 if rows < 10 => {
                    matrix.insert(row, vec![String::new(); columns]);
                    s.insert_row(&[0], row, step).unwrap()
                }
                1 if rows > 1 => {
                    matrix.remove(row);
                    s.delete_row(&[0], row, step).unwrap()
                }
                2 if columns < 8 => {
                    for r in &mut matrix {
                        r.insert(column, String::new());
                    }
                    s.insert_column(&[0], column, step).unwrap()
                }
                3 if columns > 1 => {
                    for r in &mut matrix {
                        r.remove(column);
                    }
                    s.delete_column(&[0], column, step).unwrap()
                }
                _ => {
                    let text = format!("中😀|&{seed}:{step}");
                    let old_len = matrix[row][column].len();
                    matrix[row][column] = text.clone();
                    s.replace_text(
                        &[0, row, column],
                        0..old_len,
                        TextUnit::Utf8,
                        &text,
                        Marks::default(),
                        step,
                    )
                    .unwrap()
                }
            };
            apply(&mut e, t);
            let s = structure(&e);
            let actual: Vec<Vec<String>> = s.root().children()[0]
                .children()
                .iter()
                .map(|r| r.children().iter().map(|c| c.text()).collect())
                .collect();
            assert_eq!(actual, matrix, "seed={seed:x}, step={step}");
        }
        undo_all(&mut e, source);
    }
}

#[test]
fn empty_list_items_and_short_rows_remain_editable() {
    for source in [
        "- [ ]",
        "- a\n-",
        "| a | b |\n| - | - |\n| c |",
        "| a |\n| - |\n| b | extra |",
    ] {
        let mut e = editor(source);
        let t = structure(&e).set_quote(&[0], true, 0).unwrap();
        apply(&mut e, t);
        assert!(e.document().blocks()[0].parsed().is_editable());
        undo_all(&mut e, source);
    }
}

#[test]
fn empty_item_enter_exits_at_end_and_middle() {
    for source in ["-", "- [ ]", "- first\n-", "- first\n-\n- last", "> - [ ]"] {
        let mut e = editor(source);
        let path = if source.starts_with('>') {
            vec![0, 0, 0]
        } else if source.starts_with("- first") {
            vec![0, 1]
        } else {
            vec![0, 0]
        };
        let t = structure(&e)
            .split_item(&path, 0, TextUnit::Utf8, 0)
            .unwrap_or_else(|error| panic!("{source:?}: {error:?}"));
        apply(&mut e, t);
        undo_all(&mut e, source);
    }
}

#[test]
fn multi_cell_paste_expands_once_and_preserves_other_cells() {
    let source = "| h1 | h2 |\n| --- | --- |\n| a | b |";
    let mut e = editor(source);
    let values = vec![
        vec!["中文 | **literal**".into(), "😀".into()],
        vec!["third\nline".into(), "".into()],
    ];
    let t = structure(&e)
        .paste_cells(&[0], CellAddress::new(1, 1), &values, 0)
        .unwrap();
    apply(&mut e, t);
    assert_eq!(structure(&e).table_size(&[0]).unwrap(), (3, 3));
    assert_eq!(structure(&e).root().node(&[0, 1, 0]).unwrap().text(), "a");
    assert_eq!(
        structure(&e).root().node(&[0, 2, 1]).unwrap().text(),
        "third\nline"
    );
    assert_eq!(e.undo_steps(), 1);
    assert!(
        structure(&e)
            .paste_cells(&[0], CellAddress::new(0, 0), &[vec!["a".into()], vec![]], 1)
            .is_err()
    );
    undo_all(&mut e, source);
}

#[test]
fn new_document_and_nested_cross_block_selections() {
    let mut e = editor("");
    let t = Structure::at_caret(e.document(), e.selection())
        .unwrap()
        .create_table(&[0], 3, 2, 0)
        .unwrap();
    apply(&mut e, t);
    let s = structure(&e);
    let selected = s.select_nodes(&[0, 2, 1], &[0, 0, 0]).unwrap();
    assert!(selected.anchor().offset() > selected.head().offset());
    selected.validate(e.document()).unwrap();
    undo_all(&mut e, "");
    let source = "first\n\n| h |\n| - |\n| v |\n\nlast";
    let e = editor(source);
    let ids: Vec<_> = e.document().blocks().iter().map(|b| b.id()).collect();
    let s = Structure::for_blocks(e.document(), ids[0], ids[2]).unwrap();
    let selected = s.select_nodes(&[0], &[2]).unwrap();
    assert_eq!(selected.range(), 0..source.len());
}

#[test]
fn short_and_overflow_cells_keep_values_and_navigation() {
    let source = "| a | b |\n| - | - |\n| c |\n| d | e | extra |";
    let mut e = editor(source);
    let s = structure(&e);
    assert_eq!(s.table_size(&[0]).unwrap(), (3, 3));
    s.cell_selection(&[0], CellAddress::new(1, 2))
        .unwrap()
        .validate(e.document())
        .unwrap();
    let t = s
        .replace_text(&[0, 1, 2], 0..0, TextUnit::Utf8, "new", Marks::default(), 0)
        .unwrap();
    apply(&mut e, t);
    assert_eq!(
        structure(&e).root().node(&[0, 2, 2]).unwrap().text(),
        "extra"
    );
    undo_all(&mut e, source);
}

#[test]
fn block_moves_all_directions_preserve_mixed_separators_and_resources() {
    for (first, last, target, side, expected) in [
        (0, 1, 3, BlockSide::After, vec!["c", "d", "a", "b"]),
        (2, 3, 0, BlockSide::Before, vec!["c", "d", "a", "b"]),
        (1, 2, 0, BlockSide::Before, vec!["b", "c", "a", "d"]),
        (0, 0, 2, BlockSide::Before, vec!["b", "a", "c", "d"]),
    ] {
        let source = "a\r\n\r\nb\n\n\nc\r\n\nd";
        let mut e = editor(source);
        let ids: Vec<_> = e.document().blocks().iter().map(|b| b.id()).collect();
        let t = move_blocks(e.document(), ids[first], ids[last], ids[target], side, 0).unwrap();
        apply(&mut e, t);
        let actual: Vec<_> = e
            .document()
            .blocks()
            .iter()
            .map(|b| &e.document().source()[b.span()])
            .collect();
        assert_eq!(actual, expected);
        undo_all(&mut e, source);
    }
}

#[test]
fn directive_unknown_fields_and_resource_references_survive_moves_and_paste() {
    let raw = ":::anynote{type=\"future.atom\" version=\"99\" extra=\"keep\"}\r\n{ \"resource\": \"anynote-resource://n/r?hash=old\", \"unknown\": {\"x\":[1,null]} }\r\n:::\r\n";
    let source = format!("before\r\n\r\n{raw}\r\nafter");
    let mut e = editor(&source);
    let ids: Vec<_> = e.document().blocks().iter().map(|b| b.id()).collect();
    assert!(matches!(
        e.document().blocks()[1].parsed().content(),
        anynote_core::protocol::rich::Content::Directive(_)
    ));
    let t = move_blocks(e.document(), ids[1], ids[1], ids[2], BlockSide::After, 0).unwrap();
    apply(&mut e, t);
    assert!(e.document().source().contains(raw));
    let selection = Selection::caret(e.document().generation(), 0);
    let t = paste_blocks(e.document(), selection, raw, 1).unwrap();
    apply(&mut e, t);
    assert_eq!(e.document().source().matches(raw).count(), 2);
    undo_all(&mut e, &source);
}

#[test]
fn list_join_with_nested_content_and_lift_following_siblings() {
    let source = "- first\n  - nested\n- second\n  - child1\n  - child2\n  - child3\n- last";
    let mut e = editor(source);
    let t = structure(&e).outdent(&[0, 1, 1, 1], 0).unwrap();
    apply(&mut e, t);
    assert_eq!(
        structure(&e).root().node(&[0, 2, 0]).unwrap().text(),
        "child2"
    );
    assert_eq!(
        structure(&e).root().node(&[0, 2, 1, 0, 0]).unwrap().text(),
        "child3"
    );
    let t = structure(&e).join(&[0, 1], 1).unwrap();
    apply(&mut e, t);
    assert_eq!(
        structure(&e).root().node(&[0, 0, 2]).unwrap().text(),
        "second"
    );
    undo_all(&mut e, source);
}

#[test]
fn fixed_seed_nested_structure_commands_replay_with_resource_and_opaque_neighbors() {
    let raw = ":::anynote{type=\"core.image\"}\n{\"resource\":\"anynote-resource://n/r\",\"unknown\":true}\n:::\n";
    let source =
        format!("- [ ] [zero](anynote-resource://n/r)\n- [x] one\n- [ ] two\n- [ ] three\n\n{raw}");
    let mut e = editor(&source);
    let mut random = 0x171157u64;
    for step in 0..180 {
        random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
        let t = if random.is_multiple_of(3) {
            structure(&e)
                .set_checked(&[0, 1], random & 8 != 0, step)
                .unwrap()
        } else {
            structure(&e).indent(&[0, 1], step).unwrap()
        };
        apply(&mut e, t);
        if !random.is_multiple_of(3) {
            assert_eq!(
                structure(&e).root().node(&[0, 0, 1, 0, 0]).unwrap().text(),
                "one"
            );
            let t = structure(&e).outdent(&[0, 0, 1, 0], step).unwrap();
            apply(&mut e, t);
        }
        let s = structure(&e);
        let words: Vec<_> = s
            .root()
            .node(&[0])
            .unwrap()
            .children()
            .iter()
            .map(|n| n.children()[0].text())
            .collect();
        assert_eq!(words, ["zero", "one", "two", "three"]);
        assert!(e.document().source().ends_with(raw));
        assert_eq!(
            s.root().node(&[0, 0, 0]).unwrap().runs()[0]
                .marks()
                .link()
                .unwrap()
                .url(),
            "anynote-resource://n/r"
        );
    }
    undo_all(&mut e, &source);
}

#[test]
fn paste_atoms_in_middle_of_marked_paragraph_keeps_raw_and_one_history() {
    let source = "**leftright**";
    let raw = ":::anynote{type=\"future\"}\n{\"resource\":\"anynote-resource://n/r\",\"extra\":42}\n:::\n";
    let mut e = editor(source);
    let t = structure(&e)
        .paste(&[0], 4..4, TextUnit::Utf8, raw, 0)
        .unwrap();
    apply(&mut e, t);
    assert_eq!(e.document().blocks().len(), 3);
    assert!(e.document().source().contains(raw));
    assert_eq!(structure(&e).root().children()[0].text(), "left");
    let last = Structure::for_block(e.document(), e.document().blocks()[2].id()).unwrap();
    assert_eq!(last.root().children()[0].text(), "right");
    assert!(
        last.root().children()[0].runs()[0]
            .marks()
            .has(Mark::Strong)
    );
    assert_eq!(e.undo_steps(), 1);
    undo_all(&mut e, source);
}

#[test]
fn plain_clipboard_markup_stays_literal_and_multiple_paragraphs_are_editable() {
    let mut e = editor("beforeafter");
    let t = structure(&e)
        .paste_plain(
            &[0],
            6..6,
            TextUnit::Utf8,
            "**plain**\nline\n\n- not a list",
            0,
        )
        .unwrap();
    apply(&mut e, t);
    assert_eq!(e.document().blocks().len(), 2);
    assert_eq!(
        structure(&e).root().children()[0].text(),
        "before**plain**\nline"
    );
    let last = Structure::for_block(e.document(), e.document().blocks()[1].id()).unwrap();
    assert_eq!(last.root().children()[0].text(), "- not a listafter");
    assert_eq!(last.root().children()[0].kind(), &NodeKind::Paragraph);
    undo_all(&mut e, "beforeafter");
}

#[test]
fn move_list_and_quote_across_single_line_separators() {
    for source in [
        "# heading\nparagraph\n\n- item",
        "- one\n- two\n\n> quote\n\ntail",
    ] {
        let mut e = editor(source);
        let ids: Vec<_> = e.document().blocks().iter().map(|b| b.id()).collect();
        let t = move_blocks(e.document(), ids[0], ids[0], ids[2], BlockSide::After, 0).unwrap();
        apply(&mut e, t);
        undo_all(&mut e, source);
    }
}

#[test]
fn table_insertion_splits_paragraph_without_deleting_unselected_text() {
    let mut e = editor("**before replace after**");
    let t = structure(&e)
        .insert_table(&[0], 7..14, TextUnit::Utf8, (3, 2), 0)
        .unwrap();
    apply(&mut e, t);
    assert_eq!(e.document().blocks().len(), 3);
    assert_eq!(structure(&e).root().children()[0].text(), "before ");
    let table = Structure::for_block(e.document(), e.document().blocks()[1].id()).unwrap();
    assert_eq!(table.table_size(&[0]).unwrap(), (3, 2));
    let last = Structure::for_block(e.document(), e.document().blocks()[2].id()).unwrap();
    assert_eq!(last.root().children()[0].text(), " after");
    undo_all(&mut e, "**before replace after**");
}

#[test]
fn impossible_atom_boundaries_fail_before_changing_text_or_history() {
    let source = "first\n\n```language metadata\nopaque unclosed";
    let mut e = editor(source);
    let ids: Vec<_> = e.document().blocks().iter().map(|b| b.id()).collect();
    assert!(move_blocks(e.document(), ids[1], ids[1], ids[0], BlockSide::Before, 0).is_err());
    assert!(paste_blocks(e.document(), Selection::caret(0, source.len()), "tail", 0).is_err());
    assert_eq!(e.document().source(), source);
    assert_eq!(e.undo_steps(), 0);
    let position = atom_position(e.document(), ids[1], BlockSide::Before).unwrap();
    let t = Structure::at_caret(e.document(), Selection::caret(0, position.offset()))
        .unwrap()
        .replace_text(&[0], 0..0, TextUnit::Utf8, "new", Marks::default(), 0)
        .unwrap();
    apply(&mut e, t);
    assert!(
        e.document()
            .source()
            .ends_with("```language metadata\nopaque unclosed")
    );
    undo_all(&mut e, source);
}
