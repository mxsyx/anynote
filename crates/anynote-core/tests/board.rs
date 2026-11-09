use anynote_core::{board::*, document_session::*};
use uuid::Uuid;
#[test]
fn directive_commit_changes_only_frozen_payload_and_preserves_unknown_data() {
    let block = Uuid::new_v4();
    let body = format!(
        "正文\r\n\r\n:::anynote{{type=\"core.whiteboard\" version=\"1\" id=\"{block}\" future=\"keep\"}}\r\n{{\"future\":12345678901234567890}}\r\n:::\r\n\r\n尾部"
    );
    let base = DocumentSnapshot::new(
        DocumentId::new(Uuid::new_v4(), Uuid::new_v4()),
        3,
        Uuid::new_v4(),
        DocumentContent::new("title".into(), body.clone(), vec![], false),
    );
    let request = BoardSave::new(
        base.clone(),
        block.to_string(),
        "{}".into(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        vec![],
    );
    let result = request.body().unwrap();
    assert!(result.starts_with("正文\r\n\r\n:::anynote"));
    assert!(result.ends_with("\r\n:::\r\n\r\n尾部"));
    assert!(result.contains("12345678901234567890"));
    assert!(result.contains("future=\"keep\""));
    let duplicate = DocumentSnapshot::new(
        base.id().clone(),
        3,
        base.head(),
        base.content().with_body(format!("{body}\n{body}")),
    );
    assert!(
        BoardSave::new(
            duplicate,
            block.to_string(),
            "{}".into(),
            request.resource(),
            request.preview(),
            vec![]
        )
        .body()
        .is_none()
    );
    assert!(
        BoardSave::new(
            base,
            "absent".into(),
            "{}".into(),
            request.resource(),
            request.preview(),
            vec![]
        )
        .body()
        .is_none()
    );
}
