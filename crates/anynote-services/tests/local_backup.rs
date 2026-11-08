use anynote_services::local_backup::*;
use anynote_storage::notebook::*;
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};

fn temp() -> tempfile::TempDir {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm09");
    fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root.canonicalize().unwrap()).unwrap()
}
struct Fixture {
    dir: tempfile::TempDir,
    q: WriteQueue,
    id: String,
    note: String,
    target: Target,
}
impl Fixture {
    fn new() -> Self {
        let dir = temp();
        for name in ["source", "disk", "staging", "restored"] {
            fs::create_dir(dir.path().join(name)).unwrap();
        }
        let q = WriteQueue::open(&dir.path().join("source"), 2).unwrap();
        let (id, note) = q
            .submit(|s| {
                let id = s.create_notebook("Local backup")?.id;
                let note = s
                    .notebook(&id)?
                    .create_node(&CreateNode::note("sample", "first body"), &[])?;
                Ok((id, note.node.id))
            })
            .unwrap()
            .wait()
            .unwrap();
        let target = initialize_target(
            &dir.path().join("disk"),
            &[dir.path().join("source")],
            &NativeVolumes,
        )
        .unwrap();
        Self {
            dir,
            q,
            id,
            note,
            target,
        }
    }
    fn staging(&self) -> PathBuf {
        self.dir.path().join("staging")
    }
    fn root(&self) -> PathBuf {
        self.target.path.join("notebooks").join(&self.id)
    }
    fn manifest(&self) -> Manifest {
        serde_json::from_slice(&fs::read(self.root().join(".backup/manifest.json")).unwrap())
            .unwrap()
    }
    fn run(&self, service: &mut LocalBackupService) -> BackupResult {
        service
            .backup(
                &self.target,
                &self.q,
                &self.id,
                &self.staging(),
                &Cancellation::default(),
                &NativeVolumes,
            )
            .unwrap()
    }
    fn edit(&self) {
        let id = self.id.clone();
        let note = self.note.clone();
        self.q
            .submit(move |s| {
                let b = s.notebook(&id)?;
                let n = b.read().note(&note)?;
                b.save_note(
                    &note,
                    n.node.revision,
                    &NotePatch {
                        body: Some("second body".into()),
                        ..Default::default()
                    },
                    &[],
                )
            })
            .unwrap()
            .wait()
            .unwrap();
    }
    fn restored_body(&self) -> String {
        let meta = LocalBackupService::default()
            .restore(
                &self.target,
                &self.id,
                &self.dir.path().join("restored"),
                &Cancellation::default(),
                &NativeVolumes,
            )
            .unwrap();
        assert_ne!(meta.id, self.id);
        ReadonlyNotebook::open(&self.dir.path().join("restored").join(meta.id), None)
            .unwrap()
            .note(&self.note)
            .unwrap()
            .body
    }
}
struct Fault(Checkpoint);
impl Observer for Fault {
    fn checkpoint(&mut self, at: Checkpoint) -> Result<()> {
        if at == self.0 {
            Err(Error::new(
                "NO_SPACE",
                "injected disk full / publication failure",
            ))
        } else {
            Ok(())
        }
    }
}
#[test]
fn roundtrip_fast_path_restart_and_lease_reopen() {
    let f = Fixture::new();
    let mut service = LocalBackupService::default();
    assert!(f.run(&mut service).copied_files > 0);
    assert!(f.run(&mut service).capture_skipped);
    let restarted = f.run(&mut LocalBackupService::default());
    assert!(!restarted.capture_skipped);
    assert_eq!(restarted.copied_files, 0);
    f.run(&mut service);
    let id = f.id.clone();
    f.q.submit(move |s| s.close_notebook(&id))
        .unwrap()
        .wait()
        .unwrap();
    assert!(!f.run(&mut service).capture_skipped);
    assert_eq!(f.restored_body(), "first body");
    let report = service
        .verify(
            &f.target,
            &f.id,
            &f.staging(),
            &Cancellation::default(),
            &NativeVolumes,
        )
        .unwrap();
    assert_eq!(report.status, "passed");
    assert!(report.complete);
    assert!(f.manifest().last_full_verified_at.is_some());
}
#[test]
fn precommit_failures_keep_previous_and_recover_only_journal_files() {
    for point in [
        Checkpoint::PendingWritten,
        Checkpoint::BeforeFileWrite,
        Checkpoint::FilesWritten,
        Checkpoint::BeforeManifest,
    ] {
        let f = Fixture::new();
        let mut service = LocalBackupService::default();
        f.run(&mut service);
        let original = fs::read(f.root().join(".backup/manifest.json")).unwrap();
        let unknown = f.root().join("chunks/user-file.bin");
        fs::write(&unknown, b"keep me").unwrap();
        f.edit();
        assert!(
            service
                .backup_observed(
                    &f.target,
                    &f.q,
                    &f.id,
                    &f.staging(),
                    &Cancellation::default(),
                    &NativeVolumes,
                    &mut Fault(point)
                )
                .is_err()
        );
        assert_eq!(
            fs::read(f.root().join(".backup/manifest.json")).unwrap(),
            original
        );
        assert_eq!(f.restored_body(), "first body");
        let result = f.run(&mut LocalBackupService::default());
        assert!(!result.capture_skipped);
        assert_eq!(f.restored_body(), "second body");
        assert_eq!(fs::read(unknown).unwrap(), b"keep me");
        assert!(!f.root().join(".backup/pending.json").exists());
    }
}
#[test]
fn postcommit_failure_reports_pending_and_next_run_finishes_cleanup() {
    let f = Fixture::new();
    let mut service = LocalBackupService::default();
    f.run(&mut service);
    let previous = f.manifest();
    f.edit();
    let result = service
        .backup_observed(
            &f.target,
            &f.q,
            &f.id,
            &f.staging(),
            &Cancellation::default(),
            &NativeVolumes,
            &mut Fault(Checkpoint::ManifestPublished),
        )
        .unwrap();
    assert!(result.pending_cleanup);
    assert_ne!(previous.task_id, f.manifest().task_id);
    assert_eq!(f.restored_body(), "second body");
    assert!(!f.run(&mut service).pending_cleanup);
    assert!(f.manifest().cleanup.is_empty());
}
struct CancelAt {
    point: Checkpoint,
    cancel: Cancellation,
}
impl Observer for CancelAt {
    fn checkpoint(&mut self, at: Checkpoint) -> Result<()> {
        if at == self.point {
            self.cancel.cancel();
        }
        Ok(())
    }
}
#[test]
fn cancellation_before_commit_preserves_previous_after_commit_reports_pending() {
    for point in [
        Checkpoint::PendingWritten,
        Checkpoint::FilesWritten,
        Checkpoint::BeforeManifest,
        Checkpoint::ManifestPublished,
    ] {
        let f = Fixture::new();
        let mut service = LocalBackupService::default();
        f.run(&mut service);
        f.edit();
        let cancel = Cancellation::default();
        let result = service.backup_observed(
            &f.target,
            &f.q,
            &f.id,
            &f.staging(),
            &cancel,
            &NativeVolumes,
            &mut CancelAt {
                point,
                cancel: cancel.clone(),
            },
        );
        if point == Checkpoint::ManifestPublished {
            assert!(result.unwrap().pending_cleanup);
            assert_eq!(f.restored_body(), "second body");
        } else {
            assert_eq!(result.unwrap_err().code, "CANCELLED");
            assert_eq!(f.restored_body(), "first body");
        }
    }
}
#[test]
fn full_verify_detects_same_size_corruption_and_refuses_restore() {
    let f = Fixture::new();
    let mut service = LocalBackupService::default();
    f.run(&mut service);
    let m = f.manifest();
    let file = f.root().join(&m.files[0].path);
    let mut bytes = fs::read(&file).unwrap();
    bytes[0] ^= 1;
    fs::write(file, bytes).unwrap();
    let report = service
        .verify(
            &f.target,
            &f.id,
            &f.staging(),
            &Cancellation::default(),
            &NativeVolumes,
        )
        .unwrap();
    assert_eq!(report.status, "failed");
    assert!(report.issues.iter().any(|i| i.code == "HASH_MISMATCH"));
    assert!(
        service
            .restore(
                &f.target,
                &f.id,
                &f.dir.path().join("restored"),
                &Cancellation::default(),
                &NativeVolumes
            )
            .is_err()
    );
    assert_eq!(
        fs::read_dir(f.dir.path().join("restored")).unwrap().count(),
        0
    );
    assert!(f.run(&mut service).copied_files > 0);
    assert_eq!(f.restored_body(), "first body");
}
struct FixedVolume(VolumeInfo);
impl VolumeProbe for FixedVolume {
    fn inspect(&self, _: &Path) -> Result<VolumeInfo> {
        Ok(self.0.clone())
    }
}
#[test]
fn volume_fixtures_network_fat32_space_identity_and_waiting_disk() {
    let linux = include_str!("../../../tests/fixtures/volume/linux/mountinfo.txt");
    let fat =
        volume::linux_mountinfo(linux, Path::new("/media/My Disk/AnynoteBackup"), 100).unwrap();
    assert_eq!(fat.maximum_file_bytes, Some(u32::MAX as u64));
    assert!(fat.require_local(u32::MAX as u64 + 1, 0).is_err());
    assert!(fat.require_local(0, 101).is_err());
    assert!(
        volume::linux_mountinfo(linux, Path::new("/net/backup"), 100)
            .unwrap()
            .require_local(0, 0)
            .is_err()
    );
    for name in ["NTFS", "exFAT"] {
        assert!(
            volume::windows_volume(name, "volume-guid", 7, 3, "E:\\".into(), 100)
                .unwrap()
                .require_local(5 << 30, 100)
                .is_ok()
        );
    }
    assert!(
        volume::windows_volume("NTFS", "", 0, 4, "Z:\\".into(), 100)
            .unwrap()
            .require_local(0, 0)
            .is_err()
    );
    let f = Fixture::new();
    let mut low = f.target.volume.clone();
    low.available_bytes = 0;
    assert_eq!(
        LocalBackupService::default()
            .backup(
                &f.target,
                &f.q,
                &f.id,
                &f.staging(),
                &Cancellation::default(),
                &FixedVolume(low)
            )
            .unwrap_err()
            .code,
        "NO_SPACE"
    );
    let mut wrong = f.target.volume.clone();
    wrong.device_id = "different".into();
    assert_eq!(f.target.status(&FixedVolume(wrong)).status, "failed");
    fs::rename(&f.target.path, f.target.path.with_extension("offline")).unwrap();
    assert_eq!(f.target.status(&NativeVolumes).status, "waiting-disk");
    assert!(!f.target.path.exists());
}
#[test]
fn overlap_unknown_root_and_manifest_paths_are_rejected() {
    let f = Fixture::new();
    assert!(
        initialize_target(
            &f.dir.path().join("source"),
            &[f.dir.path().join("source")],
            &NativeVolumes
        )
        .is_err()
    );
    let mut service = LocalBackupService::default();
    f.run(&mut service);
    let mut m = f.manifest();
    m.cleanup.push(Entry {
        path: "../../user.txt".into(),
        size: 1,
        sha256: "0".repeat(64),
        token: None,
    });
    fs::write(
        f.root().join(".backup/manifest.json"),
        serde_json::to_vec(&m).unwrap(),
    )
    .unwrap();
    assert!(
        service
            .verify(
                &f.target,
                &f.id,
                &f.staging(),
                &Cancellation::default(),
                &NativeVolumes
            )
            .is_err()
    );
}
#[cfg(unix)]
#[test]
fn replaced_root_and_symlink_never_publish_or_delete_other_directory() {
    struct Replace {
        path: PathBuf,
        saved: PathBuf,
    }
    impl Observer for Replace {
        fn checkpoint(&mut self, p: Checkpoint) -> Result<()> {
            if p == Checkpoint::BeforeManifest {
                fs::rename(&self.path, &self.saved)?;
                fs::create_dir(&self.path)?;
                fs::copy(
                    self.saved.join("backup-root.json"),
                    self.path.join("backup-root.json"),
                )?;
            }
            Ok(())
        }
    }
    let f = Fixture::new();
    let mut service = LocalBackupService::default();
    f.run(&mut service);
    f.edit();
    let saved = f.target.path.with_extension("original");
    assert!(
        service
            .backup_observed(
                &f.target,
                &f.q,
                &f.id,
                &f.staging(),
                &Cancellation::default(),
                &NativeVolumes,
                &mut Replace {
                    path: f.target.path.clone(),
                    saved: saved.clone()
                }
            )
            .is_err()
    );
    assert!(!f.target.path.join("notebooks").exists());
    fs::remove_dir_all(&f.target.path).unwrap();
    fs::rename(saved, &f.target.path).unwrap();
    assert_eq!(f.restored_body(), "first body");
    let chunks = f.root().join("chunks");
    let saved = f.root().join("saved");
    fs::rename(&chunks, &saved).unwrap();
    std::os::unix::fs::symlink(&saved, &chunks).unwrap();
    assert!(
        service
            .backup(
                &f.target,
                &f.q,
                &f.id,
                &f.staging(),
                &Cancellation::default(),
                &NativeVolumes
            )
            .is_err()
    );
}
#[test]
fn group_reports_each_notebook_and_cancelled_items() {
    let f = Fixture::new();
    let mut service = LocalBackupService::default();
    let other =
        f.q.submit(|s| s.create_notebook("Other"))
            .unwrap()
            .wait()
            .unwrap()
            .id;
    let ids = vec![f.id.clone(), other];
    assert!(
        service
            .backup_group(
                &f.target,
                &f.q,
                &ids,
                &f.staging(),
                &Cancellation::default(),
                &NativeVolumes
            )
            .unwrap()
            .iter()
            .all(|r| r.status == "completed")
    );
    let cancel = Cancellation::default();
    cancel.cancel();
    assert!(
        service
            .backup_group(&f.target, &f.q, &ids, &f.staging(), &cancel, &NativeVolumes)
            .unwrap()
            .iter()
            .all(|r| r.status == "cancelled")
    );
}
#[test]
fn manifest_rejects_duplicate_files_bad_sizes_and_preserves_ordered_repeated_chunks() {
    let f = Fixture::new();
    f.run(&mut LocalBackupService::default());
    let m = f.manifest();
    let mut bad = m.clone();
    bad.files.push(bad.files[0].clone());
    assert!(bad.validate(&f.target.id, &f.id).is_err());
    let mut bad = m.clone();
    bad.database.chunks[0].size += 1;
    assert!(bad.validate(&f.target.id, &f.id).is_err());
    let mut bad_name = m.clone();
    bad_name.name = "😀".repeat(121);
    assert!(bad_name.validate(&f.target.id, &f.id).is_err());
    let mut repeated = m.clone();
    let hash = repeated.database.chunks[0].sha256.clone();
    repeated.database.chunks = vec![
        Chunk {
            sha256: hash.clone(),
            size: CHUNK_BYTES
        };
        2
    ];
    repeated.database.file.size = 2 * CHUNK_BYTES;
    repeated.files = vec![Entry {
        path: format!("chunks/{hash}.bin"),
        size: CHUNK_BYTES,
        sha256: hash,
        token: None,
    }];
    repeated.validate(&f.target.id, &f.id).unwrap();
    let encoded: Value = serde_json::to_value(repeated).unwrap();
    assert_eq!(encoded["database"]["chunks"].as_array().unwrap().len(), 2);
}

