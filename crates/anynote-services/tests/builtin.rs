use anynote_core::{backend::ErrorCode, builtin::*, document_session::*};
use anynote_services::{builtin::execute, config_migration::plugins};
use anynote_storage::notebook::*;
use serde_json::json;
use std::{fs, path::Path};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

fn snapshot(book: &str, note: &Note) -> DocumentSnapshot {
    DocumentSnapshot::new(
        DocumentId::new(
            Uuid::parse_str(book).unwrap(),
            Uuid::parse_str(&note.node.id).unwrap(),
        ),
        note.node.revision,
        Uuid::parse_str(note.head_revision_id.as_ref().unwrap()).unwrap(),
        DocumentContent::new(
            note.node.title.clone(),
            note.body.clone(),
            note.node.tags.clone(),
            note.node.favorite != 0,
        ),
    )
}
fn fixture() -> (tempfile::TempDir, WriteQueue, String, Note) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm20");
    fs::create_dir_all(&root).unwrap();
    let dir = tempfile::tempdir_in(root.canonicalize().unwrap()).unwrap();
    let queue = WriteQueue::open(dir.path(), 8).unwrap();
    let (book, note) = queue
        .submit(|catalog| {
            let book = catalog.create_notebook("阅读")?.id;
            let note = catalog
                .notebook(&book)?
                .create_node(&CreateNode::note("阅读记录 📚", "A📚e\u{301}\r\n"), &[])?;
            Ok((book, note))
        })
        .unwrap()
        .wait()
        .unwrap();
    (dir, queue, book, note)
}
fn request(book: &str, note: &Note, command: ReadingCommand) -> ReadingRequest {
    ReadingRequest::new(Uuid::new_v4(), snapshot(book, note), command)
}
#[tokio::test]
async fn utf16_templates_goals_and_related_results_preserve_body() {
    let (_dir, queue, book, mut note) = fixture();
    let original = note.body.clone();
    let n = original.encode_utf16().count();
    note = execute(
        &queue,
        request(&book, &note, ReadingCommand::Count),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(
        note.body,
        format!("{original}\n\n## 阅读统计\n\n正文字符数：{n}\n")
    );
    for command in [
        ReadingCommand::AppendTemplate,
        ReadingCommand::AppendGoal,
        ReadingCommand::Related,
        ReadingCommand::AsyncRelated,
    ] {
        let before = note.body.clone();
        note = execute(
            &queue,
            request(&book, &note, command),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert!(note.body.starts_with(&before));
    }
    assert!(note.body.contains("目标：3 篇。"));
    assert!(note.body.contains("## 异步相关阅读索引"));
    assert!(note.body.contains("- 阅读记录 📚："));
}
#[tokio::test]
async fn state_body_receipt_replay_cas_and_reopen_are_atomic() {
    let (dir, queue, book, note) = fixture();
    let req = request(&book, &note, ReadingCommand::RecordSession);
    let saved = execute(&queue, req.clone(), &CancellationToken::new())
        .await
        .unwrap();
    let again = execute(&queue, req, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(saved.head_revision_id, again.head_revision_id);
    let failed = execute(
        &queue,
        request(&book, &note, ReadingCommand::RecordSession),
        &CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert_eq!(failed.code(), ErrorCode::Conflict);
    drop(queue);
    let read = ReadonlyNotebook::open(&dir.path().join(&book), Some(&book)).unwrap();
    assert_eq!(
        read.builtin_value("reading.session")
            .unwrap()
            .unwrap()
            .value()["visits"],
        1
    );
    assert_eq!(read.note(&note.node.id).unwrap().body, saved.body);
    assert_eq!(read.history(&note.node.id).unwrap().len(), 2);
    assert_eq!(
        read.extension_records()
            .unwrap()
            .iter()
            .filter(|r| r.key.starts_with("reading.receipt."))
            .count(),
        1
    );
}
#[tokio::test]
async fn create_record_is_idempotent_and_does_not_change_source_note() {
    let (dir, queue, book, note) = fixture();
    let req = request(&book, &note, ReadingCommand::CreateRecord);
    let created = execute(&queue, req.clone(), &CancellationToken::new())
        .await
        .unwrap();
    assert_ne!(created.node.id, note.node.id);
    assert_eq!(created.node.title, "阅读记录");
    assert_eq!(
        execute(&queue, req, &CancellationToken::new())
            .await
            .unwrap()
            .node
            .id,
        created.node.id
    );
    drop(queue);
    let read = ReadonlyNotebook::open(&dir.path().join(&book), Some(&book)).unwrap();
    assert_eq!(read.nodes().unwrap().len(), 2);
    assert_eq!(read.note(&note.node.id).unwrap().body, note.body);
}
#[tokio::test]
async fn settings_validate_and_compare_revision_and_disabled_goal_is_noop() {
    let (_dir, queue, book, note) = fixture();
    let id = book.clone();
    queue
        .submit(move |catalog| {
            let b = catalog.notebook(&id)?;
            let (revision, mut preferences) = b.read().builtin_preferences()?;
            assert!(!preferences.remote_embed);
            preferences.goal = 0;
            assert!(b.set_builtin_preferences(revision, &preferences).is_err());
            preferences.goal = 7;
            preferences.enabled = false;
            preferences.remote_embed = true;
            let next = b.set_builtin_preferences(revision, &preferences)?;
            assert!(b.set_builtin_preferences(revision, &preferences).is_err());
            assert_eq!(b.read().builtin_preferences()?.0, next);
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let saved = execute(
        &queue,
        request(&book, &note, ReadingCommand::AppendGoal),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(saved.body, note.body);
    assert_eq!(saved.node.revision, note.node.revision);
}
#[tokio::test]
async fn cancellation_and_private_network_failure_write_nothing() {
    let (dir, queue, book, note) = fixture();
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert_eq!(
        execute(
            &queue,
            request(&book, &note, ReadingCommand::Count),
            &cancel
        )
        .await
        .unwrap_err()
        .code(),
        ErrorCode::Cancelled
    );
    let req = request(
        &book,
        &note,
        ReadingCommand::PublicText {
            url: "http://127.0.0.1/private".into(),
        },
    );
    assert!(
        execute(&queue, req, &CancellationToken::new())
            .await
            .is_err()
    );
    drop(queue);
    let read = ReadonlyNotebook::open(&dir.path().join(&book), Some(&book)).unwrap();
    assert_eq!(read.metadata().content_seq, 1);
    assert_eq!(read.note(&note.node.id).unwrap().body, note.body);
}
#[test]
fn known_business_requires_exact_manifest_and_checksum() {
    let records: Vec<serde_json::Value> = serde_json::from_str(include_str!(
        "../../../tests/fixtures/builtin/known-manifests.json"
    ))
    .unwrap();
    assert_eq!(records.len(), 9);
    for mut record in records {
        assert!(plugins::is_known_business(&record));
        record["manifest"]["name"] = json!("modified");
        assert!(!plugins::is_known_business(&record));
    }
    assert!(!plugins::is_known_business(
        &json!({"manifest":{"id":"user.required"},"checksum":"anything"})
    ));
}
#[tokio::test]
async fn migrated_v1_and_v2_counters_keep_unknown_values() {
    for (version, count_key, schema) in [("0.1.0", "runs", 1), ("0.1.1", "visits", 2)] {
        let (dir, queue, book, note) = fixture();
        let entries: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../../tests/fixtures/rust-migration/config/known-state-mappings.json"
        ))
        .unwrap();
        let entry = entries
            .into_iter()
            .find(|e| {
                e["manifest"]["id"] == "garden.session" && e["manifest"]["version"] == version
            })
            .unwrap();
        let row: plugins::LegacyState = serde_json::from_value(json!({"extension_id":"garden.session","key":"script:state","schema_version":schema,"revision":5,"value_json":json!({count_key:4,"lastTitle":"old","future":{"keep":true}}).to_string()})).unwrap();
        let id = book.clone();
        queue
            .submit(move |catalog| {
                anynote_services::builtin::migrate_state(
                    catalog.notebook(&id)?,
                    &entry.to_string(),
                    &row,
                )
                .unwrap();
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
        let saved = execute(
            &queue,
            request(&book, &note, ReadingCommand::RecordSession),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert!(saved.body.contains("第 5 次整理"));
        drop(queue);
        let read = ReadonlyNotebook::open(&dir.path().join(&book), Some(&book)).unwrap();
        let row = read.builtin_value("reading.session").unwrap().unwrap();
        assert_eq!(row.value()["future"]["keep"], true);
        assert_eq!(row.value()["lastTitle"], "阅读记录 📚");
    }
}

#[test]
fn trusted_examples_need_source_checksums_too() {
    let path = "packages/extension-host/src/examples/reading-template.ts";
    let source = include_bytes!("../../../tests/fixtures/legacy-business/reading-template.ts.txt");
    assert!(plugins::is_known_source(path, source));
    let mut changed = source.to_vec();
    changed.push(b' ');
    assert!(!plugins::is_known_source(path, &changed));
    assert!(!plugins::is_known_source("user/required.ts", source));
}

#[test]
fn legacy_goal_versions_convert_without_overwriting_native_preferences() {
    for (version, field) in [("0.1.0", "target"), ("0.1.1", "goal")] {
        let (_dir, queue, book, _note) = fixture();
        let entries: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../../tests/fixtures/rust-migration/config/known-state-mappings.json"
        ))
        .unwrap();
        let entry = entries
            .into_iter()
            .find(|e| {
                e["manifest"]["id"] == "garden.preferences" && e["manifest"]["version"] == version
            })
            .unwrap();
        let row: plugins::LegacyState = serde_json::from_value(json!({"extension_id":"garden.preferences","key":"settings:form","schema_version":1,"revision":3,"value_json":json!({"format":"anynote.extension-settings.v1","schemaChecksum":entry["settingsChecksum"],"values":{"heading":"旧目标",field:8,"enabled":false}}).to_string()})).unwrap();
        queue
            .submit(move |catalog| {
                let b = catalog.notebook(&book)?;
                anynote_services::builtin::migrate_state(b, &entry.to_string(), &row).unwrap();
                let (revision, mut p) = b.read().builtin_preferences()?;
                assert_eq!(p.heading, "旧目标");
                assert_eq!(p.goal, 8);
                assert!(!p.enabled);
                assert!(!p.remote_embed);
                p.goal = 10;
                b.set_builtin_preferences(revision, &p)?;
                assert!(
                    anynote_services::builtin::migrate_state(b, &entry.to_string(), &row).is_err()
                );
                assert_eq!(b.read().builtin_preferences()?.1.goal, 10);
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
    }
}

#[tokio::test]
async fn cancelled_public_network_businesses_keep_cancelled_error() {
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert_eq!(
        anynote_services::builtin::public_text("https://example.com/", &cancel)
            .await
            .unwrap_err()
            .code(),
        ErrorCode::Cancelled
    );
    let card = anynote_core::video::VideoCard::parse("https://example.com/").unwrap();
    assert_eq!(
        anynote_services::video::fetch(&card, &cancel)
            .await
            .unwrap_err()
            .code(),
        ErrorCode::Cancelled
    );
}
