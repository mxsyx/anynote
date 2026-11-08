use anynote_services::{cloud::*, importer::*};
use anynote_storage::notebook::*;
use serde_json::{Value, json};
use std::{fs, path::Path};

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn temp() -> tempfile::TempDir {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm12");
    fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root.canonicalize().unwrap()).unwrap()
}
fn session(root: &Path) -> TransferSession {
    fs::create_dir_all(root).unwrap();
    TransferSession::open(
        root,
        TransferIdentity {
            connection_id: id(),
            endpoint: "https://backup.example".into(),
            notebook_id: id(),
            lineage_id: id(),
            direction: Direction::Upload,
            writer: Some(WriterIdentity {
                device_id: id(),
                epoch: 1,
            }),
        },
    )
    .unwrap()
}
fn object(root: &Path, hash: &str) -> Value {
    fn find(root: &Path, hash: &str) -> Option<std::path::PathBuf> {
        for entry in fs::read_dir(root).ok()? {
            let path = entry.ok()?.path();
            if path.is_dir() {
                if let Some(found) = find(&path, hash) {
                    return Some(found);
                }
            } else if path.file_name().unwrap() == hash {
                return Some(path);
            }
        }
        None
    }
    serde_json::from_slice(&fs::read(find(root, hash).unwrap()).unwrap()).unwrap()
}
fn freeze(q: &WriteQueue, book: &str, root: &Path) -> FrozenSnapshot {
    let (book, root) = (book.to_owned(), root.to_owned());
    q.submit(move |s| s.capture_snapshot(&book, &root, &Cancellation::default()))
        .unwrap()
        .wait()
        .unwrap()
}
#[tokio::test]
async fn browse_and_ack_evidence_use_the_uploaded_cut_not_live_database() {
    let root = temp();
    let q = WriteQueue::open(root.path(), 2).unwrap();
    let book = q
        .submit(|s| s.create_notebook("capture"))
        .unwrap()
        .wait()
        .unwrap();
    let mut before = freeze(&q, &book.id, root.path());
    let mut importer = ImportService::new(root.path()).unwrap();
    let target = PreviewTarget {
        notebook_id: book.id.clone(),
        parent_id: None,
    };
    let preview = importer
        .preview(
            target.clone(),
            ImportInput::File {
                file: fs::File::open(
                    Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("../../tests/fixtures/rust-migration/corpus/capture.anyclip"),
                )
                .unwrap(),
                name: "fixture.anyclip".into(),
            },
            ImportOptions::default(),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let note = importer
        .commit(&q, &target, &preview.id, &CancellationToken::new())
        .unwrap();
    let mut after = freeze(&q, &book.id, root.path());
    let (b, n) = (book.id.clone(), note.node.id.clone());
    q.submit(move |s| {
        s.notebook(&b)?.save_note(
            &n,
            1,
            &NotePatch {
                body: Some("later edit".into()),
                ..Default::default()
            },
            &[],
        )
    })
    .unwrap()
    .wait()
    .unwrap();
    let pending = vec!["cd671bd4-2bbc-4bb0-82fc-53d30a71c6b0".into()];
    let old_root = root.path().join("old");
    let mut old_session = session(&old_root);
    let old = prepare_upload_with_captures(
        &mut old_session,
        &mut before,
        "",
        "2026-11-08T00:00:00Z",
        &pending,
        &Cancellation::default(),
    )
    .unwrap();
    let old: Value = serde_json::from_slice(old.bytes()).unwrap();
    assert_eq!(
        object(&old_root, old["captureAcks"]["hash"].as_str().unwrap()),
        json!([])
    );
    let new_root = root.path().join("new");
    let mut new_session = session(&new_root);
    let new = prepare_upload_with_captures(
        &mut new_session,
        &mut after,
        "",
        "2026-11-08T00:00:00Z",
        &pending,
        &Cancellation::default(),
    )
    .unwrap();
    let new: Value = serde_json::from_slice(new.bytes()).unwrap();
    let acks = object(&new_root, new["captureAcks"]["hash"].as_str().unwrap());
    assert_eq!(acks[0]["noteId"], note.node.id);
    assert!(acks[0]["appliedSeq"].as_u64().unwrap() <= new["snapshotSeq"].as_u64().unwrap());
    let path = format!("note/{}", note.node.id);
    let descriptor = new["browse"]["objects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["path"] == path)
        .unwrap();
    let projected = object(&new_root, descriptor["hash"].as_str().unwrap());
    assert_eq!(projected["body"], note.body);
    assert_eq!(projected["revisionId"], note.head_revision_id.unwrap());
    assert!(!projected["resources"].as_array().unwrap().is_empty());
    for resource in projected["resources"].as_array().unwrap() {
        assert!(
            new["assets"]
                .as_array()
                .unwrap()
                .iter()
                .any(|a| a["sha256"] == resource["hash"])
        );
    }
    let count = fs::read_dir(new_root).unwrap().count();
    assert!(
        prepare_upload_with_captures(
            &mut new_session,
            &mut after,
            "",
            "2026-11-08T00:00:00Z",
            &[],
            &Cancellation::default()
        )
        .is_err()
    );
    assert!(count > 0);
}
#[test]
fn browse_tree_pages_are_bounded_and_deleted_ancestors_are_excluded() {
    let root = temp();
    let q = WriteQueue::open(root.path(), 2).unwrap();
    let book = q
        .submit(|s| {
            let book = s.create_notebook("pages")?;
            let writer = s.notebook(&book.id)?;
            for i in 0..101 {
                writer.create_node(&CreateNode::note(format!("note {i:03}"), ""), &[])?;
            }
            let mut folder = CreateNode::note("hidden folder", "");
            folder.kind = NodeKind::Folder;
            folder.note_type = None;
            let folder = writer.create_node(&folder, &[])?;
            let mut child = CreateNode::note("hidden child", "");
            child.parent_id = Some(folder.node.id.clone());
            writer.create_node(&child, &[])?;
            writer.trash_node(&folder.node.id)?;
            Ok(book)
        })
        .unwrap()
        .wait()
        .unwrap();
    let mut frozen = freeze(&q, &book.id, root.path());
    let output = root.path().join("transfer");
    let mut session = session(&output);
    let manifest = prepare_upload(
        &mut session,
        &mut frozen,
        "",
        "2026-11-08T00:00:00Z",
        &Cancellation::default(),
    )
    .unwrap();
    let value: Value = serde_json::from_slice(manifest.bytes()).unwrap();
    let objects = value["browse"]["objects"].as_array().unwrap();
    assert_eq!(objects.len(), 103);
    for (page, count, next) in [(0, 100, json!(1)), (1, 1, Value::Null)] {
        let descriptor = objects
            .iter()
            .find(|v| v["path"] == format!("tree/root/{page}"))
            .unwrap();
        let tree = object(&output, descriptor["hash"].as_str().unwrap());
        assert_eq!(tree["nodes"].as_array().unwrap().len(), count);
        assert_eq!(tree["next"], next);
        assert!(
            tree["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .all(|n| n["title"].as_str().unwrap().starts_with("note "))
        );
    }
}
#[test]
fn capture_projection_rejects_invalid_ack_ids_and_cancellation_before_pending() {
    let root = temp();
    let q = WriteQueue::open(root.path(), 2).unwrap();
    let book = q
        .submit(|s| s.create_notebook("limits"))
        .unwrap()
        .wait()
        .unwrap();
    let mut frozen = freeze(&q, &book.id, root.path());
    let mut session = session(&root.path().join("transfer"));
    assert!(
        prepare_upload_with_captures(
            &mut session,
            &mut frozen,
            "",
            "now",
            &["invalid".into()],
            &Cancellation::default()
        )
        .is_err()
    );
    assert!(session.cursor().unwrap().pending_generation.is_none());
    let cancel = Cancellation::default();
    cancel.cancel();
    assert!(
        prepare_upload(&mut session, &mut frozen, "", "now", &cancel)
            .unwrap_err()
            .cancelled()
    );
    assert!(session.cursor().unwrap().pending_generation.is_none());
}

#[test]
fn optional_browse_budget_failure_still_publishes_receipt_evidence() {
    let root = temp();
    let q = WriteQueue::open(root.path(), 2).unwrap();
    let (book, note) = q
        .submit(|s| {
            let b = s.create_notebook("large tree")?;
            let n = s
                .notebook(&b.id)?
                .create_node(&CreateNode::note("receipt note", "body"), &[])?;
            Ok((b, n))
        })
        .unwrap()
        .wait()
        .unwrap();
    drop(q);
    let db =
        rusqlite::Connection::open(root.path().join(&book.id).join("notebook.sqlite")).unwrap();
    db.execute_batch("WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<30001) INSERT INTO nodes(id,kind,title,sort_key,created_at,updated_at) SELECT printf('00000000-0000-4000-8000-%012d',n),'folder','large tree',n,1,1 FROM seq;").unwrap();
    let capture = id();
    db.execute(
        "INSERT INTO capture_receipts VALUES(?1,?2,?3,1)",
        rusqlite::params![capture, "a".repeat(64), note.node.id],
    )
    .unwrap();
    drop(db);
    let q = WriteQueue::open(root.path(), 2).unwrap();
    let mut frozen = freeze(&q, &book.id, root.path());
    let output = root.path().join("transfer");
    let mut session = session(&output);
    let manifest = prepare_upload_with_captures(
        &mut session,
        &mut frozen,
        "",
        "2026-11-08T00:00:00Z",
        std::slice::from_ref(&capture),
        &Cancellation::default(),
    )
    .unwrap();
    let value: Value = serde_json::from_slice(manifest.bytes()).unwrap();
    assert!(value.get("browse").is_none());
    let acks = object(&output, value["captureAcks"]["hash"].as_str().unwrap());
    assert_eq!(acks[0]["captureId"], capture);
    assert_eq!(acks[0]["noteId"], note.node.id);
}