#[test]
fn windows_volume_fixture_and_linux_bind_mount_do_not_claim_physical_independence() {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!(
        "../../../tests/fixtures/volume/windows/volumes.json"
    ))
    .unwrap();
    for f in fixtures {
        let volume = volume::windows_volume(
            f["filesystem"].as_str().unwrap(),
            f["guid"].as_str().unwrap(),
            f["serial"].as_u64().unwrap() as u32,
            f["driveType"].as_u64().unwrap() as u32,
            f["mount"].as_str().unwrap().into(),
            f["availableBytes"].as_u64().unwrap(),
        )
        .unwrap();
        assert_eq!(volume.remote, f["remote"]);
        assert_eq!(volume.maximum_file_bytes, f["maximumFileBytes"].as_u64());
    }
    let mounts = include_str!("../../../tests/fixtures/volume/linux/mountinfo.txt");
    let root = volume::linux_mountinfo(mounts, Path::new("/data"), 1).unwrap();
    let bind = volume::linux_mountinfo(mounts, Path::new("/same-device/data"), 1).unwrap();
    assert!(root.same_volume(&bind));
    assert!(
        volume::linux_mountinfo(mounts, Path::new("/cloud"), 1)
            .unwrap()
            .remote
    );
}
#[test]
fn unreferenced_asset_rows_and_bytes_are_preserved_in_local_cut() {
    use sha2::{Digest, Sha256};
    let f = Fixture::new();
    let id = f.id.clone();
    f.q.submit(move |s| s.close_notebook(&id))
        .unwrap()
        .wait()
        .unwrap();
    let bytes = b"unreferenced but retained source asset";
    let hash = format!("{:x}", Sha256::digest(bytes));
    let source = f.dir.path().join("source").join(&f.id);
    let path = source.join(asset_relative_path(&hash).unwrap());
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
    let db = rusqlite::Connection::open(source.join("notebook.sqlite")).unwrap();
    db.execute(
        "INSERT INTO assets(hash,size,mime) VALUES(?,?,?)",
        rusqlite::params![hash, bytes.len(), "application/octet-stream"],
    )
    .unwrap();
    drop(db);
    f.run(&mut LocalBackupService::default());
    assert!(f.manifest().assets.iter().any(|a| a.sha256 == hash));
    let meta = LocalBackupService::default()
        .restore(
            &f.target,
            &f.id,
            &f.dir.path().join("restored"),
            &Cancellation::default(),
            &NativeVolumes,
        )
        .unwrap();
    assert_eq!(
        fs::read(
            f.dir
                .path()
                .join("restored")
                .join(meta.id)
                .join(asset_relative_path(&hash).unwrap())
        )
        .unwrap(),
        bytes
    );
}

