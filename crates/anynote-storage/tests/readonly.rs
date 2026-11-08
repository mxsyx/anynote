use anynote_storage::notebook::*;
use rusqlite::Connection;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
};

fn corpus() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/rust-migration/corpus")
}
fn expected() -> Value {
    serde_json::from_slice(&fs::read(corpus().join("expected.json")).unwrap()).unwrap()
}
fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for e in fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        if e.file_type().unwrap().is_dir() {
            copy_tree(&e.path(), &to.join(e.file_name()));
        } else {
            fs::copy(e.path(), to.join(e.file_name())).unwrap();
        }
    }
}
fn fixture() -> (tempfile::TempDir, PathBuf, String) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm04");
    fs::create_dir_all(&root).unwrap();
    let temp = tempfile::tempdir_in(root.canonicalize().unwrap()).unwrap();
    let id = expected()["notebookId"].as_str().unwrap().to_owned();
    let dir = temp.path().join(&id);
    copy_tree(&corpus().join("notebook"), &dir);
    (temp, dir, id)
}
fn fingerprint(root: &Path) -> Vec<(PathBuf, String)> {
    let mut result = Vec::new();
    for e in fs::read_dir(root).unwrap() {
        let e = e.unwrap();
        if e.file_type().unwrap().is_dir() {
            result.extend(fingerprint(&e.path()));
        } else {
            result.push((
                e.path(),
                format!("{:x}", Sha256::digest(fs::read(e.path()).unwrap())),
            ));
        }
    }
    result.sort();
    result
}
fn reject(dir: &Path, kind: ReadErrorKind) {
    let e = ReadonlyNotebook::open(dir, None)
        .err()
        .expect("must reject");
    assert_eq!(e.kind(), kind, "{e}");
}
#[test]
fn frozen_sql_and_reader_preserve_all_rows_bytes_and_unknown_json() {
    let (_temp, dir, id) = fixture();
    let before = fingerprint(&dir);
    let expected = expected();
    let book = ReadonlyNotebook::open(&dir, Some(&id)).unwrap();
    assert_eq!(
        SCHEMA_V5,
        fs::read_to_string(corpus().join("schema.sql")).unwrap()
    );
    assert_eq!(
        BACKUP_REVISION_SQL,
        fs::read_to_string(corpus().join("backup-revision.sql")).unwrap()
    );
    assert!(book.backup_revision().is_some());
    for item in expected["notes"].as_array().unwrap() {
        let id = item["note"]["id"].as_str().unwrap();
        let mut actual = serde_json::to_value(book.note(id).unwrap()).unwrap();
        if actual["note_type"].is_null() {
            actual.as_object_mut().unwrap().remove("note_type");
            actual.as_object_mut().unwrap().remove("source_uri");
        }
        assert_eq!(actual, item["note"]);
        assert_eq!(
            serde_json::to_value(book.history(id).unwrap()).unwrap(),
            item["history"]
        );
    }
    assert_eq!(
        serde_json::to_value(book.extension_records().unwrap()).unwrap(),
        expected["extensionData"]
    );
    assert_eq!(
        serde_json::to_value(book.revision_resources().unwrap()).unwrap(),
        expected["revisionResources"]
    );
    let mut annotations = serde_json::to_value(
        book.annotations(expected["pdfId"].as_str().unwrap(), true)
            .unwrap(),
    )
    .unwrap();
    for a in annotations.as_array_mut().unwrap() {
        a.as_object_mut().unwrap().remove("selector");
    }
    assert_eq!(annotations, expected["annotations"]);
    assert!(
        book.trash()
            .unwrap()
            .iter()
            .any(|n| n.id == expected["trashId"].as_str().unwrap())
    );
    drop(book);
    assert_eq!(before, fingerprint(&dir));
}
#[test]
fn historical_resources_pin_original_hash_and_ranges() {
    let (_temp, dir, id) = fixture();
    let e = expected();
    let book = ReadonlyNotebook::open(&dir, Some(&id)).unwrap();
    let rid = e["boardResourceId"].as_str().unwrap();
    let note = e["boardId"].as_str().unwrap();
    let rev = e["boardRevisionId"].as_str().unwrap();
    let current = book.resource(rid, None).unwrap();
    let mut historical = book
        .resource(rid, Some(ResourceScope::note(note).with_revision(rev)))
        .unwrap();
    assert_ne!(current.info().hash, historical.info().hash);
    let hash = historical.info().hash.clone();
    let size = historical.info().size;
    let bytes = historical.read_range(&hash, 0, size as usize).unwrap();
    let scene: Value = serde_json::from_slice(&bytes).unwrap();
    assert!(!scene["elements"].as_array().unwrap().is_empty());
    assert_eq!(historical.read_range(&hash, 5, 10).unwrap(), bytes[5..15]);
    assert!(historical.read_range(&hash, size + 1, 0).is_err());
    assert!(historical.read_range(&"0".repeat(64), 0, 1).is_err());
    assert!(
        book.resource(
            rid,
            Some(ResourceScope::note(e["pdfId"].as_str().unwrap()).with_revision(rev))
        )
        .is_err()
    );
    let path = dir.join(format!("assets/sha256/{}/{hash}.bin", &hash[..2]));
    fs::write(path, vec![b'x'; size as usize]).unwrap();
    assert!(historical.read_range(&hash, 0, 1).is_err());
    assert!(
        book.resource(rid, Some(ResourceScope::note(note).with_revision(rev)))
            .is_err()
    );
}
#[test]
fn accepts_absent_tracker_but_never_repairs_partial_or_unknown_schema() {
    let (_temp, dir, _) = fixture();
    let db = Connection::open(dir.join("notebook.sqlite")).unwrap();
    let names: Vec<String> = db
        .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    for name in names {
        db.execute_batch(&format!("DROP TRIGGER {name}")).unwrap();
    }
    db.execute_batch("DROP TABLE _backup_revision").unwrap();
    drop(db);
    let before = fingerprint(&dir);
    assert!(
        ReadonlyNotebook::open(&dir, None)
            .unwrap()
            .backup_revision()
            .is_none()
    );
    assert_eq!(before, fingerprint(&dir));
    let db = Connection::open(dir.join("notebook.sqlite")).unwrap();
    db.execute_batch(BACKUP_REVISION_SQL).unwrap();
    drop(db);
    reject(&dir, ReadErrorKind::Corrupt);
    let db = Connection::open(dir.join("notebook.sqlite")).unwrap();
    db.execute_batch("DROP TRIGGER _backup_nodes_insert")
        .unwrap();
    drop(db);
    reject(&dir, ReadErrorKind::IncompatibleSchema);
    let (_temp, dir, _) = fixture();
    let db = Connection::open(dir.join("notebook.sqlite")).unwrap();
    db.execute_batch("UPDATE notebook_meta SET schema_version=999")
        .unwrap();
    drop(db);
    reject(&dir, ReadErrorKind::UnsupportedVersion);
}
#[test]
fn rejects_changed_sql_missing_assets_cycles_and_wrong_identity() {
    for sql in [
        "CREATE TABLE extra(x)",
        "CREATE INDEX extra ON nodes(title)",
    ] {
        let (_temp, dir, _) = fixture();
        let db = Connection::open(dir.join("notebook.sqlite")).unwrap();
        db.execute_batch(sql).unwrap();
        drop(db);
        let before = fingerprint(&dir);
        reject(&dir, ReadErrorKind::IncompatibleSchema);
        assert_eq!(before, fingerprint(&dir));
    }
    let (_temp, dir, _) = fixture();
    let db = Connection::open(dir.join("notebook.sqlite")).unwrap();
    db.execute("UPDATE nodes SET parent_id=id WHERE kind='folder'", [])
        .unwrap();
    drop(db);
    reject(&dir, ReadErrorKind::Corrupt);
    let (_temp, dir, _) = fixture();
    assert_eq!(
        ReadonlyNotebook::open(&dir, Some(&uuid::Uuid::new_v4().to_string()))
            .err()
            .unwrap()
            .kind(),
        ReadErrorKind::IdentityConflict
    );
    let leaf = fs::read_dir(dir.join("assets/sha256"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let asset = fs::read_dir(leaf).unwrap().next().unwrap().unwrap().path();
    fs::remove_file(asset).unwrap();
    reject(&dir, ReadErrorKind::Offline);
}
#[test]
fn readonly_lru_offline_registry_duplicate_and_replaced_file() {
    let (temp, dir, id) = fixture();
    let mut catalog = ReadonlyCatalog::open(temp.path(), 1).unwrap();
    assert_eq!(catalog.entries().len(), 1);
    catalog.read(&id).unwrap();
    let offline = uuid::Uuid::new_v4().to_string();
    fs::create_dir_all(temp.path().join("_local")).unwrap();
    fs::write(
        temp.path().join("_local/notebook-directories.json"),
        serde_json::to_vec(
            &json!([{"id":offline,"name":"离线","path":temp.path().join("missing")}]),
        )
        .unwrap(),
    )
    .unwrap();
    catalog.refresh().unwrap();
    let entries = catalog.diagnose();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[1].error, Some(ReadErrorKind::Offline));
    assert!(catalog.connection_count() <= 1);
    let file = dir.join("notebook.sqlite");
    let replacement = dir.join("replacement");
    fs::copy(&file, &replacement).unwrap();
    let book = catalog.read(&id).unwrap();
    fs::rename(replacement, file).unwrap();
    assert!(book.nodes().is_err());
    catalog.read(&id).unwrap();
    fs::write(
        temp.path().join("_local/notebook-directories.json"),
        serde_json::to_vec(&json!([{"id":id,"name":"重复","path":dir}])).unwrap(),
    )
    .unwrap();
    assert_eq!(
        catalog.refresh().err().unwrap().kind(),
        ReadErrorKind::IdentityConflict
    );
}
#[test]
fn search_cancel_and_validation_are_explicit_and_readonly() {
    let (temp, dir, _) = fixture();
    let before = fingerprint(&dir);
    let mut catalog = ReadonlyCatalog::open(temp.path(), 1).unwrap();
    let req = SearchRequest::new(uuid::Uuid::new_v4().to_string(), "中文".into());
    let result = catalog
        .search(&req, Arc::new(AtomicBool::new(false)))
        .unwrap();
    assert!(!result.results.is_empty());
    assert_eq!(
        result.results[0].location,
        Some(SearchLocation::Text {
            query: "中文".into()
        })
    );
    let result = catalog
        .search(&req, Arc::new(AtomicBool::new(true)))
        .unwrap();
    assert!(result.cancelled);
    assert!(!result.truncated);
    assert!(result.results.is_empty());
    let mut bad = req;
    bad.folder_id = Some(uuid::Uuid::new_v4().to_string());
    assert!(
        catalog
            .search(&bad, Arc::new(AtomicBool::new(false)))
            .is_err()
    );
    drop(catalog);
    assert_eq!(before, fingerprint(&dir));
}
#[cfg(unix)]
#[test]
fn rejects_symlink_roots_sidecars_assets_and_backup_directories() {
    use std::os::unix::fs::symlink;
    let (temp, dir, _) = fixture();
    let alias = temp.path().join("alias");
    symlink(&dir, &alias).unwrap();
    reject(&alias, ReadErrorKind::UnsafePath);
    symlink(temp.path().join("missing"), dir.join("notebook.sqlite-wal")).unwrap();
    reject(&dir, ReadErrorKind::UnsafePath);
    fs::remove_file(dir.join("notebook.sqlite-wal")).unwrap();
    fs::create_dir(dir.join(".backup")).unwrap();
    reject(&dir, ReadErrorKind::UnsafePath);
    fs::remove_dir(dir.join(".backup")).unwrap();
    fs::rename(dir.join("assets"), temp.path().join("outside-assets")).unwrap();
    symlink(temp.path().join("outside-assets"), dir.join("assets")).unwrap();
    reject(&dir, ReadErrorKind::UnsafePath);
}
#[test]
fn real_wal_reads_only_committed_rows_and_respects_exclusive_writer() {
    let (_temp, dir, _) = fixture();
    let db = Connection::open(dir.join("notebook.sqlite")).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL; UPDATE notebook_meta SET name='committed'; BEGIN IMMEDIATE; UPDATE notebook_meta SET name='uncommitted';").unwrap();
    let before = fingerprint(&dir);
    let book = ReadonlyNotebook::open(&dir, None).unwrap();
    assert_eq!(book.metadata().name, "committed");
    drop(book);
    assert_eq!(before, fingerprint(&dir));
    db.execute_batch("ROLLBACK; PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;").unwrap();
    reject(&dir, ReadErrorKind::Busy);
}

#[test]
fn lru_reopens_after_wal_commit_and_refuses_missing_shm_recovery() {
    let (temp, dir, id) = fixture();
    let db = Connection::open(dir.join("notebook.sqlite")).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL; UPDATE notebook_meta SET name='one'")
        .unwrap();
    let mut catalog = ReadonlyCatalog::open(temp.path(), 1).unwrap();
    assert_eq!(catalog.read(&id).unwrap().metadata().name, "one");
    db.execute_batch("UPDATE notebook_meta SET name='two'")
        .unwrap();
    assert_eq!(catalog.read(&id).unwrap().metadata().name, "two");
    drop(catalog);
    let copy = temp.path().join("wal-copy");
    copy_tree(&dir, &copy);
    fs::remove_file(copy.join("notebook.sqlite-shm")).unwrap();
    let before = fingerprint(&copy);
    reject(&copy, ReadErrorKind::Busy);
    assert_eq!(before, fingerprint(&copy));
}

#[test]
fn rejects_missing_pins_invalid_json_foreign_keys_and_truncated_db() {
    let (_temp, dir, _) = fixture();
    let db = Connection::open(dir.join("notebook.sqlite")).unwrap();
    db.execute_batch("DELETE FROM revision_resources WHERE revision_id IN (SELECT id FROM note_revisions WHERE body LIKE '%anynote%')").unwrap();
    drop(db);
    reject(&dir, ReadErrorKind::Corrupt);
    let (_temp, dir, _) = fixture();
    let db = Connection::open(dir.join("notebook.sqlite")).unwrap();
    db.execute_batch("UPDATE nodes SET tags='[invalid'")
        .unwrap();
    drop(db);
    reject(&dir, ReadErrorKind::Corrupt);
    let (_temp, dir, _) = fixture();
    let db = Connection::open(dir.join("notebook.sqlite")).unwrap();
    db.execute_batch("PRAGMA foreign_keys=OFF; DELETE FROM assets")
        .unwrap();
    drop(db);
    reject(&dir, ReadErrorKind::Corrupt);
    let (_temp, dir, _) = fixture();
    fs::write(dir.join("notebook.sqlite"), b"not sqlite").unwrap();
    reject(&dir, ReadErrorKind::Corrupt);
}

#[test]
fn preserves_large_integer_counters_and_raw_unknown_json() {
    let (_temp, dir, _) = fixture();
    let db = Connection::open(dir.join("notebook.sqlite")).unwrap();
    let raw = "{ \"b\":1e+20,\"a\": [ 9007199254740993, \"\\u4e2d\" ] }";
    db.execute(
        "UPDATE extension_data SET value_json=? WHERE extension_id='unknown.fixture'",
        [raw],
    )
    .unwrap();
    db.execute_batch("UPDATE notebook_meta SET content_seq=9007199254740993; UPDATE _backup_revision SET storage_epoch=9223372036854775807").unwrap();
    drop(db);
    let before = fingerprint(&dir);
    let book = ReadonlyNotebook::open(&dir, None).unwrap();
    assert_eq!(
        book.backup_revision().unwrap().content_seq,
        "9007199254740993"
    );
    assert_eq!(
        book.backup_revision().unwrap().storage_epoch,
        "9223372036854775807"
    );
    assert_eq!(
        book.extension_records()
            .unwrap()
            .into_iter()
            .find(|r| r.extension_id == "unknown.fixture")
            .unwrap()
            .value_json,
        raw
    );
    drop(book);
    assert_eq!(before, fingerprint(&dir));
}

#[test]
fn lru_evicts_and_reopens_without_merging_duplicate_note_ids_across_books() {
    let (temp, dir, id) = fixture();
    let mut ids = vec![id];
    for _ in 0..6 {
        let id = uuid::Uuid::new_v4().to_string();
        let copy = temp.path().join(&id);
        copy_tree(&dir, &copy);
        let db = Connection::open(copy.join("notebook.sqlite")).unwrap();
        db.execute("UPDATE notebook_meta SET id=?", [&id]).unwrap();
        ids.push(id);
    }
    let before = fingerprint(temp.path());
    let mut catalog = ReadonlyCatalog::open(temp.path(), 2).unwrap();
    for id in &ids {
        assert_eq!(catalog.read(id).unwrap().metadata().id, *id);
        assert!(catalog.connection_count() <= 2);
    }
    let request = SearchRequest::new(uuid::Uuid::new_v4().to_string(), "中文".into());
    let result = catalog
        .search(&request, Arc::new(AtomicBool::new(false)))
        .unwrap();
    assert_eq!(result.searched, 7);
    assert_eq!(result.results.len(), 7);
    assert_eq!(
        result
            .results
            .iter()
            .map(|r| &r.node.id)
            .collect::<std::collections::HashSet<_>>()
            .len(),
        1
    );
    assert_eq!(
        result
            .results
            .iter()
            .map(|r| &r.notebook_id)
            .collect::<std::collections::HashSet<_>>()
            .len(),
        7
    );
    assert_eq!(catalog.connection_count(), 2);
    drop(catalog);
    assert_eq!(before, fingerprint(temp.path()));
}
