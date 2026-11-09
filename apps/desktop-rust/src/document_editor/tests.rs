use super::*;

#[core::prelude::v1::test]
fn decoded_projection_and_source_positions_preserve_marks_entities_and_unicode() {
    let source = "# 标题\n\n原有 __格式__ &amp; e\u{301} 🦀\n\n- one\n  - two\n\n| a | b |\n|---|---|\n| c | |\n\n:::anynote{type=\"future.node\" version=\"9\"}\n{\"unknown\":true}\n:::";
    let mut state = DocumentState::new(source.into());
    assert!(state.projection.text.contains("原有 格式 & e\u{301} 🦀"));
    let at = state.projection.text.find('🦀').unwrap();
    state.select(at, at + "🦀".len()).unwrap();
    assert_eq!(&source[state.editor.selection().range()], "🦀");
    state.replace("中文").unwrap();
    assert!(state.projection.text.contains("e\u{301} 中文"));
    assert!(
        state
            .editor
            .document()
            .source()
            .ends_with("{\"unknown\":true}\n:::")
    );
    state.command("undo").unwrap();
    assert_eq!(state.editor.document().source(), source);
    let at = state.projection.text.find('&').unwrap();
    state.select(at, at + 1).unwrap();
    state.replace("和").unwrap();
    assert!(state.projection.text.contains("格式 和"));
}

#[core::prelude::v1::test]
fn document_replay_heading_tasks_table_empty_cells_and_history() {
    let mut state = DocumentState::new(String::new());
    state.replace("##").unwrap();
    state.replace(" ").unwrap();
    state.replace("连续编辑标题").unwrap();
    state.enter().unwrap();
    state.replace("正文第一段").unwrap();
    state.enter().unwrap();
    state.command("task").expect("empty task");
    state.replace("待办事项").unwrap();
    let (ix, _) = state.projection.at(state.head);
    state.toggle_task(ix, true).unwrap();
    state.enter().expect("split task");
    state.enter().expect("exit task");
    state.command("table").unwrap();
    state.command("row").unwrap();
    assert!(state.editor.document().source().contains("[x]"));
    assert!(
        state
            .projection
            .leaves
            .iter()
            .any(|l| l.kind == NodeKind::Heading(2))
    );
    let table_rows = state
        .projection
        .rows
        .iter()
        .filter(|r| r.table.is_some())
        .count();
    assert_eq!(table_rows, 4);
    state.replace("A🦀").unwrap();
    state.tab(false).unwrap();
    state.replace("second").unwrap();
    assert!(state.projection.text.contains("A🦀\nsecond"));
    let final_source = state.editor.document().source().to_owned();
    while state.editor.undo_steps() > 0 {
        state.command("undo").unwrap();
    }
    assert_eq!(state.editor.document().source(), "");
    while state.editor.redo_steps() > 0 {
        state.command("redo").unwrap();
    }
    assert_eq!(state.editor.document().source(), final_source);
}

#[core::prelude::v1::test]
fn composition_is_display_only_then_one_undo_and_cancel_preserves_source() {
    let mut state = DocumentState::new("**ab**\n\n末尾".into());
    state.select(1, 1).unwrap();
    let initial = state.editor.document().source().to_owned();
    state.begin_or_update_composition(None, "n", 1..1).unwrap();
    state
        .begin_or_update_composition(None, "中文🦀", 10..10)
        .unwrap();
    assert_eq!(state.editor.document().source(), initial);
    assert_eq!(state.editor.undo_steps(), 0);
    assert!(state.display_text().starts_with("a中文🦀b"));
    state.commit_composition(None).unwrap();
    assert_eq!(state.editor.undo_steps(), 1);
    state.command("undo").unwrap();
    assert_eq!(state.editor.document().source(), initial);
    state
        .begin_or_update_composition(None, "取消", 6..6)
        .unwrap();
    state.cancel_composition().unwrap();
    assert_eq!(state.editor.document().source(), initial);
    assert_eq!(state.editor.redo_steps(), 1);
}

