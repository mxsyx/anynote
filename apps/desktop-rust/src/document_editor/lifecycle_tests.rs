use super::*;
use anynote_core::document_session::*;
use core::prelude::v1::test;
use gpui_kit::test::{TestEventExt, TestWindowExt};
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
