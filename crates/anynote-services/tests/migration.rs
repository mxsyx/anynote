use anynote_services::migration::*;
use anynote_storage::notebook::*;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn fixture() -> (tempfile::TempDir, String, String) {
    let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm14");
    fs::create_dir_all(&base).unwrap();
    let root = tempfile::tempdir_in(base.canonicalize().unwrap()).unwrap();
    fs::write(
        root.path().join("anynote.migration-rehearsal.json"),
        r#"{"format":"anynote.migration.rehearsal.v1"}"#,
    )
    .unwrap();
    let data = root.path().join("userData/notebooks");
    fs::create_dir_all(&data).unwrap();
    let q = WriteQueue::open(&data, 2).unwrap();
    let (id, note) = q
        .submit(|c| {
            let id = c.create_notebook("迁移样本")?.id;
            let note = c
                .notebook(&id)?
                .create_node(&CreateNode::note("保留", "切换前"), &[])?
                .node
                .id;
            Ok((id, note))
        })
        .unwrap()
        .wait()
        .unwrap();
    drop(q);
    fs::write(data.join(&id).join("orphan.bin"), b"orphan-not-registered").unwrap();
    fs::create_dir_all(data.join("_local")).unwrap();
    fs::write(
        data.join("_local/cloud-cursor.json"),
        br#"{"lastGeneration":"old","writerEpoch":7}"#,
    )
    .unwrap();
    fs::write(root.path().join("userData/unknown-user-file"), b"opaque").unwrap();
    fs::create_dir_all(root.path().join("userData/unknown/empty")).unwrap();
    (root, id, note)
}
fn noop(_: Boundary) -> Result<()> {
    Ok(())
}
fn copies_valid(paths: &[PathBuf]) -> Result<()> {
    for p in paths {
        ReadonlyNotebook::open(p, None)?.integrity_check()?;
    }
    Ok(())
}
fn locked(path: &Path) -> bool {
    Command::new("python3").args(["-c", "import sqlite3,sys\nc=sqlite3.connect(sys.argv[1],timeout=0)\ntry:\n c.execute('BEGIN EXCLUSIVE')\nexcept sqlite3.OperationalError:\n sys.exit(23)\n", path.to_str().unwrap()]).status().unwrap().code() == Some(23)
}
#[test]
fn full_preservation_reentrant_original_paths_and_cross_process_lock() {
    let (root, id, _) = fixture();
    let db = root
        .path()
        .join("userData/notebooks")
        .join(&id)
        .join("notebook.sqlite");
    let mut session = Rehearsal::open(root.path()).unwrap();
    assert!(locked(&db));
    assert_eq!(
        Rehearsal::open(root.path()).err().unwrap().0,
        "MIGRATION_BUSY"
    );
    session.prepare(&mut noop).unwrap();
    assert!(
        locked(&db),
        "hashing/copying must not release SQLite's process lock"
    );
    let journal = session.journal_path();
    let saved = fs::read(&journal).unwrap();
    session.prepare(&mut noop).unwrap();
    assert_eq!(saved, fs::read(journal).unwrap());
    let copy = root.path().join("userData/rust/migrations/rm14/preserved");
    assert_eq!(
        fs::read(copy.join("notebooks").join(&id).join("orphan.bin")).unwrap(),
        b"orphan-not-registered"
    );
    assert!(copy.join("unknown/empty").is_dir());
    session.activate(&mut noop).unwrap();
    let workspace: serde_json::Value = serde_json::from_slice(
        &fs::read(root.path().join("userData/rust/workspace.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        workspace["notebooks"][0]["path"],
        db.parent().unwrap().to_str().unwrap()
    );
    assert_eq!(workspace["tasksPaused"], true);
    drop(session);
    assert!(!locked(&db));
}
#[test]
fn rollback_drains_new_writes_preserves_cursor_and_refuses_failed_oracle() {
    let (root, id, note) = fixture();
    let mut s = Rehearsal::open(root.path()).unwrap();
    s.prepare(&mut noop).unwrap();
    s.activate(&mut noop).unwrap();

    let note_id = note.clone();
    let accepted = s
        .submit(&id, move |book| {
            book.save_note(
                &note_id,
                1,
                &NotePatch {
                    body: Some("最新正文".into()),
                    ..Default::default()
                },
                &[],
            )
        })
        .unwrap();
    let cursor = root
        .path()
        .join("userData/notebooks/_local/cloud-cursor.json");
    fs::write(&cursor, br#"{"lastGeneration":"new","writerEpoch":9}"#).unwrap();
    let db = root
        .path()
        .join("userData/notebooks")
        .join(&id)
        .join("notebook.sqlite");
    assert_eq!(
        s.rollback(&mut |_| Err(Error("LEGACY_UNREADABLE")), &mut noop)
            .unwrap_err()
            .0,
        "LEGACY_UNREADABLE"
    );
    accepted.wait().unwrap();
    assert!(locked(&db));
    assert_eq!(s.submit(&id, |_| Ok(())).err().unwrap().0, "WRITES_PAUSED");
    s.rollback(&mut copies_valid, &mut noop).unwrap();
    assert_eq!(s.phase(), Phase::Released);
    assert!(!locked(&db));
    assert_eq!(
        fs::read(cursor).unwrap(),
        br#"{"lastGeneration":"new","writerEpoch":9}"#
    );
    let read = ReadonlyNotebook::open(db.parent().unwrap(), Some(&id)).unwrap();
    assert!(read.integrity_check().is_ok());
    let conn = rusqlite::Connection::open(db).unwrap();
    let body: String = conn
        .query_row(
            "SELECT body FROM note_revisions ORDER BY rowid DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(body, "最新正文");
    let journal: serde_json::Value =
        serde_json::from_slice(&fs::read(s.journal_path()).unwrap()).unwrap();
    assert_eq!(
        journal["rollback_preferences"],
        "mapped-awaiting-chromium-publication"
    );
    assert!(
        root.path()
            .join(format!("userData/rust/migrations/rm14/{id}.latest.anynote"))
            .is_file()
    );
}
#[test]
fn failures_at_each_forward_boundary_resume_without_forking() {
    for boundary in [
        Boundary::Preflight,
        Boundary::RootCopied,
        Boundary::Copied,
        Boundary::Verified,
        Boundary::PreferencesPublished,
        Boundary::WorkspacePublished,
        Boundary::Activated,
    ] {
        let (root, _, _) = fixture();
        let mut hook = |b| {
            if b == boundary {
                Err(Error("INJECTED"))
            } else {
                Ok(())
            }
        };
        if boundary == Boundary::Preflight {
            assert!(
                Rehearsal::open_with(
                    root.path(),
                    &anynote_services::local_backup::NativeVolumes,
                    &mut hook
                )
                .is_err()
            );
        } else {
            let mut s = Rehearsal::open(root.path()).unwrap();
            let result = s.prepare(&mut hook).and_then(|_| s.activate(&mut hook));
            assert!(result.is_err(), "{boundary:?}");
        }
        let mut s = Rehearsal::open(root.path()).unwrap();
        if matches!(s.phase(), Phase::Preflight | Phase::Copied) {
            s.prepare(&mut noop).unwrap();
        }
        s.activate(&mut noop).unwrap();
        assert_eq!(s.phase(), Phase::Activated);
    }
}
#[test]
fn source_drift_and_damaged_copy_block_activation() {
    let (root, _, _) = fixture();
    let mut s = Rehearsal::open(root.path()).unwrap();
    s.prepare(&mut noop).unwrap();
    fs::write(root.path().join("userData/unknown-user-file"), b"changed").unwrap();
    assert_eq!(s.activate(&mut noop).unwrap_err().0, "SOURCE_CHANGED");
    fs::write(root.path().join("userData/unknown-user-file"), b"opaque").unwrap();
    fs::write(
        root.path()
            .join("userData/rust/migrations/rm14/preserved/unknown-user-file"),
        b"damaged",
    )
    .unwrap();
    assert_eq!(s.activate(&mut noop).unwrap_err().0, "COPY_CHANGED");
}
#[test]
fn unmarked_roots_and_running_legacy_are_rejected() {
    let (root, _, _) = fixture();
    fs::write(root.path().join("userData/SingletonLock"), b"running").unwrap();
    assert_eq!(
        Rehearsal::open(root.path()).err().unwrap().0,
        "LEGACY_INSTANCE"
    );
    fs::remove_file(root.path().join("anynote.migration-rehearsal.json")).unwrap();
    assert_eq!(
        Rehearsal::open(root.path()).err().unwrap().0,
        "REHEARSAL_REQUIRED"
    );
}
#[test]
fn rollback_boundary_failures_keep_latest_until_release() {
    for boundary in [
        Boundary::Frozen,
        Boundary::LatestCopied,
        Boundary::LegacyVerified,
        Boundary::Released,
    ] {
        let (root, _, _) = fixture();
        let mut s = Rehearsal::open(root.path()).unwrap();
        s.prepare(&mut noop).unwrap();
        s.activate(&mut noop).unwrap();
        assert!(
            s.rollback(&mut copies_valid, &mut |b| if b == boundary {
                Err(Error("INJECTED"))
            } else {
                Ok(())
            })
            .is_err()
        );
        drop(s);
        let mut s = Rehearsal::open(root.path()).unwrap();
        if boundary != Boundary::Released {
            s.rollback(&mut copies_valid, &mut noop).unwrap();
        }
        assert_eq!(s.phase(), Phase::Released);
    }
}

#[test]
fn external_notebooks_are_preserved_on_their_volume_without_registration() {
    let (root, _, _) = fixture();
    let parent = root.path().join("external");
    fs::create_dir(&parent).unwrap();
    let workspace = root.path().join("userData/notebooks");
    let q = WriteQueue::open(&workspace, 2).unwrap();
    let directory = parent.clone();
    let id = q
        .submit(move |c| Ok(c.create_notebook_at("外部库", Some(&directory))?.id))
        .unwrap()
        .wait()
        .unwrap();
    drop(q);
    fs::write(parent.join(&id).join("unknown.bin"), b"external unknown").unwrap();
    let registry = fs::read(workspace.join("_local/notebook-directories.json")).unwrap();
    let mut s = Rehearsal::open(root.path()).unwrap();
    s.prepare(&mut noop).unwrap();
    s.activate(&mut noop).unwrap();
    assert_eq!(s.notebook_count(), 2);
    assert_eq!(
        fs::read(parent.join(format!(".anynote-migrate-rm14-{id}/unknown.bin"))).unwrap(),
        b"external unknown"
    );
    assert_eq!(
        fs::read(workspace.join("_local/notebook-directories.json")).unwrap(),
        registry
    );
}
#[test]
fn insufficient_space_and_outside_registrations_fail_closed() {
    use anynote_services::local_backup::{NativeVolumes, VolumeInfo, VolumeProbe};
    struct Full;
    impl VolumeProbe for Full {
        fn inspect(&self, path: &Path) -> anynote_services::local_backup::Result<VolumeInfo> {
            let mut volume = NativeVolumes.inspect(path)?;
            volume.available_bytes = 0;
            Ok(volume)
        }
    }
    let (root, _, _) = fixture();
    assert_eq!(
        Rehearsal::open_with(root.path(), &Full, &mut noop)
            .err()
            .unwrap()
            .0,
        "NO_SPACE"
    );
    assert!(
        !root
            .path()
            .join("userData/rust/migrations/rm14/journal.json")
            .exists()
    );
    let outside = tempfile::tempdir().unwrap();
    let registration = serde_json::json!([{"id":uuid::Uuid::new_v4().to_string(),"path":outside.path(),"name":"outside"}]);
    fs::write(
        root.path()
            .join("userData/notebooks/_local/notebook-directories.json"),
        serde_json::to_vec(&registration).unwrap(),
    )
    .unwrap();
    assert_eq!(
        Rehearsal::open(root.path()).err().unwrap().0,
        "EXTERNAL_OUTSIDE_REHEARSAL"
    );
}
#[test]
#[cfg(unix)]
fn symlink_and_hardlink_aliases_are_rejected_before_copying() {
    let (root, id, _) = fixture();
    let db = root
        .path()
        .join("userData/notebooks")
        .join(id)
        .join("notebook.sqlite");
    let alias = root.path().join("userData/alias");
    fs::hard_link(&db, &alias).unwrap();
    assert_eq!(Rehearsal::open(root.path()).err().unwrap().0, "HARD_LINK");
    fs::remove_file(&alias).unwrap();
    std::os::unix::fs::symlink(&db, &alias).unwrap();
    assert_eq!(
        Rehearsal::open(root.path()).err().unwrap().0,
        "PATH_REDIRECT"
    );
}
#[test]
fn released_reopen_does_not_reacquire_writer() {
    let (root, id, _) = fixture();
    let mut s = Rehearsal::open(root.path()).unwrap();
    s.prepare(&mut noop).unwrap();
    s.activate(&mut noop).unwrap();
    s.rollback(&mut copies_valid, &mut noop).unwrap();
    drop(s);
    let s = Rehearsal::open(root.path()).unwrap();
    assert_eq!(s.phase(), Phase::Released);
    assert!(!locked(
        &root
            .path()
            .join("userData/notebooks")
            .join(id)
            .join("notebook.sqlite")
    ));
}

#[test]
fn byte_identical_database_replacement_is_not_the_same_source() {
    let (root, id, _) = fixture();
    let mut s = Rehearsal::open(root.path()).unwrap();
    s.prepare(&mut noop).unwrap();
    drop(s);
    let db = root
        .path()
        .join("userData/notebooks")
        .join(id)
        .join("notebook.sqlite");
    let replacement = db.with_extension("replacement");
    fs::copy(&db, &replacement).unwrap();
    fs::rename(&replacement, &db).unwrap();
    assert_eq!(
        Rehearsal::open(root.path()).err().unwrap().0,
        "IDENTITY_CHANGED"
    );
}
