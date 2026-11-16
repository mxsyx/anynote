use super::*;
use anynote_core::document_session::*;
use core::prelude::v1::test;
use gpui_kit::test::TestWindowExt;
use uuid::Uuid;

#[gpui_kit::test]
fn source_close_commits_preedit_and_drains_snapshot_before_saving(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    cx.update(install_actions);
    let base = DocumentSnapshot::new(
        DocumentId::new(Uuid::new_v4(), Uuid::new_v4()),
        1,
        Uuid::new_v4(),
        DocumentContent::new("note".into(), "start".into(), vec![], false),
    );
    let (window, editor) = cx.update(|cx| {
        gpui_kit::open_window(WindowOptions::default(), cx, |w, cx| {
            cx.new(|cx| DocumentEditor::from_snapshot(base, w, cx))
        })
        .unwrap()
    });
    cx.update_window(window, |_, w, cx| {
        w.render_frame(cx);
        w.click("source-mode", cx);
        w.render_frame(cx);
        let source = editor.read(cx).source.clone().unwrap();
        source.update(cx, |s, cx| {
            s.replace_and_mark_text_in_range(Some(0..5), "中文🦀", None, w, cx);
        });
        w.render_frame(cx);
        w.dispatch_action(Box::new(crate::shell::CloseWindow), cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(window, |_, w, cx| {
        editor.update(cx, |e, cx| {
            e.flush(w, cx);
            assert!(!e.source_composing(w, cx));
            assert_eq!(e.source(), "中文🦀");
            assert!(e.state.save.as_ref().unwrap().retry_needed());
            assert_eq!(e.undo_steps(), 1);
        });
    })
    .unwrap();
}

#[gpui_kit::test]
fn outline_uses_parsed_headings_and_navigates_without_editing(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let source = "# 重复标题\n\n正文\n\n```markdown\n# 代码中的标题\n```\n\n## 重复标题\n\n末尾";
    let (window, editor) = cx.update(|cx| {
        gpui_kit::open_window(WindowOptions::default(), cx, |w, cx| {
            cx.new(|cx| DocumentEditor::new(source.into(), w, cx))
        })
        .unwrap()
    });
    cx.update_window(window, |_, w, cx| {
        w.render_frame(cx);
        editor.update(cx, |editor, cx| {
            let headings = editor
                .headings()
                .map(|(key, level, title)| (key, level, title.to_owned()))
                .collect::<Vec<_>>();
            assert_eq!(headings.len(), 2);
            assert_ne!(headings[0].0, headings[1].0);
            assert_eq!((headings[1].1, headings[1].2.as_str()), (2, "重复标题"));
            assert_eq!(editor.active_heading(), Some(headings[0].0));
            editor.focus_heading(headings[1].0, w, cx);
            assert_eq!(editor.active_heading(), Some(headings[1].0));
            assert_eq!(
                editor.selection().start,
                editor.text().rfind("重复标题").unwrap()
            );
            assert_eq!(editor.source(), source);
            assert_eq!(editor.undo_steps(), 0);
            assert!(editor.focus.is_focused(w));
            let end = editor.text().len();
            let _ = editor.state.select(end, end);
            assert_eq!(editor.active_heading(), Some(headings[1].0));
        });
    })
    .unwrap();
}