#[test]
fn manual_group_jobs_reuse_durable_task_history_and_receipts() {
    use anynote_core::backend::TaskStatus;
    use anynote_services::tasks::TaskHistory;
    use anynote_storage::runtime_state::RuntimeState;
    let f = Fixture::new();
    let state = RuntimeState::open(&f.dir.path().join("runtime")).unwrap();
    let mut history = TaskHistory::load(&state).unwrap();
    let mut service = LocalBackupService::default();
    for job in [
        LocalJob::Backup {
            notebook_ids: vec![f.id.clone()],
        },
        LocalJob::Verify {
            notebook_id: f.id.clone(),
        },
        LocalJob::Restore {
            notebook_ids: vec![f.id.clone()],
            destination: f.dir.path().join("restored"),
        },
    ] {
        let record = prepare_job(&mut history, &state).unwrap();
        let receipt = service
            .execute_job(
                &mut history,
                &state,
                &record,
                job,
                JobContext {
                    target: &f.target,
                    queue: &f.q,
                    temporary: &f.staging(),
                    cancel: &Cancellation::default(),
                    volumes: &NativeVolumes,
                },
            )
            .unwrap();
        assert_eq!(receipt.status, "completed");
        assert_eq!(
            job_receipt(&state, &record).unwrap().unwrap().task_id,
            record.id()
        );
        assert_eq!(
            history.list().last().unwrap().status(),
            TaskStatus::Completed
        );
    }
    let record = prepare_job(&mut history, &state).unwrap();
    drop(history);
    let history = TaskHistory::load(&state).unwrap();
    assert_eq!(
        history.list().last().unwrap().status(),
        TaskStatus::Interrupted
    );
    assert!(job_receipt(&state, &record).unwrap().is_none());
}

