use anynote_storage::notebook::*;
use rusqlite::Connection;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::Path,
    sync::{Arc, Barrier},
};

fn temp() -> tempfile::TempDir {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm05");
    fs::create_dir_all(&path).unwrap();
    tempfile::tempdir_in(path.canonicalize().unwrap()).unwrap()
}
fn fixture() -> (tempfile::TempDir, WriteQueue, String) {
    let dir = temp();
    let queue = WriteQueue::open(dir.path(), 2).unwrap();
    let id = queue
        .submit(|store| Ok(store.create_notebook("知识库")?.id))
        .unwrap()
        .wait()
        .unwrap();
    (dir, queue, id)
}
fn with<T: Send + 'static>(
    q: &WriteQueue,
    id: &str,
    action: impl FnOnce(&mut WritableNotebook) -> ReadResult<T> + Send + 'static,
) -> ReadResult<T> {
    let id = id.to_owned();
    q.submit(move |s| action(s.notebook(&id)?))?.wait()
}
fn create(q: &WriteQueue, id: &str, title: &str) -> Note {
    let request = CreateNode::note(title, "初稿");
    with(q, id, move |b| b.create_node(&request, &[])).unwrap()
}
fn resource(id: &str, bytes: &[u8], mime: &str) -> ResourceWrite {
    ResourceWrite::bytes(id.into(), "附件".into(), mime.into(), bytes.into()).unwrap()
}
fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn copy(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() {
            copy(&entry.path(), &to.join(entry.file_name()));
        } else {
            fs::copy(entry.path(), to.join(entry.file_name())).unwrap();
        }
    }
}