#[core::prelude::v1::test]
fn plain_paste_cross_paragraph_replacement_and_code_keep_one_core_history() {
    let mut state = DocumentState::new("**first**\n\nsecond\n\nlast".into());
    state.select(2, 9).unwrap();
    state.replace("中").unwrap();
    assert!(
        state.projection.text.starts_with("fi中ond"),
        "{}",
        state.projection.text
    );
    state.command("undo").unwrap();
    assert_eq!(
        state.editor.document().source(),
        "**first**\n\nsecond\n\nlast"
    );
    state.select(0, state.projection.text.len()).unwrap();
    state.paste("*literal*\n\nsecond", false).unwrap();
    assert_eq!(state.projection.text, "*literal*\nsecond");
    state.command("code").unwrap();
    state.replace("```\n中文").unwrap();
    assert!(
        state
            .projection
            .leaves
            .iter()
            .any(|l| matches!(l.kind, NodeKind::Code { .. }))
    );
}

#[core::prelude::v1::test]
fn empty_tasks_compose_cancel_and_commit_without_serializing_a_placeholder() {
    let mut state = DocumentState::new(String::new());
    state.replace("[]").unwrap();
    state.replace(" ").unwrap();
    assert!(state.pending_task.is_some());
    assert_eq!(state.projection.text, "");
    let source = state.editor.document().source().to_owned();
    state.begin_or_update_composition(None, "中", 3..3).unwrap();
    state.cancel_composition().unwrap();
    assert!(state.pending_task.is_some());
    assert_eq!(state.editor.document().source(), source);
    state
        .begin_or_update_composition(None, "中文任务", 12..12)
        .unwrap();
    state.commit_composition(None).unwrap();
    assert_eq!(state.projection.text, "中文任务");
    assert!(!state.projection.leaves[0].task.as_ref().unwrap().1);
    state.enter().unwrap();
    assert!(state.projection.text.ends_with('\n'));
    state
        .begin_or_update_composition(None, "取消", 6..6)
        .unwrap();
    state.cancel_composition().unwrap();
    assert!(state.projection.text.ends_with('\n'));
    state
        .begin_or_update_composition(None, "下一项", 9..9)
        .unwrap();
    state.commit_composition(None).unwrap();
    assert_eq!(state.projection.text, "中文任务\n下一项");
    state.command("undo").unwrap();
    assert_eq!(state.projection.text, "中文任务");
}

#[core::prelude::v1::test]
fn atom_before_after_delete_and_rich_copy_preserve_source() {
    let original =
        "**strong**\n\n:::anynote{type=\"future.node\" version=\"9\"}\n{\"unknown\":true}\n:::";
    let mut state = DocumentState::new(original.into());
    state.select(1, 4).unwrap();
    let copied = DocumentState::new(state.selected_markdown().unwrap());
    assert_eq!(copied.projection.text, "tro");
    assert!(
        copied.projection.leaves[0].runs[0]
            .marks()
            .has(anynote_editor::inline::Mark::Strong)
    );
    let at = state.projection.text.find('\u{fffc}').unwrap();
    state.select(at, at).unwrap();
    state.enter().unwrap();
    state.replace("before").unwrap();
    assert!(state.projection.text.contains("before\n\u{fffc}"));
    state.command("undo").unwrap();
    state.command("undo").unwrap();
    assert_eq!(state.editor.document().source(), original);
    let at = state.projection.text.find('\u{fffc}').unwrap();
    state.select(at, at + '\u{fffc}'.len_utf8()).unwrap();
    state.replace("").unwrap();
    assert!(!state.editor.document().source().contains("future.node"));
    state.command("undo").unwrap();
    assert_eq!(state.editor.document().source(), original);
}

#[core::prelude::v1::test]
fn quote_exit_returns_to_top_level_heading() {
    let mut state = DocumentState::new(String::new());
    state.replace(">").unwrap();
    state.replace(" ").unwrap();
    state.replace("引用内容").unwrap();
    state.command("quote").unwrap();
    assert!(
        !state.projection.leaves[0].quote,
        "{}",
        state.editor.document().source()
    );
    state.command("quote").unwrap();
    let end = state.projection.text.len();
    state.select(end, end).unwrap();
    state.enter().unwrap();
    state.enter().unwrap();
    state.command("h4").unwrap();
    state.replace("四级标题").unwrap();
    let leaf = &state.projection.leaves[state.projection.at(state.head).0];
    assert!(!leaf.quote);
    assert_eq!(leaf.kind, NodeKind::Heading(4));
}