#[test]
fn changed_manifest_disables_token_trust_and_zero_capture() {
    let f = Fixture::new();
    let mut service = LocalBackupService::default();
    f.run(&mut service);
    let mut m = f.manifest();
    m.name = "tampered metadata".into();
    fs::write(
        f.root().join(".backup/manifest.json"),
        serde_json::to_vec(&m).unwrap(),
    )
    .unwrap();
    let result = f.run(&mut service);
    assert!(!result.capture_skipped);
    assert_eq!(f.manifest().name, "Local backup");
}

#[test]
fn file_replaced_between_copy_and_commit_rejects_publication() {
    struct CorruptNew(PathBuf);
    impl Observer for CorruptNew {
        fn checkpoint(&mut self, p: Checkpoint) -> Result<()> {
            if p == Checkpoint::FilesWritten {
                let pending: Value =
                    serde_json::from_slice(&fs::read(self.0.join(".backup/pending.json"))?)?;
                let path = self.0.join(pending["files"][0]["path"].as_str().unwrap());
                let mut bytes = fs::read(&path)?;
                bytes[0] ^= 1;
                fs::write(path, bytes)?;
            }
            Ok(())
        }
    }
    let f = Fixture::new();
    let mut service = LocalBackupService::default();
    f.run(&mut service);
    f.edit();
    let previous = f.manifest().task_id;
    assert_eq!(
        service
            .backup_observed(
                &f.target,
                &f.q,
                &f.id,
                &f.staging(),
                &Cancellation::default(),
                &NativeVolumes,
                &mut CorruptNew(f.root())
            )
            .unwrap_err()
            .code,
        "FILE_CHANGED"
    );
    assert_eq!(f.manifest().task_id, previous);
    assert_eq!(f.restored_body(), "first body");
}

