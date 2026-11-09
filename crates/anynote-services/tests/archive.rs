use anynote_services::{archive::*, open_export::*};
use anynote_storage::notebook::*;
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

fn temp() -> tempfile::TempDir {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm08");
    fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root.canonicalize().unwrap()).unwrap()
}
fn fixture() -> (tempfile::TempDir, WriteQueue, String, String) {
    let dir = temp();
    let queue = WriteQueue::open(dir.path(), 2).unwrap();
    let (id,note)=queue.submit(|s|{
        let id=s.create_notebook("Archive")?.id;
        let book=s.notebook(&id)?;
        let note=book.create_node(&CreateNode::note("CON", "SECRET_OLD_REVISION"),&[])?;
        book.save_note(&note.node.id,1,&NotePatch {body:Some(format!("当前文本 anynote://notebook/{id}/note/{}#anchor\n:::anynote{{type=\"unknown.vendor\" version=\"99\"}}\n{{\"opaque\":true}}\n:::\n",note.node.id)),..Default::default()},&[])?;
        let trash=book.create_node(&CreateNode::note("trash","SECRET_TRASH_BODY"),&[])?;
        book.trash_node(&trash.node.id)?;
        Ok((id,note.node.id))
    }).unwrap().wait().unwrap();
    drop(queue);
    let db = Connection::open(dir.path().join(&id).join("notebook.sqlite")).unwrap();
    db.execute(
        "INSERT INTO extension_data VALUES('unknown.vendor','opaque.state',?,9,7)",
        [" { \"secret\" : \"SECRET_EXTENSION_STATE\" } "],
    )
    .unwrap();
    drop(db);
    let queue = WriteQueue::open(dir.path(), 2).unwrap();
    (dir, queue, id, note)
}
fn cut(q: &WriteQueue, root: &Path, id: &str) -> FrozenSnapshot {
    let root = root.to_owned();
    let id = id.to_owned();
    q.submit(move |s| s.capture_snapshot(&id, &root, &Cancellation::default()))
        .unwrap()
        .wait()
        .unwrap()
}
fn unzip(file: &Path) -> Vec<(String, Vec<u8>)> {
    let mut zip = ZipArchive::new(fs::File::open(file).unwrap()).unwrap();
    (0..zip.len())
        .map(|i| {
            let mut e = zip.by_index(i).unwrap();
            let name = e.name().to_owned();
            let mut bytes = Vec::new();
            e.read_to_end(&mut bytes).unwrap();
            (name, bytes)
        })
        .collect()
}
fn rewrite(input: &Path, output: &Path, change: impl FnOnce(&mut Vec<(String, Vec<u8>)>)) {
    let mut entries = unzip(input);
    change(&mut entries);
    let mut zip = ZipWriter::new(fs::File::create(output).unwrap());
    for (name, bytes) in entries {
        zip.start_file(name, SimpleFileOptions::default()).unwrap();
        zip.write_all(&bytes).unwrap();
    }
    zip.finish().unwrap();
}
#[test]
fn wal_cut_releases_queue_pins_lease_and_reopen_changes_identity() {
    let (dir, q, id, note) = fixture();
    let mut frozen = cut(&q, dir.path(), &id);
    let lease = frozen.revision().lineage_id.clone();
    let book_id = id.clone();
    let nid = note.clone();
    q.submit(move |s| {
        s.notebook(&book_id)?.save_note(
            &nid,
            2,
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
    frozen
        .prepare(SnapshotMode::Full, &Cancellation::default())
        .unwrap();
    let b = ReadonlyNotebook::open(frozen.path(), Some(&id)).unwrap();
    assert!(b.note(&note).unwrap().body.contains("当前文本"));
    drop(b);
    let book_id = id.clone();
    assert!(
        q.submit(move |s| s.close_notebook(&book_id))
            .unwrap()
            .wait()
            .is_err()
    );
    let temporary = frozen.path().to_owned();
    drop(frozen);
    assert!(!temporary.exists());
    let book_id = id.clone();
    q.submit(move |s| s.close_notebook(&book_id))
        .unwrap()
        .wait()
        .unwrap();
    let next = cut(&q, dir.path(), &id);
    assert_ne!(next.revision().lineage_id, lease);
}
#[test]
fn full_and_current_zip64_roundtrip_and_current_erases_old_pages() {
    let (dir, q, id, note) = fixture();
    for (mode, name) in [
        (SnapshotMode::Full, "full"),
        (SnapshotMode::Current, "current"),
    ] {
        let output = dir.path().join(format!("{name}.anynote"));
        let mut frozen = cut(&q, dir.path(), &id);
        let m = export_archive(&mut frozen, mode, &output, true, &Cancellation::default()).unwrap();
        assert_eq!(m.includes_history, Some(mode == SnapshotMode::Full));
        let checked = validate_archive(&output, dir.path(), &Cancellation::default()).unwrap();
        let book = ReadonlyNotebook::open(checked.path(), Some(&id)).unwrap();
        assert_eq!(
            book.history(&note).unwrap().len(),
            if mode == SnapshotMode::Full { 2 } else { 1 }
        );
        let bytes = fs::read(checked.path().join("notebook.sqlite")).unwrap();
        if mode == SnapshotMode::Current {
            for secret in [
                "SECRET_OLD_REVISION",
                "SECRET_TRASH_BODY",
                "SECRET_EXTENSION_STATE",
            ] {
                assert!(!bytes.windows(secret.len()).any(|w| w == secret.as_bytes()));
            }
        }
        let meta = import_archive(&output, dir.path(), &Cancellation::default()).unwrap();
        let restored = ReadonlyNotebook::open(&dir.path().join(&meta.id), Some(&meta.id)).unwrap();
        assert!(
            restored
                .note(&note)
                .unwrap()
                .body
                .contains(&format!("anynote://notebook/{}/", meta.id))
        );
        assert_ne!(meta.id, id);
    }
}
#[test]
fn persistent_snapshot_restore_survives_corrupt_source_and_rejects_bad_name() {
    let (dir, q, id, note) = fixture();
    let snap = snapshot(&q, &id, dir.path(), &Cancellation::default()).unwrap();
    drop(q);
    let root = dir.path().join(&id);
    let path = root.join("notebook.sqlite");
    fs::write(&path, b"corrupt database evidence").unwrap();
    assert_eq!(list_snapshots(&root).unwrap().len(), 1);
    let imported =
        restore_snapshot(&root, &snap.name, dir.path(), &Cancellation::default()).unwrap();
    assert_eq!(
        ReadonlyNotebook::open(&dir.path().join(imported.id), None)
            .unwrap()
            .history(&note)
            .unwrap()
            .len(),
        2
    );
    assert_eq!(fs::read(path).unwrap(), b"corrupt database evidence");
    assert!(
        restore_snapshot(
            &root,
            "../bad.anynote",
            dir.path(),
            &Cancellation::default()
        )
        .is_err()
    );
}
#[test]
fn malformed_archives_rejected_without_published_library() {
    let (dir, q, id, _) = fixture();
    let good = dir.path().join("good.anynote");
    export_archive(
        &mut cut(&q, dir.path(), &id),
        SnapshotMode::Full,
        &good,
        false,
        &Cancellation::default(),
    )
    .unwrap();
    for kind in [
        "hash",
        "identity",
        "requirements",
        "flags",
        "path",
        "extra",
        "missing",
        "version",
    ] {
        let bad = dir.path().join(format!("{kind}.anynote"));
        rewrite(&good, &bad, |entries| {
            if kind == "path" {
                entries.push(("../escape".into(), b"bad".to_vec()));
                return;
            }
            if kind == "extra" {
                entries.push((format!("assets/sha256/00/{}.bin", "0".repeat(64)), vec![]));
                return;
            }
            if kind == "missing" {
                entries.retain(|(n, _)| n != "notebook.sqlite");
                return;
            }
            let (_, bytes) = entries
                .iter_mut()
                .find(|(n, _)| n == "manifest.json")
                .unwrap();
            let mut m: Value = serde_json::from_slice(bytes).unwrap();
            match kind {
                "hash" => m["database"]["sha256"] = json!("0".repeat(64)),
                "identity" => m["notebookId"] = json!(uuid::Uuid::new_v4().to_string()),
                "requirements" => m["requiredExtensions"]["blocks"] = json!([]),
                "flags" => m["includesHistory"] = json!(false),
                "version" => m["schemaVersion"] = json!(4),
                _ => unreachable!(),
            }
            *bytes = serde_json::to_vec(&m).unwrap();
        });
        let before = fs::read_dir(dir.path()).unwrap().count();
        assert!(
            import_archive(&bad, dir.path(), &Cancellation::default()).is_err(),
            "{kind}"
        );
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), before);
    }
}
#[test]
fn cancelled_or_existing_output_never_publishes_partial_archive() {
    let (dir, q, id, _) = fixture();
    let mut frozen = cut(&q, dir.path(), &id);
    let path = dir.path().join("output.anynote");
    let cancel = Cancellation::default();
    cancel.cancel();
    assert!(export_archive(&mut frozen, SnapshotMode::Full, &path, false, &cancel).is_err());
    assert!(!path.exists());
    fs::write(&path, b"successful previous output").unwrap();
    assert!(
        export_archive(
            &mut frozen,
            SnapshotMode::Full,
            &path,
            false,
            &Cancellation::default()
        )
        .is_err()
    );
    assert_eq!(fs::read(path).unwrap(), b"successful previous output");
    assert!(!fs::read_dir(dir.path()).unwrap().any(|e| {
        e.unwrap()
            .path()
            .extension()
            .is_some_and(|x| x == "partial")
    }));
}
#[test]
fn cleanup_requires_confirmation_rechecks_references_and_retains_recovery() {
    let (dir, q, id, note) = fixture();
    let snapshots = dir.path().join(&id).join("snapshots");
    fs::create_dir(&snapshots).unwrap();
    for i in 1..=3 {
        fs::write(
            snapshots.join(format!("{i}.anynote")),
            format!("archive{i}"),
        )
        .unwrap();
    }
    let bid = id.clone();
    let preview = q
        .submit(move |s| s.preview_cleanup(&bid, 1, 0))
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(preview.files.len(), 2);
    let bid = id.clone();
    let pid = preview.id.clone();
    assert!(
        q.submit(move |s| s.apply_cleanup(&bid, &pid, false))
            .unwrap()
            .wait()
            .is_err()
    );
    let bid = id.clone();
    q.submit(move |s| {
        s.notebook(&bid)?.save_note(
            &note,
            2,
            &NotePatch {
                body: Some("new reference".into()),
                ..Default::default()
            },
            &[],
        )
    })
    .unwrap()
    .wait()
    .unwrap();
    let bid = id.clone();
    assert!(
        q.submit(move |s| s.apply_cleanup(&bid, &preview.id, true))
            .unwrap()
            .wait()
            .is_err()
    );
    let bid = id.clone();
    let preview = q
        .submit(move |s| s.preview_cleanup(&bid, 1, 0))
        .unwrap()
        .wait()
        .unwrap();
    let frozen = cut(&q, dir.path(), &id);
    let bid = id.clone();
    let pid = preview.id.clone();
    assert!(
        q.submit(move |s| s.apply_cleanup(&bid, &pid, true))
            .unwrap()
            .wait()
            .is_err()
    );
    drop(frozen);
    let bid = id.clone();
    let result = q
        .submit(move |s| s.apply_cleanup(&bid, &preview.id, true))
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(result.quarantined, 2);
    assert!(!snapshots.join("1.anynote").exists());
    assert!(snapshots.join("3.anynote").exists());
    assert_eq!(
        recover_cleanup(&dir.path().join(&id), &id, &result.recovery_id).unwrap(),
        2
    );
    assert!(snapshots.join("1.anynote").exists());
    let bid = id.clone();
    let preview = q
        .submit(move |s| s.preview_cleanup(&bid, 1, 0))
        .unwrap()
        .wait()
        .unwrap();
    drop(q);
    let q = WriteQueue::open(dir.path(), 1).unwrap();
    assert!(
        q.submit(move |s| s.apply_cleanup(&id, &preview.id, true))
            .unwrap()
            .wait()
            .is_err()
    );
}
#[test]
fn changed_cleanup_candidate_and_recovery_collision_preserve_files() {
    let (dir, q, id, _) = fixture();
    let snapshots = dir.path().join(&id).join("snapshots");
    fs::create_dir(&snapshots).unwrap();
    for i in 1..=2 {
        fs::write(snapshots.join(format!("{i}.anynote")), b"original").unwrap();
    }
    let bid = id.clone();
    let preview = q
        .submit(move |s| s.preview_cleanup(&bid, 1, 0))
        .unwrap()
        .wait()
        .unwrap();
    fs::write(snapshots.join("1.anynote"), b"modified").unwrap();
    let bid = id.clone();
    assert!(
        q.submit(move |s| s.apply_cleanup(&bid, &preview.id, true))
            .unwrap()
            .wait()
            .is_err()
    );
    let bid = id.clone();
    let result = q
        .submit(move |s| {
            let p = s.preview_cleanup(&bid, 1, 0)?;
            s.apply_cleanup(&bid, &p.id, true)
        })
        .unwrap()
        .wait()
        .unwrap();
    fs::write(snapshots.join("1.anynote"), b"new snapshot").unwrap();
    assert!(recover_cleanup(&dir.path().join(&id), &id, &result.recovery_id).is_err());
    assert_eq!(
        fs::read(snapshots.join("1.anynote")).unwrap(),
        b"new snapshot"
    );
}
#[test]
fn markdown_directory_zip_map_unknown_blocks_links_and_empty_folders() {
    let (dir, q, id, note) = fixture();
    let bid = id.clone();
    q.submit(move |s| {
        let mut n = CreateNode::note("空目录", "");
        n.kind = NodeKind::Folder;
        n.note_type = None;
        s.notebook(&bid)?.create_node(&n, &[])
    })
    .unwrap()
    .wait()
    .unwrap();
    for format in [OpenExportFormat::Directory, OpenExportFormat::Zip] {
        let output = dir.path().join(if matches!(format, OpenExportFormat::Zip) {
            "open.zip"
        } else {
            "open"
        });
        export_markdown(
            &mut cut(&q, dir.path(), &id),
            &output,
            format,
            &Cancellation::default(),
        )
        .unwrap();
        let files = if matches!(format, OpenExportFormat::Zip) {
            unzip(&output)
        } else {
            fs::read_dir(&output)
                .unwrap()
                .filter_map(|e| {
                    let e = e.unwrap();
                    e.file_type().unwrap().is_file().then(|| {
                        (
                            e.file_name().to_str().unwrap().into(),
                            fs::read(e.path()).unwrap(),
                        )
                    })
                })
                .collect()
        };
        let map: Value = serde_json::from_slice(
            &files
                .iter()
                .find(|(n, _)| n == "EXPORT-MAP.json")
                .unwrap()
                .1,
        )
        .unwrap();
        let path = map["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == note)
            .unwrap()["path"]
            .as_str()
            .unwrap();
        assert!(path.starts_with("_CON-"));
        let body =
            String::from_utf8(files.iter().find(|(n, _)| n == path).unwrap().1.clone()).unwrap();
        assert!(body.contains("unknown.vendor"));
        assert!(!body.contains("anynote://"));
        assert!(!body.contains("SECRET"));
        if matches!(format, OpenExportFormat::Zip) {
            assert!(files.iter().any(|(n, _)| n.ends_with('/')));
        }
    }
}
#[test]
fn integrity_evidence_keeps_unpruned_corruption_and_rejects_pruned_cut() {
    let (dir, q, id, _) = fixture();
    let mut frozen = cut(&q, dir.path(), &id);
    let output = dir.path().join("evidence");
    fs::write(frozen.path().join("notebook.sqlite"), b"damaged cut").unwrap();
    let report = inspect_snapshot(&frozen, &output, &Cancellation::default()).unwrap();
    assert!(!report.ok);
    assert!(report.issue.is_some());
    assert_eq!(
        fs::read(output.join("notebook.sqlite")).unwrap(),
        b"damaged cut"
    );
    assert!(
        frozen
            .prepare(SnapshotMode::Preservation, &Cancellation::default())
            .is_err()
    );
    let mut frozen = cut(&q, dir.path(), &id);
    frozen
        .prepare(SnapshotMode::Full, &Cancellation::default())
        .unwrap();
    assert!(
        inspect_snapshot(
            &frozen,
            &dir.path().join("invalid-evidence"),
            &Cancellation::default()
        )
        .is_err()
    );
}

#[test]
fn duplicate_central_entry_bomb_encryption_and_symlink_are_rejected() {
    let (dir, q, id, _) = fixture();
    let good = dir.path().join("good.anynote");
    export_archive(
        &mut cut(&q, dir.path(), &id),
        SnapshotMode::Full,
        &good,
        false,
        &Cancellation::default(),
    )
    .unwrap();
    let original = fs::read(good).unwrap();
    let eocd = original
        .windows(4)
        .rposition(|w| w == b"PK\x05\x06")
        .unwrap();
    let central = u32::from_le_bytes(original[eocd + 16..eocd + 20].try_into().unwrap()) as usize;
    let record_size = 46
        + [28, 30, 32]
            .into_iter()
            .map(|i| {
                u16::from_le_bytes(original[central + i..central + i + 2].try_into().unwrap())
                    as usize
            })
            .sum::<usize>();
    for mode in [
        "duplicate",
        "bomb",
        "encrypted",
        "symlink",
        "count",
        "overlap",
    ] {
        let mut bytes = original.clone();
        match mode {
            "duplicate" => {
                let record = bytes[central..central + record_size].to_vec();
                bytes.splice(eocd..eocd, record);
                let at = eocd + record_size;
                for i in [8, 10] {
                    let n = u16::from_le_bytes(bytes[at + i..at + i + 2].try_into().unwrap()) + 1;
                    bytes[at + i..at + i + 2].copy_from_slice(&n.to_le_bytes());
                }
                let n = u32::from_le_bytes(bytes[at + 12..at + 16].try_into().unwrap())
                    + record_size as u32;
                bytes[at + 12..at + 16].copy_from_slice(&n.to_le_bytes());
            }
            "bomb" => bytes[central + 24..central + 28].copy_from_slice(&u32::MAX.to_le_bytes()),
            "encrypted" => bytes[central + 8..central + 10].copy_from_slice(&1u16.to_le_bytes()),
            "symlink" => bytes[central + 38..central + 42]
                .copy_from_slice(&(0o120777u32 << 16).to_le_bytes()),
            "count" => {
                bytes[eocd + 8..eocd + 10].copy_from_slice(&u16::MAX.to_le_bytes());
                bytes[eocd + 10..eocd + 12].copy_from_slice(&u16::MAX.to_le_bytes());
            }
            "overlap" => bytes[central + record_size + 42..central + record_size + 46]
                .copy_from_slice(&0u32.to_le_bytes()),
            _ => unreachable!(),
        }
        let file = dir.path().join(format!("{mode}.anynote"));
        fs::write(&file, bytes).unwrap();
        assert!(
            validate_archive(&file, dir.path(), &Cancellation::default()).is_err(),
            "{mode}"
        );
    }
}
#[test]
fn write_failure_during_stream_removes_partial_and_preserves_previous_output() {
    let (dir, q, id, _) = fixture();
    let mut frozen = cut(&q, dir.path(), &id);
    frozen
        .prepare(SnapshotMode::Full, &Cancellation::default())
        .unwrap();
    let output = dir.path().join("failure.anynote");
    // A concurrently replaced private cut must fail validation before publication.
    fs::write(frozen.path().join("notebook.sqlite"), b"invalid database").unwrap();
    assert!(
        export_archive(
            &mut frozen,
            SnapshotMode::Full,
            &output,
            false,
            &Cancellation::default()
        )
        .is_err()
    );
    assert!(!output.exists());
}
#[test]
fn whiteboard_export_uses_revision_images_after_resource_rebind() {
    let dir = temp();
    let q = WriteQueue::open(dir.path(), 2).unwrap();
    let (id, board) = q
        .submit(|s| {
            let id = s.create_notebook("scene")?.id;
            let b = s.notebook(&id)?;
            let image = uuid::Uuid::new_v4().to_string();
            let scene = uuid::Uuid::new_v4().to_string();
            let body = format!(
                ":::anynote{{type=\"core.whiteboard\" version=\"1\" id=\"board\"}}\n{}\n:::\n",
                json!({"resourceId":scene,"previewResourceId":image})
            );
            let board = b.create_node(
                &CreateNode::note("board", body),
                &[
                    ResourceWrite::bytes(
                        image.clone(),
                        "image.png".into(),
                        "image/png".into(),
                        b"revision-A".to_vec(),
                    )?,
                    ResourceWrite::bytes(
                        scene,
                        "scene.json".into(),
                        "application/vnd.anynote.whiteboard+json".into(),
                        serde_json::to_vec(
                            &json!({"elements":[],"files":{"f":{"resourceId":image,"created":1}}}),
                        )?,
                    )?,
                ],
            )?;
            b.create_node(
                &CreateNode::note("other", format!("![other](anynote-resource:{image})")),
                &[ResourceWrite::bytes(
                    image,
                    "new.png".into(),
                    "image/png".into(),
                    b"revision-B".to_vec(),
                )?],
            )?;
            Ok((id, board.node.id))
        })
        .unwrap()
        .wait()
        .unwrap();
    let output = dir.path().join("open");
    export_markdown(
        &mut cut(&q, dir.path(), &id),
        &output,
        OpenExportFormat::Directory,
        &Cancellation::default(),
    )
    .unwrap();
    let map: Value =
        serde_json::from_slice(&fs::read(output.join("EXPORT-MAP.json")).unwrap()).unwrap();
    let resource = map["resources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["noteId"] == board)
        .unwrap();
    let scene = resource["resources"]
        .as_object()
        .unwrap()
        .values()
        .find_map(|v| v.as_str().filter(|s| s.ends_with(".excalidraw.json")))
        .unwrap();
    let scene: Value = serde_json::from_slice(&fs::read(output.join(scene)).unwrap()).unwrap();
    assert_eq!(
        scene["files"]["f"]["dataURL"],
        "data:image/png;base64,cmV2aXNpb24tQQ=="
    );
}

#[test]
fn quarantine_purge_is_explicit_idempotent_and_keeps_audit_journal() {
    let (dir, q, id, _) = fixture();
    let root = dir.path().join(&id);
    fs::create_dir(root.join("snapshots")).unwrap();
    fs::write(root.join("snapshots/1.anynote"), b"old").unwrap();
    fs::write(root.join("snapshots/2.anynote"), b"new").unwrap();
    let bid = id.clone();
    let result = q
        .submit(move |s| {
            let p = s.preview_cleanup(&bid, 1, 0)?;
            s.apply_cleanup(&bid, &p.id, true)
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(purge_cleanup(&root, &id, &result.recovery_id, false).is_err());
    let purged = purge_cleanup(&root, &id, &result.recovery_id, true).unwrap();
    assert_eq!(purged.reclaimed_bytes, 3);
    assert_eq!(purged.removed, 1);
    assert!(purged.error.is_none());
    assert_eq!(
        purge_cleanup(&root, &id, &result.recovery_id, true)
            .unwrap()
            .removed,
        0
    );
    assert!(
        root.join(format!(
            "_local/cleanup-quarantine/{}/journal.json",
            result.recovery_id
        ))
        .exists()
    );
    assert_eq!(fs::read(root.join("snapshots/2.anynote")).unwrap(), b"new");
}

#[test]
fn maximum_utf16_notebook_name_remains_valid_after_import_suffix() {
    let dir = temp();
    let q = WriteQueue::open(dir.path(), 1).unwrap();
    let id = q
        .submit(|s| Ok(s.create_notebook(&"😀".repeat(120))?.id))
        .unwrap()
        .wait()
        .unwrap();
    let path = dir.path().join("unicode.anynote");
    export_archive(
        &mut cut(&q, dir.path(), &id),
        SnapshotMode::Full,
        &path,
        false,
        &Cancellation::default(),
    )
    .unwrap();
    let imported = import_archive(&path, dir.path(), &Cancellation::default()).unwrap();
    assert_eq!(imported.name.encode_utf16().count(), 240);
    assert!(imported.name.ends_with("（导入）"));
}

#[test]
fn pdf_index_and_annotation_roundtrip_preserve_original_and_search_coverage() {
    use anynote_core::{asset::AssetScope, document_session::DocumentId, image::ImageRect, pdf::*};
    use uuid::Uuid;
    let dir = temp();
    let queue = WriteQueue::open(dir.path(), 4).unwrap();
    let bytes = fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/pdf/w3c-dummy.pdf"),
    )
    .unwrap();
    let source_bytes = bytes.clone();
    let (book, note, hash, annotation) = queue
        .submit(move |catalog| {
            let id = catalog.create_notebook("PDF Archive")?.id;
            let b = catalog.notebook(&id)?;
            let resource = Uuid::new_v4();
            let mut request = CreateNode::note("Paper", "");
            request.note_type = Some(NoteType::Pdf);
            request.primary_resource_id = Some(resource.to_string());
            let note = b.create_node(
                &request,
                &[ResourceWrite::bytes(
                    resource.to_string(),
                    "a.pdf".into(),
                    "application/pdf".into(),
                    bytes,
                )?],
            )?;
            let hash = b
                .read()
                .resource(
                    &resource.to_string(),
                    Some(ResourceScope::note(&note.node.id)),
                )?
                .info()
                .hash
                .clone();
            let scope = AssetScope::new(
                DocumentId::new(
                    Uuid::parse_str(&id).unwrap(),
                    Uuid::parse_str(&note.node.id).unwrap(),
                ),
                Uuid::parse_str(note.head_revision_id.as_ref().unwrap()).unwrap(),
                resource,
            );
            let draft = AnnotationDraft::new(
                1,
                vec![ImageRect {
                    x: 0.1,
                    y: 0.1,
                    width: 0.2,
                    height: 0.1,
                }],
                "passage".into(),
                "archived remark".into(),
            );
            let PdfReply::Annotation { id: annotation } = b.execute_pdf(PdfCommand::Annotate {
                scope: scope.clone(),
                hash: hash.clone(),
                draft: draft.clone(),
            })?
            else {
                panic!()
            };
            b.execute_pdf(PdfCommand::ReadingNote {
                scope: scope.clone(),
                hash: hash.clone(),
                draft,
                annotation: Some(annotation),
            })?;
            let mut builder = IndexBuilder::new(2).unwrap();
            builder.push(0, "native searchable body".into(), true);
            let (body, coverage) = builder.finish().unwrap();
            b.publish_pdf_index(&scope, &hash, &body, &coverage)?;
            Ok((id, note.node.id, hash, annotation.to_string()))
        })
        .unwrap()
        .wait()
        .unwrap();
    for (mode, name) in [
        (SnapshotMode::Full, "full"),
        (SnapshotMode::Current, "current"),
    ] {
        let output = dir.path().join(format!("pdf-{name}.anynote"));
        export_archive(
            &mut cut(&queue, dir.path(), &book),
            mode,
            &output,
            true,
            &Cancellation::default(),
        )
        .unwrap();
        let restored = import_archive(&output, dir.path(), &Cancellation::default()).unwrap();
        let b = ReadonlyNotebook::open(&dir.path().join(&restored.id), Some(&restored.id)).unwrap();
        assert_eq!(
            b.pdf_coverage(&note, &hash).unwrap().unwrap().state(),
            IndexState::Partial
        );
        assert_eq!(b.annotations(&note, false).unwrap()[0].id, annotation);
        for query in ["searchable", "archived remark"] {
            assert!(
                b.search(&SearchRequest::new(
                    Uuid::new_v4().to_string(),
                    query.into()
                ))
                .unwrap()
                .results
                .iter()
                .any(|hit| hit.node.id == note)
            );
        }
    }
    let output = dir.path().join("open.zip");
    export_markdown(
        &mut cut(&queue, dir.path(), &book),
        &output,
        OpenExportFormat::Zip,
        &Cancellation::default(),
    )
    .unwrap();
    let entries = unzip(&output);
    assert!(
        entries
            .iter()
            .any(|(name, bytes)| name.ends_with(".pdf") && *bytes == source_bytes)
    );
    assert!(
        entries
            .iter()
            .any(|(name, bytes)| name.ends_with(".annotations.json")
                && String::from_utf8_lossy(bytes).contains(&annotation))
    );
}