#[test]
fn save_conflicts_history_metadata_links_and_search_survive_reopen() {
    let (dir, q, id) = fixture();
    let n = create(&q, &id, "初始");
    let nid = n.node.id.clone();
    let link = format!("anynote://notebook/{id}/note/{nid}#page=7");
    let saved = with(&q, &id, move |b| {
        b.save_note(
            &nid,
            1,
            &NotePatch {
                body: Some(format!("中文检索内容 {link}")),
                title: Some("新标题".into()),
                tags: Some(vec!["标签".into()]),
                favorite: Some(true),
            },
            &[],
        )
    })
    .unwrap();
    let nid = n.node.id.clone();
    let e = with(&q, &id, move |b| {
        b.save_note(&nid, 1, &NotePatch::default(), &[])
    })
    .unwrap_err();
    assert_eq!(e.kind(), ReadErrorKind::Conflict);
    let nid = n.node.id.clone();
    let rev = n.head_revision_id.unwrap();
    let restored = with(&q, &id, move |b| b.restore_revision(&nid, 2, &rev)).unwrap();
    assert_eq!(restored.node.title, "初始");
    assert_eq!(restored.body, "初稿");
    assert!(restored.node.tags.is_empty());
    assert_eq!(restored.node.favorite, 0);
    drop(q);
    let book = ReadonlyNotebook::open(&dir.path().join(&id), Some(&id)).unwrap();
    assert_eq!(book.history(&n.node.id).unwrap().len(), 3);
    assert_eq!(book.metadata().content_seq, 3);
    assert_eq!(book.note(&n.node.id).unwrap().node.revision, 3);
    assert!(
        book.backup_revision()
            .unwrap()
            .storage_epoch
            .parse::<u64>()
            .unwrap()
            > 0
    );
    assert_eq!(saved.node.revision, 2);
    let db = Connection::open(dir.path().join(id).join("notebook.sqlite")).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM note_links", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        db.query_row("SELECT body FROM fts_notes", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "初稿\n[]"
    );
}
#[test]
fn tree_cycles_ordering_and_deletion_batches() {
    let (_dir, q, id) = fixture();
    with(&q, &id, |b| {
        let mut request = CreateNode::note("目录", "");
        request.kind = NodeKind::Folder;
        request.note_type = None;
        let folder = b.create_node(&request, &[])?;
        let mut request = CreateNode::note("先删除", "");
        request.parent_id = Some(folder.node.id.clone());
        let a = b.create_node(&request, &[])?;
        let c = b.create_node(&request, &[])?;
        let mut nested = CreateNode::note("子目录", "");
        nested.kind = NodeKind::Folder;
        nested.parent_id = Some(folder.node.id.clone());
        let child = b.create_node(&nested, &[])?;
        assert!(b.move_node(&folder.node.id, Some(&child.node.id)).is_err());
        assert!(b.move_node(&child.node.id, Some(&a.node.id)).is_err());
        b.place_node(&c.node.id, 1, Some(&folder.node.id), Some(&a.node.id))?;
        b.trash_node(&a.node.id)?;
        b.trash_node(&folder.node.id)?;
        b.restore_node(&folder.node.id)?;
        assert!(b.read().note(&a.node.id)?.node.deleted_at.is_some());
        assert!(b.read().note(&c.node.id)?.node.deleted_at.is_none());
        b.trash_node(&folder.node.id)?;
        b.restore_node(&a.node.id)?;
        assert!(b.read().note(&a.node.id)?.node.parent_id.is_none());
        Ok(())
    })
    .unwrap();
}
#[test]
fn queue_serializes_competing_cas_and_keeps_running_after_failure() {
    let (_dir, q, id) = fixture();
    let n = create(&q, &id, "并发");
    let barrier = Arc::new(Barrier::new(4));
    let threads: Vec<_> = (0..3)
        .map(|i| {
            let q = q.clone();
            let id = id.clone();
            let nid = n.node.id.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                with(&q, &id, move |b| {
                    b.save_note(
                        &nid,
                        1,
                        &NotePatch {
                            body: Some(format!("提交 {i}")),
                            ..Default::default()
                        },
                        &[],
                    )
                })
            })
        })
        .collect();
    barrier.wait();
    let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| r
                .as_ref()
                .is_err_and(|e| e.kind() == ReadErrorKind::Conflict))
            .count(),
        2
    );
    let nid = n.node.id;
    assert_eq!(
        with(&q, &id, move |b| Ok(b.read().history(&nid)?.len())).unwrap(),
        2
    );
}
#[test]
fn independent_writers_are_excluded_and_pins_bound_lru() {
    let dir = temp();
    let q = WriteQueue::open(dir.path(), 1).unwrap();
    let (a, b) = q
        .submit(|s| Ok((s.create_notebook("A")?.id, s.create_notebook("B")?.id)))
        .unwrap()
        .wait()
        .unwrap();
    let aid = a.clone();
    let pin = q.submit(move |s| s.pin(&aid)).unwrap().wait().unwrap();
    let bid = b.clone();
    assert_eq!(
        q.submit(move |s| s.notebook(&bid).map(|_| ()))
            .unwrap()
            .wait()
            .unwrap_err()
            .kind(),
        ReadErrorKind::Busy
    );
    let other = WriteQueue::open(dir.path(), 2).unwrap();
    assert_eq!(
        with(&other, &a, |_| Ok(())).unwrap_err().kind(),
        ReadErrorKind::Busy
    );
    drop(pin);
    with(&q, &b, |_| Ok(())).unwrap();
    with(&other, &a, |_| Ok(())).unwrap();
    assert_eq!(
        q.submit(|s| Ok(s.connection_count()))
            .unwrap()
            .wait()
            .unwrap(),
        1
    );
    drop(other);
    drop(q);
    assert!(!dir.path().join(&a).join("notebook.sqlite-wal").exists());
}
#[test]
fn bounded_queue_rejects_overload_without_dropping_accepted_work() {
    let (_dir, q, _id) = fixture();
    let (tx, rx) = std::sync::mpsc::channel();
    let (ready, started) = std::sync::mpsc::channel();
    let first = q
        .submit(move |_| {
            ready.send(()).unwrap();
            rx.recv().unwrap();
            Ok(())
        })
        .unwrap();
    started.recv().unwrap();
    let mut tickets = Vec::new();
    for _ in 0..64 {
        tickets.push(q.submit(|_| Ok(1)).unwrap());
    }
    assert_eq!(
        q.submit(|_| Ok(())).err().unwrap().kind(),
        ReadErrorKind::Busy
    );
    tx.send(()).unwrap();
    first.wait().unwrap();
    for t in tickets {
        assert_eq!(t.wait().unwrap(), 1);
    }
}
#[test]
fn resources_rebind_but_history_and_recursive_whiteboard_remain_pinned() {
    let (dir, q, id) = fixture();
    let image = uuid();
    let scene = uuid();
    let old = b"old image bytes";
    let old_hash = format!("{:x}", Sha256::digest(old));
    let image_id = image.clone();
    let scene_id = scene.clone();
    let (nid, old_rev) = with(&q, &id, move |b| {
        let scene_bytes =
            json!({"files":{"embedded":{"resourceId":image_id}},"unknown":{"x":1}}).to_string();
        let n = b.create_node(
            &CreateNode::note("白板", format!("anynote-resource:{scene_id}")),
            &[
                resource(&image_id, old, "application/octet-stream"),
                resource(
                    &scene_id,
                    scene_bytes.as_bytes(),
                    "application/vnd.anynote.whiteboard+json",
                ),
            ],
        )?;
        let old_rev = n.head_revision_id.clone().unwrap();
        let n = b.save_note(
            &n.node.id,
            1,
            &NotePatch::default(),
            &[resource(
                &image_id,
                b"new image bytes",
                "application/octet-stream",
            )],
        )?;
        assert_eq!(
            b.read()
                .resource(
                    &image_id,
                    Some(ResourceScope::note(&n.node.id).with_revision(&old_rev))
                )?
                .info()
                .hash,
            format!("{:x}", Sha256::digest(old))
        );
        b.restore_revision(&n.node.id, 2, &old_rev)?;
        b.save_note(
            &n.node.id,
            3,
            &NotePatch {
                title: Some("恢复后保存".into()),
                ..Default::default()
            },
            &[],
        )?;
        Ok((n.node.id, old_rev))
    })
    .unwrap();
    drop(q);
    let book = ReadonlyNotebook::open(&dir.path().join(id), None).unwrap();
    assert_eq!(
        book.resource(&image, Some(ResourceScope::note(&nid)))
            .unwrap()
            .info()
            .hash,
        old_hash
    );
    assert_eq!(
        book.resource(
            &image,
            Some(ResourceScope::note(&nid).with_revision(&old_rev))
        )
        .unwrap()
        .info()
        .hash,
        old_hash
    );
    assert_ne!(book.resource(&image, None).unwrap().info().hash, old_hash);
}
#[test]
fn resource_failure_rolls_back_all_rows_and_counters() {
    let (dir, q, id) = fixture();
    let n = create(&q, &id, "资源失败");
    let nid = n.node.id.clone();
    let before = with(&q, &id, |b| Ok(b.read().backup_revision().unwrap().clone())).unwrap();
    let bad = resource(
        &uuid(),
        b"invalid json",
        "application/vnd.anynote.whiteboard+json",
    );
    let rid = bad.id.clone();
    let err = with(&q, &id, move |b| {
        b.save_note(
            &nid,
            1,
            &NotePatch {
                body: Some(format!("anynote-resource:{rid}")),
                ..Default::default()
            },
            &[bad],
        )
    })
    .unwrap_err();
    assert_eq!(err.kind(), ReadErrorKind::Corrupt);
    let nid = n.node.id.clone();
    with(&q, &id, move |b| {
        assert_eq!(b.read().note(&nid)?.body, "初稿");
        assert_eq!(b.read().history(&nid)?.len(), 1);
        assert_eq!(
            b.read().backup_revision().unwrap().storage_epoch,
            before.storage_epoch
        );
        Ok(())
    })
    .unwrap();
    drop(q);
    let db = Connection::open(dir.path().join(id).join("notebook.sqlite")).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM resources", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM assets", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn corrupted_existing_cas_is_never_overwritten_or_committed() {
    let (dir, q, id) = fixture();
    let n = create(&q, &id, "损坏资源");
    let bytes = b"expected bytes";
    let hash = format!("{:x}", Sha256::digest(bytes));
    let path = dir
        .path()
        .join(&id)
        .join(format!("assets/sha256/{}/{hash}.bin", &hash[..2]));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, b"tampered bytes").unwrap();
    let r = resource(&uuid(), bytes, "application/octet-stream");
    let rid = r.id.clone();
    let nid = n.node.id.clone();
    assert!(
        with(&q, &id, move |b| b.save_note(
            &nid,
            1,
            &NotePatch {
                body: Some(format!("anynote-resource:{rid}")),
                ..Default::default()
            },
            &[r]
        ))
        .is_err()
    );
    assert_eq!(fs::read(path).unwrap(), b"tampered bytes");
    let nid = n.node.id;
    assert_eq!(
        with(&q, &id, move |b| Ok(b.read().note(&nid)?.node.revision)).unwrap(),
        1
    );
}
#[test]
fn proposals_are_conditional_atomic_idempotent_and_validate_persisted_state() {
    let (_dir, q, id) = fixture();
    with(&q, &id, |b| {
        let n = b.create_node(&CreateNode::note("提案", "之前"), &[])?;
        let seq = b.read().metadata().content_seq;
        let p = b.propose(&n.node.id, 1, "之后", None)?;
        assert_eq!(b.read().metadata().content_seq, seq);
        b.apply_proposal(&n.node.id, &p.id)?;
        assert_eq!(b.apply_proposal(&n.node.id, &p.id)?.node.revision, 2);
        assert_eq!(b.undo_proposal(&n.node.id, &p.id)?.body, "之前");
        assert!(b.undo_proposal(&n.node.id, &p.id).is_err());
        let p = b.propose(&n.node.id, 3, "过期", None)?;
        b.save_note(
            &n.node.id,
            3,
            &NotePatch {
                body: Some("用户编辑".into()),
                ..Default::default()
            },
            &[],
        )?;
        assert_eq!(
            b.apply_proposal(&n.node.id, &p.id).unwrap_err().kind(),
            ReadErrorKind::Conflict
        );
        let p = b.propose(&n.node.id, 4, "应用后编辑", None)?;
        b.apply_proposal(&n.node.id, &p.id)?;
        b.save_note(&n.node.id, 5, &NotePatch::default(), &[])?;
        assert_eq!(
            b.undo_proposal(&n.node.id, &p.id).unwrap_err().kind(),
            ReadErrorKind::Conflict
        );
        Ok(())
    })
    .unwrap();
}
#[test]
fn annotations_are_version_bound_and_indexed_with_soft_deletion() {
    let (dir, q, id) = fixture();
    with(&q,&id,|b| {
        let r=resource(&uuid(),b"%PDF-synthetic","application/pdf");let rid=r.id.clone();
        let mut request=CreateNode::note("PDF","");request.note_type=Some(NoteType::Pdf);request.primary_resource_id=Some(rid.clone());
        let n=b.create_node(&request,&[r])?;
        let hash=b.read().resource(&rid,None)?.info().hash.clone();
        let a:AnnotationInput=serde_json::from_value(json!({"assetHash":hash,"page":1,"selector":[{"x":0.1,"y":0.2,"width":0.3,"height":0.1}],"quote":"摘录","body":"批注正文","color":"yellow"}))?;
        let aid=b.add_annotation(&n.node.id,&a)?;
        assert_eq!(b.read().annotations(&n.node.id,false)?.len(),1);
        let a2=AnnotationInput {asset_hash:"0".repeat(64),..a};assert_eq!(b.add_annotation(&n.node.id,&a2).unwrap_err().kind(),ReadErrorKind::Conflict);
        b.delete_annotation(&aid)?;
        assert!(b.read().annotations(&n.node.id,false)?.is_empty());
        assert_eq!(b.read().annotations(&n.node.id,true)?.len(),1);
        Ok(())
    }).unwrap();
    drop(q);
    ReadonlyNotebook::open(&dir.path().join(id), None).unwrap();
}
#[test]
fn frozen_unknown_state_and_all_history_assets_are_preserved() {
    let dir = temp();
    let corpus =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/rust-migration/corpus");
    let expected: Value =
        serde_json::from_slice(&fs::read(corpus.join("expected.json")).unwrap()).unwrap();
    let id = expected["notebookId"].as_str().unwrap().to_owned();
    copy(&corpus.join("notebook"), &dir.path().join(&id));
    let view = ReadonlyNotebook::open(&dir.path().join(&id), None).unwrap();
    let records = view.extension_records().unwrap();
    let refs = view.revision_resources().unwrap();
    let nodes = view.nodes().unwrap();
    drop(view);
    let q = WriteQueue::open(dir.path(), 2).unwrap();
    with(&q, &id, move |b| {
        for n in nodes {
            if n.kind == NodeKind::Note && n.deleted_at.is_none() {
                b.save_note(&n.id, n.revision, &NotePatch::default(), &[])?;
            }
        }
        b.set_core_setting("anynote.video", "remoteEmbed", false)?;
        Ok(())
    })
    .unwrap();
    drop(q);
    let view = ReadonlyNotebook::open(&dir.path().join(id), None).unwrap();
    let after = view.extension_records().unwrap();
    for record in records {
        assert!(after.iter().any(|r| r.extension_id == record.extension_id
            && r.key == record.key
            && r.value_json == record.value_json
            && r.revision == record.revision));
    }
    let after = view.revision_resources().unwrap();
    for r in refs {
        assert!(after.iter().any(|a| a.revision_id == r.revision_id
            && a.resource_id == r.resource_id
            && a.asset_hash == r.asset_hash));
    }
}
#[test]
fn exhausted_tracker_aborts_without_half_commit_and_keeps_i64_precision() {
    let (dir, q, id) = fixture();
    let n = create(&q, &id, "计数");
    drop(q);
    let db = Connection::open(dir.path().join(&id).join("notebook.sqlite")).unwrap();
    db.execute(
        "UPDATE _backup_revision SET storage_epoch=9223372036854775807",
        [],
    )
    .unwrap();
    drop(db);
    let q = WriteQueue::open(dir.path(), 2).unwrap();
    let nid = n.node.id;
    with(&q, &id, move |b| {
        assert_eq!(
            b.read().backup_revision().unwrap().storage_epoch,
            "9223372036854775807"
        );
        assert!(
            b.save_note(
                &nid,
                1,
                &NotePatch {
                    body: Some("不能提交".into()),
                    ..Default::default()
                },
                &[]
            )
            .is_err()
        );
        assert_eq!(b.read().note(&nid)?.body, "初稿");
        Ok(())
    })
    .unwrap();
}
#[test]
fn external_creation_and_invalid_runtime_inputs() {
    let (dir, q, _id) = fixture();
    let external = temp();
    let parent = external.path().to_owned();
    let book = q
        .submit(move |s| s.create_notebook_at("外部", Some(&parent)))
        .unwrap()
        .wait()
        .unwrap();
    with(&q, &book.id, |b| {
        assert!(
            b.create_node(&CreateNode::note("😀".repeat(121), ""), &[])
                .is_err()
        );
        assert!(
            b.set_core_setting("unknown.plugin", "enabled", true)
                .is_err()
        );

        Ok(())
    })
    .unwrap();
    let bid = book.id.clone();
    q.submit(move |s| s.rename_notebook(&bid, "重命名", Some("❦"), Some("#112233")))
        .unwrap()
        .wait()
        .unwrap();
    let registry: Value = serde_json::from_slice(
        &fs::read(dir.path().join("_local/notebook-directories.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(registry[0]["name"], "重命名");
    drop(q);
    let mut catalog = ReadonlyCatalog::open(dir.path(), 2).unwrap();
    assert_eq!(catalog.read(&book.id).unwrap().metadata().name, "重命名");
}
#[cfg(unix)]
#[test]
fn writable_open_rejects_symlinks_and_replaced_database() {
    let (dir, q, id) = fixture();
    let n = create(&q, &id, "身份");
    let db = dir.path().join(&id).join("notebook.sqlite");
    let replaced = db.with_extension("old");
    fs::rename(&db, &replaced).unwrap();
    fs::copy(&replaced, &db).unwrap();
    let nid = n.node.id;
    assert!(
        with(&q, &id, move |b| b.save_note(
            &nid,
            1,
            &NotePatch::default(),
            &[]
        ))
        .is_err()
    );
    drop(q);
    let other = temp();
    let linked = other.path().join(&id);
    std::os::unix::fs::symlink(dir.path().join(&id), &linked).unwrap();
    let registry = other.path().join("_local");
    fs::create_dir(&registry).unwrap();
    fs::write(
        registry.join("notebook-directories.json"),
        json!([{"id":id,"path":linked,"name":"link"}]).to_string(),
    )
    .unwrap();
    let q = WriteQueue::open(other.path(), 2).unwrap();
    assert_eq!(
        with(&q, &id, |_| Ok(())).unwrap_err().kind(),
        ReadErrorKind::UnsafePath
    );
}

#[test]
fn streamed_file_input_deduplicates_and_io_failure_leaves_no_partial_rows() {
    let (dir, q, id) = fixture();
    let nid = create(&q, &id, "流式文件").node.id;
    let source = dir.path().join("source.bin");
    fs::write(&source, vec![7u8; 2 * 1024 * 1024 + 13]).unwrap();
    let rid = uuid();
    let streamed = ResourceWrite::file(
        rid.clone(),
        "原始名".into(),
        "application/octet-stream".into(),
        fs::File::open(&source).unwrap(),
    )
    .unwrap();
    let note_id = nid.clone();
    let resource_id = rid.clone();
    with(&q, &id, move |b| {
        b.save_note(
            &note_id,
            1,
            &NotePatch {
                body: Some(format!("anynote-resource:{resource_id}")),
                ..Default::default()
            },
            &[streamed],
        )
    })
    .unwrap();
    let note_id = nid.clone();
    let resource_id = rid.clone();
    let file = fs::File::open(&source).unwrap();
    with(&q, &id, move |b| {
        b.save_note(
            &note_id,
            2,
            &NotePatch::default(),
            &[ResourceWrite::file(
                resource_id,
                "新名".into(),
                "application/octet-stream".into(),
                file,
            )?],
        )
    })
    .unwrap();
    // Force an actual filesystem error before publication, after the transaction starts.
    let bad = b"blocked destination";
    let hash = format!("{:x}", Sha256::digest(bad));
    let path = dir
        .path()
        .join(&id)
        .join(format!("assets/sha256/{}", &hash[..2]));
    if path.exists() {
        fs::remove_dir(&path).unwrap();
    }
    fs::write(path, b"not a directory").unwrap();
    let note_id = nid.clone();
    let r = resource(&uuid(), bad, "application/octet-stream");
    assert!(
        with(&q, &id, move |b| b.save_note(
            &note_id,
            3,
            &NotePatch::default(),
            &[r]
        ))
        .is_err()
    );
    let note_id = nid.clone();
    assert_eq!(
        with(&q, &id, move |b| Ok(b.read().note(&note_id)?.node.revision)).unwrap(),
        3
    );
    assert!(!fs::read_dir(dir.path().join(&id)).unwrap().any(|e| {
        e.unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".anynote-asset-")
    }));
    drop(q);
    let db = Connection::open(dir.path().join(&id).join("notebook.sqlite")).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM assets", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    let (revision, name): (i64, String) = db
        .query_row(
            "SELECT revision,original_name FROM resources WHERE id=?",
            [rid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((revision, name), (2, "原始名".into()));
}
#[test]
fn reopening_changes_lease_identity_without_resetting_persistent_lineage() {
    let (dir, q, id) = fixture();
    let first = with(&q, &id, |b| {
        Ok((
            b.lease_revision()?,
            b.read().backup_revision().unwrap().clone(),
        ))
    })
    .unwrap();
    let bid = id.clone();
    q.submit(move |s| s.close_notebook(&bid))
        .unwrap()
        .wait()
        .unwrap();
    let second = with(&q, &id, |b| {
        Ok((
            b.lease_revision()?,
            b.read().backup_revision().unwrap().clone(),
        ))
    })
    .unwrap();
    assert_ne!(first.0.lineage_id, second.0.lineage_id);
    assert_eq!(first.1.lineage_id, second.1.lineage_id);
    assert_eq!(first.1.storage_epoch, second.1.storage_epoch);
    drop(q);
    ReadonlyNotebook::open(&dir.path().join(id), None).unwrap();
}