#[test]
fn backup_restores_to_new_library_when_source_database_is_corrupt() {
    let f = Fixture::new();
    f.run(&mut LocalBackupService::default());
    let id = f.id.clone();
    f.q.submit(move |s| s.close_notebook(&id))
        .unwrap()
        .wait()
        .unwrap();
    let source = f
        .dir
        .path()
        .join("source")
        .join(&f.id)
        .join("notebook.sqlite");
    fs::write(&source, b"corrupt original evidence").unwrap();
    assert_eq!(f.restored_body(), "first body");
    assert_eq!(fs::read(source).unwrap(), b"corrupt original evidence");
}

#[test]
fn macos_volume_uuid_response_has_explicit_weak_identity_fallback() {
    let id = uuid::Uuid::parse_str("a266fd42-55c9-4018-9d5f-c39bcc312154").unwrap();
    let mut bytes = 20u32.to_ne_bytes().to_vec();
    bytes.extend_from_slice(id.as_bytes());
    assert_eq!(volume::macos_volume_uuid(&bytes), Some(id.to_string()));
    bytes[4..].fill(0);
    assert_eq!(volume::macos_volume_uuid(&bytes), None);
    bytes[0] = 0;
    assert_eq!(volume::macos_volume_uuid(&bytes), None);
    assert_eq!(volume::macos_volume_uuid(&[]), None);
}
