use anynote_core::{document_session::DocumentId, pdf::*};
use uuid::Uuid;
#[test]
fn index_budgets_states_and_incomplete_runs() {
    assert!(IndexBuilder::new(0).is_none());
    assert!(IndexBuilder::new(2).unwrap().finish().is_none());
    let mut index = IndexBuilder::new(2).unwrap();
    assert!(!index.push(1, "wrong order".into(), false));
    assert!(index.push(0, "hello 😀".into(), false));
    assert!(index.finish().is_none());
    let mut index = IndexBuilder::new(501).unwrap();
    for page in 0..500 {
        assert!(index.push(page, "Text".into(), false));
    }
    assert!(!index.push(500, "Text".into(), false));
    let (body, coverage) = index.finish().unwrap();
    assert_eq!(coverage.state(), IndexState::Partial);
    assert_eq!(coverage.pages(), 500);
    assert!(body.ends_with("[第 500 页]\nText"));
    let mut index = IndexBuilder::new(1).unwrap();
    assert!(!index.push(0, "😀".repeat(MAX_INDEX_UTF16 / 2 + 1), false));
    assert!(index.push(
        0,
        "😀".repeat((MAX_INDEX_UTF16 - page_marker(0).encode_utf16().count()) / 2),
        true
    ));
    assert_eq!(index.finish().unwrap().1.state(), IndexState::Partial);
    let mut index = IndexBuilder::new(1).unwrap();
    index.push(0, " \n\t".into(), false);
    assert_eq!(index.finish().unwrap().1.state(), IndexState::Scanned);
    let mut index = IndexBuilder::new(1).unwrap();
    index.push(0, "complete".into(), false);
    assert_eq!(index.finish().unwrap().1.state(), IndexState::Complete);
}
#[test]
fn unicode_search_and_backlinks_keep_original_offsets() {
    assert_eq!(search_ranges("😀 ABC 中文 abc", "abc"), vec![3..6, 10..13]);
    assert_eq!(search_ranges("İx X", "x"), vec![1..2, 3..4]);
    let document = DocumentId::new(Uuid::new_v4(), Uuid::new_v4());
    for anchor in [PdfAnchor::Page(42), PdfAnchor::Annotation(Uuid::new_v4())] {
        let link = return_link(&document, &anchor);
        assert_eq!(parse_return_link(&link), Some((document.clone(), anchor)));
    }
    assert!(PdfAnchor::parse("pdf-page-0").is_none());
    assert!(parse_return_link("https://example.com").is_none());
    let body = reading_body(
        &document,
        &AnnotationDraft::new(3, vec![], "first\r\nsecond".into(), "Comment".into()),
        None,
    );
    assert!(body.contains("> first\n> second"));
    assert!(body.contains("#pdf-page-3)"));
}
