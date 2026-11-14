use super::{Workspace, install_actions, reading};
use anynote_core::{
    document_session::DocumentId,
    workspace::{Book, Entry},
};
use gpui_kit::test::TestWindowExt;
use gpui_kit::{AppContext, Bounds, TestAppContext, WindowBounds, WindowOptions, px, size};
use uuid::Uuid;

#[gpui_kit::test]
fn ten_thousand_rows_are_virtualized_and_home_end_work_at_double_zoom(cx: &mut TestAppContext) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        install_actions(cx);
    });
    let (window, view) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(1200.), px(800.)),
                ))),
                ..Default::default()
            },
            cx,
            |w, cx| cx.new(|cx| Workspace::new(w, cx)),
        )
        .unwrap()
    });
    let book = Uuid::new_v4();
    let ids = (0..10_000).map(|_| Uuid::new_v4()).collect::<Vec<_>>();
    cx.update_window(window, |_, w, cx| {
        view.update(cx, |v, cx| {
            v.book = Some(book);
            v.books = vec![Book::new(book, "长目录".into())];
            v.nodes = ids
                .iter()
                .enumerate()
                .map(|(ix, id)| Entry::new(DocumentId::new(book, *id), format!("笔记 {ix}")))
                .collect();
            v.rebuild_tree(cx);
            v.tree.update(cx, |tree, cx| tree.focus(w, cx));
            v.preferences.font_size = 32.;
            v.apply_theme(w, cx);
        });
        w.render_frame(cx);
        assert!(w.try_find(format!("node-{}", ids[0])).is_some());
        assert!(w.try_find(format!("node-{}", ids[500])).is_none());
        w.press("end", cx);
        w.render_frame(cx);
        assert_eq!(view.read(cx).selected(cx).unwrap().id.note(), ids[9999]);
        assert!(w.try_find(format!("node-{}", ids[9999])).is_some());
        w.press("home", cx);
        w.render_frame(cx);
        assert_eq!(view.read(cx).selected(cx).unwrap().id.note(), ids[0]);
        let button = w.find("workspace-settings");
        assert!(button.bounds().right() <= w.viewport_size().width);
        assert!(button.bounds().bottom() <= w.viewport_size().height);
        w.remove_window();
    })
    .unwrap();
}
#[test]
fn reading_projection_preserves_plain_markdown_and_quotes_unknown_source() {
    let plain = "# Heading\n\nA [link](https://example.com)\n\n```rust\nlet a=1;\n```\n";
    assert_eq!(reading::project(plain), plain);
    let source = anynote_editor::builtin::insert("core.details", "detail-1").unwrap();
    let projected = reading::project(&source);
    assert!(projected.contains("```anynote-reading-block"));
    assert!(projected.contains("\\n"));
    assert!(!projected.contains("\n:::anynote"));
}

#[gpui_kit::test]
fn large_document_anchor_waits_for_parse_and_position_restores(cx: &mut TestAppContext) {
    let (window, view) = cx.update(|cx| {
        gpui_kit::init(cx);
        gpui_kit::open_window(WindowOptions::default(), cx, |w, cx| {
            cx.new(|cx| Workspace::new(w, cx))
        })
        .unwrap()
    });
    let source = format!(
        "{}\n# 最后一个锚点\n",
        "A long paragraph with searchable content.\n\n".repeat(2000)
    );
    cx.update(|cx| {
        view.update(cx, |v, cx| {
            let book = Uuid::new_v4();
            v.book = Some(book);
            v.books = vec![Book::new(book, "阅读".into())];
            v.snapshot = Some(anynote_core::document_session::DocumentSnapshot::new(
                DocumentId::new(book, Uuid::new_v4()),
                1,
                Uuid::new_v4(),
                anynote_core::document_session::DocumentContent::new(
                    "长文档".into(),
                    source.clone(),
                    vec![],
                    false,
                ),
            ));
            v.set_reading_text(&source, cx);
            v.pending_anchor = Some("最后一个锚点".into());
            v.restore_reading_target(cx);
        })
    });
    for _ in 0..100 {
        cx.run_until_parked();
        cx.update_window(window, |_, w, cx| w.render_frame(cx))
            .unwrap();
        if cx.read(|cx| {
            view.read(cx).pending_anchor.is_none()
                && view
                    .read(cx)
                    .reader
                    .read(cx)
                    .list_state()
                    .logical_scroll_top()
                    .item_ix
                    > 1000
        }) {
            break;
        }
    }
    cx.read(|cx| {
        let v = view.read(cx);
        assert!(v.pending_anchor.is_none());
        assert!(v.reader.read(cx).list_state().logical_scroll_top().item_ix > 1000);
    });
    cx.update(|cx| {
        view.update(cx, |v, cx| {
            let mut position = anynote_core::workspace::ReadingPosition::default();
            position.block = 100;
            v.pending_position = Some(position);
            v.restore_reading_target(cx);
            assert_eq!(
                v.reader.read(cx).list_state().logical_scroll_top().item_ix,
                100
            );
        })
    });
    cx.update_window(window, |_, w, _| w.remove_window())
        .unwrap();
}

#[test]
fn startup_selects_saved_notebook_and_falls_back_when_unavailable() {
    use anynote_core::workspace::Preferences;
    let first = Book::new(Uuid::new_v4(), "第一本".into());
    let mut saved = Book::new(Uuid::new_v4(), "上次使用".into());
    let mut preferences = Preferences::default();
    preferences.active_book = Some(saved.id);
    let books = [first.clone(), saved.clone()];
    assert_eq!(
        super::preferred_book(&books, None, &preferences),
        Some(saved.id)
    );
    assert_eq!(
        super::preferred_book(&books, Some(first.id), &preferences),
        Some(first.id)
    );
    saved.unavailable = true;
    assert_eq!(
        super::preferred_book(&[first.clone(), saved.clone()], None, &preferences),
        Some(first.id)
    );
    assert_eq!(super::preferred_book(&[saved], None, &preferences), None);
    assert_eq!(super::preferred_book(&[], None, &preferences), None);
    preferences.active_book = Some(Uuid::new_v4());
    preferences
        .recent
        .push(DocumentId::new(first.id, Uuid::new_v4()));
    assert_eq!(
        super::preferred_book(&[first.clone()], None, &preferences),
        Some(first.id)
    );
}