#[core::prelude::v1::test]
fn accessible_table_structure_and_text_selection_include_offscreen_cells() {
    use std::hash::{Hash, Hasher};
    let mut state = DocumentState::new("# 标题\n\n| one | two |\n|---|---|\n| 中文 | 🦀 |".into());
    let at = state.projection.text.find('🦀').unwrap();
    state.select(at + 4, at).unwrap();
    let keys = (0..state.projection.leaves.len() as u64).collect::<Vec<_>>();
    let tree = accessibility::Snapshot::new(&state, &keys).build(|key| {
        let mut hash = std::hash::DefaultHasher::new();
        key.hash(&mut hash);
        accesskit::NodeId(hash.finish())
    });
    let (_, table) = tree
        .nodes
        .iter()
        .find(|(_, node)| node.role() == Role::Table)
        .unwrap();
    assert_eq!(table.row_count(), Some(2));
    assert_eq!(table.column_count(), Some(2));
    assert_eq!(table.children().len(), 2);
    let nodes = tree
        .nodes
        .iter()
        .map(|(id, node)| (*id, node))
        .collect::<HashMap<_, _>>();
    for row in table.children() {
        let row = nodes[row];
        assert_eq!(row.role(), Role::Row);
        assert_eq!(row.children().len(), 2);
        for cell in row.children() {
            assert_eq!(nodes[cell].children().len(), 1);
        }
    }
    let selection = tree.selection.unwrap();
    assert_eq!(tree.positions.position(selection.anchor), Some(at + 4));
    assert_eq!(tree.positions.position(selection.focus), Some(at));
}

#[core::prelude::v1::test]
fn native_utf16_ranges_round_surrogates_without_weakening_core_validation() {
    let text = "a🦀b";
    assert_eq!(state::native_byte_range(text, 2..2).unwrap(), 1..1);
    assert_eq!(state::native_byte_range(text, 2..3).unwrap(), 1..5);
    assert_eq!(state::native_byte_range(text, 1..2).unwrap(), 1..5);
    assert_eq!(state::native_byte_range(text, 4..20).unwrap(), 6..6);
    assert!(
        anynote_editor::selection::byte_range(
            text,
            2..2,
            anynote_editor::selection::TextUnit::Utf16
        )
        .is_err()
    );
}

#[core::prelude::v1::test]
fn formatting_breaks_typing_history_and_block_move_is_atomic() {
    let mut state = DocumentState::new(String::new());
    state.replace("plain").unwrap();
    state.command("bold").unwrap();
    state.replace("strong").unwrap();
    state.command("undo").unwrap();
    assert_eq!(state.projection.text, "plain");
    state.select(0, 5).unwrap();
    state.command("bold").unwrap();
    state.command("bold").unwrap();
    assert!(
        !state.projection.leaves[0].runs[0]
            .marks()
            .has(anynote_editor::inline::Mark::Strong)
    );
    let original = "first\n\nsecond\n\n:::anynote{type=\"future.node\" version=\"9\"}\n{\"unknown\":true}\n:::";
    let mut state = DocumentState::new(original.into());
    state.move_block(2, 0).unwrap();
    let moved = state.editor.document().source();
    assert!(moved.find(":::anynote").unwrap() < moved.find("first").unwrap());
    assert_eq!(state.editor.undo_steps(), 1);
    state.command("undo").unwrap();
    assert_eq!(state.editor.document().source(), original);
}

