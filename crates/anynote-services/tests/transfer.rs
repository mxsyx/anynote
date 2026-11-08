use anynote_services::transfer::*;
use anynote_storage::notebook::*;
use std::{fs, path::Path};

fn fixture() -> (tempfile::TempDir, WriteQueue, TransferRequest) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm06");
    fs::create_dir_all(&path).unwrap();
    let dir = tempfile::tempdir_in(path.canonicalize().unwrap()).unwrap();
    let q = WriteQueue::open(dir.path(), 1).unwrap();
    let p = q
        .submit(|s| {
            let a = s.create_notebook("源")?.id;
            let b = s.create_notebook("目标")?.id;
            let n = s
                .notebook(&a)?
                .create_node(&CreateNode::note("正文", "原文"), &[])?;
            Ok(TransferRequest {
                notebook_id: a,
                target_notebook_id: b,
                id: n.node.id,
                target_parent_id: None,
                mode: TransferMode::Move,
                operation_id: uuid::Uuid::new_v4().to_string(),
                expected_revision: 1,
            })
        })
        .unwrap()
        .wait()
        .unwrap();
    (dir, q, p)
}
fn run(q: &WriteQueue, p: &TransferRequest) -> ReadResult<TransferResult> {
    transfer_node(q, p.clone())?.wait()
}
fn copy(q: &WriteQueue, p: &TransferRequest) -> TransferResult {
    let p = p.clone();
    q.submit(move |s| {
        s.with_pair(&p.notebook_id, &p.target_notebook_id, |a, b| {
            Ok(b.copy_transfer(a, &p)?.result())
        })
    })
    .unwrap()
    .wait()
    .unwrap()
}
#[test]
fn service_replay_after_reopen_and_restore_does_not_trash_again() {
    let (dir, q, p) = fixture();
    let copied = copy(&q, &p);
    assert_eq!(copied.status, TransferStatus::Copied);
    assert_eq!(
        q.submit(|s| Ok(s.connection_count()))
            .unwrap()
            .wait()
            .unwrap(),
        1
    );
    drop(q);
    let q = WriteQueue::open(dir.path(), 1).unwrap();
    let completed = run(&q, &p).unwrap();
    assert_eq!(completed.id, copied.id);
    assert_eq!(completed.status, TransferStatus::Completed);
    let a = p.notebook_id.clone();
    let id = p.id.clone();
    q.submit(move |s| s.notebook(&a)?.restore_node(&id))
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(run(&q, &p).unwrap(), completed);
    let a = p.notebook_id.clone();
    let id = p.id.clone();
    assert!(
        q.submit(move |s| Ok(s.notebook(&a)?.read().note(&id)?.node.deleted_at))
            .unwrap()
            .wait()
            .unwrap()
            .is_none()
    );
    let mut mismatch = p.clone();
    mismatch.mode = TransferMode::Copy;
    assert_eq!(
        run(&q, &mismatch).unwrap_err().kind(),
        ReadErrorKind::InvalidInput
    );
}
#[test]
fn either_side_edits_stop_move_without_duplicate_copy() {
    for source in [true, false] {
        let (_dir, q, p) = fixture();
        let copied = copy(&q, &p);
        let book = if source {
            p.notebook_id.clone()
        } else {
            p.target_notebook_id.clone()
        };
        let id = if source {
            p.id.clone()
        } else {
            copied.id.clone()
        };
        q.submit(move |s| {
            s.notebook(&book)?.save_note(
                &id,
                1,
                &NotePatch {
                    body: Some("后续修改".into()),
                    ..Default::default()
                },
                &[],
            )
        })
        .unwrap()
        .wait()
        .unwrap();
        let result = run(&q, &p).unwrap();
        assert_eq!(
            result.status,
            if source {
                TransferStatus::CopiedSourceChanged
            } else {
                TransferStatus::CopiedTargetChanged
            }
        );
        assert_eq!(result.id, copied.id);
        let a = p.notebook_id.clone();
        let id = p.id.clone();
        assert!(
            q.submit(move |s| Ok(s.notebook(&a)?.read().note(&id)?.node.deleted_at))
                .unwrap()
                .wait()
                .unwrap()
                .is_none()
        );
    }
}
#[test]
fn stale_revision_parent_and_identity_fail_before_copy() {
    let (_dir, q, p) = fixture();
    let mut bad = p.clone();
    bad.expected_revision = 99;
    assert_eq!(run(&q, &bad).unwrap_err().kind(), ReadErrorKind::Conflict);
    bad = p.clone();
    bad.target_parent_id = Some(uuid::Uuid::new_v4().to_string());
    assert!(run(&q, &bad).is_err());
    bad = p.clone();
    bad.target_notebook_id = p.notebook_id.clone();
    assert!(run(&q, &bad).is_err());
    let b = p.target_notebook_id.clone();
    assert_eq!(
        q.submit(move |s| Ok(s.notebook(&b)?.read().nodes()?.len()))
            .unwrap()
            .wait()
            .unwrap(),
        0
    );
}
#[test]
fn copy_and_replay_preserve_source() {
    let (_dir, q, mut p) = fixture();
    p.mode = TransferMode::Copy;
    let r = run(&q, &p).unwrap();
    assert_eq!(r.status, TransferStatus::Completed);
    assert_eq!(run(&q, &p).unwrap(), r);
    let a = p.notebook_id.clone();
    let id = p.id.clone();
    assert!(
        q.submit(move |s| Ok(s.notebook(&a)?.read().note(&id)?.node.deleted_at))
            .unwrap()
            .wait()
            .unwrap()
            .is_none()
    );
}