#[cfg(feature = "ui-tests")]
mod ui {
    use super::*;
    use core::prelude::v1::test;
    use gpui_kit::test::TestWindowExt;
    fn primary(mac: &'static str) -> &'static str {
        if cfg!(target_os = "macos") {
            return mac;
        }
        match mac {
            "cmd-a" => "ctrl-a",
            "cmd-c" => "ctrl-c",
            "cmd-z" => "ctrl-z",
            "cmd-shift-z" => "ctrl-shift-z",
            _ => panic!("unknown platform shortcut"),
        }
    }
    fn open(cx: &mut TestAppContext, source: &str) -> (AnyWindowHandle, Entity<DocumentEditor>) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            install_actions(cx);
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(800.), px(600.)),
                    ))),
                    ..Default::default()
                },
                cx,
                |window, cx| cx.new(|cx| DocumentEditor::new(source.into(), window, cx)),
            )
            .unwrap()
        })
    }
    #[gpui_kit::test]
    fn native_partial_preedit_and_source_switch_guard(cx: &mut TestAppContext) {
        let (window, editor) = open(cx, "ab");
        cx.update_window(window, |_, window, cx| {
            editor.update(cx, |view, cx| {
                view.state.select(1, 1).unwrap();
                view.replace_and_mark_text_in_range(None, "中文", Some(2..2), window, cx);
                view.replace_and_mark_text_in_range(Some(1..2), "国", Some(1..1), window, cx);
                assert_eq!(view.state.display_text(), "a国文b");
                view.set_selected_text_range(1..2, window, cx);
                assert_eq!(view.state.display_selection(), 1..4);
                assert_eq!(view.source(), "ab");
                view.replace_text_in_range(Some(2..3), "语", window, cx);
                assert_eq!(view.text(), "a国语b");
                assert_eq!(view.undo_steps(), 1);
                view.toggle_source(window, cx);
                let source = view.source.clone().unwrap();
                source.update(cx, |source, cx| {
                    source.replace_and_mark_text_in_range(None, "预编辑", None, window, cx)
                });
                view.toggle_source(window, cx);
                assert!(view.source.is_some());
                view.run(&RunCommand::new("undo"), window, cx);
                assert_eq!(view.undo_steps(), 1);
                source.update(cx, |source, cx| {
                    source.replace_text_in_range(None, "提交", window, cx)
                });
            });
        })
        .unwrap();
        cx.update_window(window, |_, window, cx| {
            editor.update(cx, |view, cx| {
                assert!(view.source().contains("提交"));
                view.toggle_source(window, cx);
                assert!(view.source.is_none());
                assert!(view.text().contains("提交"));
            });
        })
        .unwrap();
    }

    #[gpui_kit::test]
    fn native_input_rich_geometry_clipboard_unicode_and_undo(cx: &mut TestAppContext) {
        let (window, editor) = open(cx, "");
        cx.update_window(window, |_, window, cx| {
            window.render_frame(cx);
            window.input("中文 e\u{301} 🦀", cx);
            assert_eq!(editor.read(cx).text(), "中文 e\u{301} 🦀");
            window.press("backspace", cx);
            assert_eq!(editor.read(cx).text(), "中文 e\u{301} ");
            window.press(primary("cmd-a"), cx);
            window.press(primary("cmd-c"), cx);
            assert_eq!(
                cx.read_from_clipboard().unwrap().text().unwrap(),
                "中文 e\u{301} "
            );
            window.input("替换", cx);
            assert_eq!(editor.read(cx).text(), "替换");
            window.press(primary("cmd-z"), cx);
            assert_eq!(editor.read(cx).text(), "中文 e\u{301} ");
            window.render_frame(cx);
            editor.update(cx, |view, cx| {
                let caret = view.caret_bounds(window).unwrap();
                assert!(caret.size.height > px(0.));
                let hit = view
                    .hit(caret.origin + point(px(0.), caret.size.height / 2.), window)
                    .unwrap();
                assert_eq!(hit, view.state.head);
                let range = view.selected_text_range(false, window, cx).unwrap().range;
                assert_eq!(range.end, view.text().encode_utf16().count());
            });
        })
        .unwrap();
    }
    #[gpui_kit::test]
    fn editor_host_lists_tables_atoms_and_native_composition(cx: &mut TestAppContext) {
        let (window, editor) = open(
            cx,
            "# 标题\n\n- item\n  - nested\n\n| a | b |\n|---|---|\n| c | d |\n\n:::anynote{type=\"future\"}\n{}\n:::",
        );
        cx.update_window(window, |_, window, cx| {
            window.render_frame(cx);
            editor.update(cx, |view, cx| {
                assert!(view.geometry.borrow().leaves.len() >= 7);
                let at = view.text().find("nested").unwrap();
                view.state.select(at, at).unwrap();
                view.replace_and_mark_text_in_range(None, "中文🦀", Some(4..4), window, cx);
                assert!(!view.source().contains("中文"));
                assert_eq!(view.marked_text_range(window, cx).unwrap().len(), 4);
            });
            window.render_frame(cx);
            editor.update(cx, |view, cx| {
                assert!(
                    view.bounds_for_range(
                        view.marked_text_range(window, cx).unwrap(),
                        Bounds::default(),
                        window,
                        cx
                    )
                    .is_some()
                );
                view.replace_text_in_range(None, "中文🦀", window, cx);
                assert!(view.text().contains("中文🦀nested"));
                assert_eq!(view.undo_steps(), 1);
            });
            window.press(primary("cmd-z"), cx);
            assert!(!editor.read(cx).text().contains("中文"));
        })
        .unwrap();
    }
    #[gpui_kit::test]
    fn source_events_and_programmatic_echo_share_history(cx: &mut TestAppContext) {
        let (window, editor) = open(cx, "initial");
        cx.update_window(window, |_, window, cx| {
            window.render_frame(cx);
            window.click("source-mode", cx);
            window.render_frame(cx);
            window.press(primary("cmd-a"), cx);
            window.input("# source 🦀", cx);
        })
        .unwrap();
        cx.update_window(window, |_, window, cx| {
            assert_eq!(editor.read(cx).source(), "# source 🦀");
            let steps = editor.read(cx).undo_steps();
            for _ in 0..steps {
                window.press(primary("cmd-z"), cx);
            }
            assert_eq!(editor.read(cx).source(), "initial");
            assert_eq!(editor.read(cx).undo_steps(), 0);
            for _ in 0..steps {
                window.press(primary("cmd-shift-z"), cx);
            }
            assert_eq!(editor.read(cx).source(), "# source 🦀");
            window.click("source-mode", cx);
            window.render_frame(cx);
            window.press("end", cx);
            window.input(" appended", cx);
            assert!(editor.read(cx).text().ends_with(" appended"));
        })
        .unwrap();
    }
    #[gpui_kit::test]
    fn native_document_replay_slash_task_table_and_search_virtualization(cx: &mut TestAppContext) {
        let (window, editor) = open(cx, "");
        cx.update_window(window, |_, window, cx| {
            window.render_frame(cx);
            window.input("## ", cx);
            window.input("连续编辑标题", cx);
            window.press("enter", cx);
            window.input("正文第一段", cx);
            window.press("enter", cx);
            window.input("/task", cx);
            window.press("enter", cx);
            window.input("待办事项", cx);
            let task_key = {
                let view = editor.read(cx);
                let ix = view.state.projection.at(view.state.head).0;
                view.keys[ix]
            };
            window.click(("task", task_key), cx);
            // The checkbox retains its own focus; resume the continuous input surface.
            editor.update(cx, |view, cx| view.focus.focus(window, cx));
            window.press("end", cx);
            window.press("enter", cx);
            window.press("enter", cx);
            window.input("/table", cx);
            window.press("enter", cx);
            window.click("row", cx);
            assert!(editor.read(cx).source().contains("[x]"));
            assert_eq!(
                editor
                    .read(cx)
                    .state
                    .projection
                    .rows
                    .iter()
                    .filter(|r| r.table.is_some())
                    .count(),
                4
            );
            assert!(!editor.read(cx).text().contains("/task"));
            assert!(!editor.read(cx).text().contains("/table"));
        })
        .unwrap();
    }
    #[gpui_kit::test]
    fn offscreen_search_reflows_at_zoom_and_only_lays_out_visible_rows(cx: &mut TestAppContext) {
        let source = (0..1200)
            .map(|ix| format!("paragraph {ix} 中文 emoji 🦀"))
            .collect::<Vec<_>>()
            .join("\n\n");
        let (window, editor) = open(cx, &source);
        cx.update_window(window, |_, window, cx| {
            window.render_frame(cx);
            assert!(editor.read(cx).geometry.borrow().leaves.len() < 40);
            editor.update(cx, |view, cx| {
                assert!(view.find_text("paragraph 1199", window, cx))
            });
            window.render_frame(cx);
            let view = editor.read(cx);
            let ix = view.state.projection.at(view.state.head).0;
            assert!(view.geometry.borrow().leaves.contains_key(&view.keys[ix]));
            assert!(view.geometry.borrow().leaves.len() < 40);
            for size in [12., 24.] {
                gpui_kit::component::Theme::update(cx, |theme| theme.font_size = px(size));
                window.render_frame(cx);
                assert_eq!(editor.read(cx).geometry.borrow().rem, px(size));
                assert!(editor.read(cx).caret_bounds(window).is_some());
            }
        })
        .unwrap();
    }
}
