use anynote_core::environment::{Environment, EnvironmentEvent};
use anynote_services::{
    cloud::*,
    config_migration::{Result as SecretResult, credentials::SecretStore},
    scheduler::*,
};
use anynote_storage::{notebook::*, runtime_state::RuntimeState};
use serde_json::json;
use std::{cell::RefCell, collections::BTreeMap, fs, path::Path};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;
fn temp() -> tempfile::TempDir {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm10");
    fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root.canonicalize().unwrap()).unwrap()
}
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn connection() -> RecoveryConnection {
    RecoveryConnection {
        id: id(),
        name: "Recovery".into(),
        endpoint: "https://backup.example".into(),
        allow_insecure: false,
    }
}
fn identity(c: &RecoveryConnection, upload: bool) -> TransferIdentity {
    TransferIdentity {
        connection_id: c.id.clone(),
        endpoint: c.endpoint.clone(),
        notebook_id: id(),
        lineage_id: id(),
        direction: if upload {
            Direction::Upload
        } else {
            Direction::Download
        },
        writer: upload.then(|| WriterIdentity {
            device_id: id(),
            epoch: 1,
        }),
    }
}
#[test]
fn javascript_manifest_numbers_order_and_protocol_bounds() {
    let value =
        serde_json::from_str(r#"{"10":10,"2":2,"z":-0.0,"a":1e-7,"01":0.000001,"𐀀":"中\n\""}"#)
            .unwrap();
    assert_eq!(
        stringify(&value).unwrap(),
        "{\"2\":2,\"10\":10,\"z\":0,\"a\":1e-7,\"01\":0.000001,\"𐀀\":\"中\\n\\\"\"}"
    );
    assert!(stringify(&json!(9007199254740992u64)).is_err());
    assert_eq!(
        stringify(&json!(9007199254740991u64)).unwrap(),
        "9007199254740991"
    );
    let mut v: serde_json::Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/rust-migration/corpus/cloud-snapshot.json"
    ))
    .unwrap();
    v["generationId"] = json!(id());
    v["lineageId"] = json!(id());
    v["deviceId"] = json!(id());
    v["expectedHead"] = json!("");
    v["writerEpoch"] = json!(1);
    let valid = Manifest::parse(&serde_json::to_vec(&v).unwrap()).unwrap();
    assert_eq!(valid.bytes(), stringify(&v).unwrap().as_bytes());
    for (key, value) in [
        ("writerEpoch", json!(0)),
        ("snapshotSeq", json!(9007199254740992u64)),
        ("snapshotSeq", json!(1.5)),
        ("protocolVersion", json!(2)),
        ("expectedHead", json!("bad")),
    ] {
        let mut bad = v.clone();
        bad[key] = value;
        assert!(
            Manifest::parse(&serde_json::to_vec(&bad).unwrap()).is_err(),
            "{key}"
        );
    }
    let mut bad = v.clone();
    bad["database"]["chunks"][0]["size"] = json!(1);
    assert!(Manifest::parse(&serde_json::to_vec(&bad).unwrap()).is_err());
    let mut bad = v.clone();
    bad["assets"][0]["path"] = json!("../escape");
    assert!(Manifest::parse(&serde_json::to_vec(&bad).unwrap()).is_err());
    let mut repeated = v.clone();
    let chunk = json!({"sha256":"a".repeat(64),"size":CHUNK_BYTES});
    repeated["database"] = json!({"chunkSize":CHUNK_BYTES,"size":CHUNK_BYTES*2,"sha256":"b".repeat(64),"chunks":[chunk.clone(),chunk]});
    assert_eq!(
        Manifest::parse(&serde_json::to_vec(&repeated).unwrap())
            .unwrap()
            .data()
            .database
            .chunks
            .len(),
        2
    );
}
#[test]
fn connection_secret_separation_and_retry_after() {
    #[derive(Default)]
    struct Vault(RefCell<BTreeMap<String, Vec<u8>>>);
    impl SecretStore for Vault {
        fn read(&self, id: &str) -> SecretResult<Option<Zeroizing<Vec<u8>>>> {
            Ok(self.0.borrow().get(id).cloned().map(Zeroizing::new))
        }
        fn write(&self, id: &str, value: &[u8]) -> SecretResult<()> {
            self.0.borrow_mut().insert(id.into(), value.into());
            Ok(())
        }
    }
    let temp = temp();
    let state = RuntimeState::open(temp.path()).unwrap();
    let vault = Vault::default();
    let c = connection();
    save_recovery_connection(&state, &vault, c.clone(), "NEVER_PERSIST_THIS_TOKEN").unwrap();
    assert!(CloudClient::from_vault(c.clone(), &vault).is_ok());
    assert_eq!(recovery_connections(&state).unwrap(), vec![c.clone()]);
    assert!(save_recovery_connection(&state, &vault, c, "changed").is_err());
    drop(state);
    for entry in fs::read_dir(temp.path()).unwrap() {
        let bytes = fs::read(entry.unwrap().path()).unwrap();
        assert!(!bytes.windows(24).any(|b| b == b"NEVER_PERSIST_THIS_TOKEN"));
    }
    for endpoint in [
        "http://example.com",
        "https://u:p@example.com",
        "https://example.com/?secret=x",
        "file:///tmp",
    ] {
        let mut c = connection();
        c.endpoint = endpoint.into();
        assert!(c.validate().is_err());
    }
    assert_eq!(retry_after("120", 0), Some(120000));
    assert_eq!(
        retry_after("999999999999999999999999999", 0),
        Some(86400000)
    );
    assert_eq!(
        retry_after("Thu, 01 Jan 1970 00:00:02 GMT", 1000),
        Some(1000)
    );
    assert_eq!(retry_after("invalid", 0), None);
}
#[test]
fn durable_snapshot_pending_exclusive_lease_and_identity() {
    let temp = temp();
    let data = temp.path().join("data");
    fs::create_dir(&data).unwrap();
    let state = temp.path().join("state");
    fs::create_dir(&state).unwrap();
    let queue = WriteQueue::open(&data, 2).unwrap();
    let notebook = queue
        .submit(|s| Ok(s.create_notebook("cloud")?.id))
        .unwrap()
        .wait()
        .unwrap();
    let name = notebook.clone();
    let root = data.clone();
    let mut cut = queue
        .submit(move |s| s.capture_snapshot(&name, &root, &Cancellation::default()))
        .unwrap()
        .wait()
        .unwrap();
    let c = connection();
    let i = identity(&c, true);
    let mut session = TransferSession::open(&state, i.clone()).unwrap();
    assert!(TransferSession::open(&state, i.clone()).is_err());
    let manifest = prepare_upload(
        &mut session,
        &mut cut,
        "",
        "2026-11-08T00:00:00.000Z",
        &Cancellation::default(),
    )
    .unwrap();
    assert!(
        prepare_upload(
            &mut session,
            &mut cut,
            "",
            "2026-11-08T00:00:00.000Z",
            &Cancellation::default()
        )
        .is_err()
    );
    let pending = session.cursor().unwrap();
    assert_eq!(
        pending.pending_generation,
        Some(manifest.data().generation_id.clone())
    );
    drop(session);
    drop(cut);
    drop(queue);
    let session = TransferSession::open(&state, i.clone()).unwrap();
    assert_eq!(
        session.cursor().unwrap().pending_generation,
        pending.pending_generation
    );
    let mut changed = i;
    changed.writer.as_mut().unwrap().epoch = 2;
    assert!(
        TransferSession::open(&state, changed)
            .unwrap()
            .cursor()
            .unwrap()
            .pending_generation
            .is_none()
    );
}
fn target(kind: BackupKind) -> ScheduledTarget {
    ScheduledTarget {
        id: id(),
        binding: "frozen.identity".into(),
        kind,
        enabled: true,
        interval_ms: 60000,
        on_mount: true,
        last_task_bytes: 0,
    }
}
fn environment() -> Environment {
    let mut e = Environment::default();
    e.apply(EnvironmentEvent::PowerChanged(Some(false)));
    e.apply(EnvironmentEvent::NetworkChanged {
        online: Some(true),
        metered: Some(false),
    });
    e
}
const AVAILABLE: Availability = Availability {
    notebook: true,
    disk: true,
};
#[tokio::test]
async fn scheduler_unifies_local_remote_sticky_retry_and_cancel() {
    let temp = temp();
    let store = RuntimeState::open(temp.path()).unwrap();
    let mut s = BackupScheduler::load(&store).unwrap();
    let remote = target(BackupKind::Remote);
    let local = target(BackupKind::Local);
    s.configure(&store, remote.clone()).unwrap();
    s.configure(&store, local.clone()).unwrap();
    let cancel = CancellationToken::new();
    assert_eq!(
        s.tick(
            &store,
            &Environment::default(),
            0,
            |_| AVAILABLE,
            &cancel,
            |_, _| async { Ok(1) }
        )
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        s.state(&remote.id).unwrap().paused,
        Some(PauseReason::Observation)
    );
    let error = CloudError {
        code: "HTTP_429".into(),
        status: Some(429),
        retry_after_ms: Some(120000),
    };
    assert_eq!(
        s.tick(
            &store,
            &environment(),
            0,
            |_| AVAILABLE,
            &cancel,
            |_, _| {
                let e = error.clone();
                async move { Err(e) }
            }
        )
        .await
        .unwrap(),
        1
    );
    assert_eq!(s.state(&remote.id).unwrap().next_attempt, Some(120000));
    s.configure(
        &store,
        ScheduledTarget {
            enabled: false,
            ..local
        },
    )
    .unwrap();
    assert_eq!(
        s.tick(
            &store,
            &environment(),
            119999,
            |_| AVAILABLE,
            &cancel,
            |_, _| async { panic!("early retry") }
        )
        .await
        .unwrap(),
        0
    );
    assert_eq!(
        s.tick(
            &store,
            &environment(),
            120000,
            |_| AVAILABLE,
            &cancel,
            |_, _| async {
                Err(CloudError {
                    code: "HTTP_401".into(),
                    status: Some(401),
                    retry_after_ms: None,
                })
            }
        )
        .await
        .unwrap(),
        1
    );
    assert_eq!(s.state(&remote.id).unwrap().paused, Some(PauseReason::Auth));
    drop(s);
    let mut s = BackupScheduler::load(&store).unwrap();
    assert_eq!(
        s.tick(
            &store,
            &environment(),
            999999,
            |_| AVAILABLE,
            &cancel,
            |_, _| async { panic!("sticky auth") }
        )
        .await
        .unwrap(),
        0
    );
    s.repair(&store, &remote.id).unwrap();
    s.tick(
        &store,
        &environment(),
        999999,
        |_| AVAILABLE,
        &cancel,
        |_, _| async { Err(CloudError::new("CANCELLED")) },
    )
    .await
    .unwrap();
    assert_eq!(
        s.state(&remote.id).unwrap().paused,
        Some(PauseReason::Cancelled)
    );
    assert_eq!(s.state(&remote.id).unwrap().failure_count, 0);
}
#[tokio::test]
async fn scheduler_environment_exhaustion_restart_and_conflicts() {
    let temp = temp();
    let store = RuntimeState::open(temp.path()).unwrap();
    let mut s = BackupScheduler::load(&store).unwrap();
    let mut t = target(BackupKind::Remote);
    t.last_task_bytes = 101;
    s.configure(&store, t.clone()).unwrap();
    let policy = BackupPolicy {
        on_battery: true,
        on_metered: true,
        large_task_bytes: 100,
        max_attempts: 2,
        ..Default::default()
    };
    s.set_policy(&store, policy).unwrap();
    let c = CancellationToken::new();
    let mut env = environment();
    for (event, reason) in [
        (
            EnvironmentEvent::NetworkChanged {
                online: Some(false),
                metered: Some(false),
            },
            PauseReason::Offline,
        ),
        (
            EnvironmentEvent::NetworkChanged {
                online: Some(true),
                metered: Some(true),
            },
            PauseReason::Metered,
        ),
        (
            EnvironmentEvent::PowerChanged(Some(true)),
            PauseReason::Battery,
        ),
    ] {
        env.apply(event);
        assert_eq!(
            s.tick(
                &store,
                &env,
                0,
                |_| AVAILABLE,
                &c,
                |_, _| async { panic!("paused") }
            )
            .await
            .unwrap(),
            0
        );
        assert_eq!(s.state(&t.id).unwrap().paused, Some(reason));
    }
    assert_eq!(
        s.tick(
            &store,
            &environment(),
            0,
            |_| AVAILABLE,
            &c,
            |_, _| async { panic!("large") }
        )
        .await
        .unwrap(),
        0
    );
    assert_eq!(s.state(&t.id).unwrap().paused, Some(PauseReason::LargeTask));
    t.last_task_bytes = 0;
    s.configure(&store, t.clone()).unwrap();
    for now in [0, 120000] {
        s.tick(
            &store,
            &environment(),
            now,
            |_| AVAILABLE,
            &c,
            |_, _| async { Err(CloudError::new("NETWORK")) },
        )
        .await
        .unwrap();
    }
    assert_eq!(s.state(&t.id).unwrap().paused, Some(PauseReason::Exhausted));
    s.repair(&store, &t.id).unwrap();
    s.tick(
        &store,
        &environment(),
        240000,
        |_| AVAILABLE,
        &c,
        |_, _| async {
            Err(CloudError {
                code: "WRITER_REVOKED".into(),
                status: Some(409),
                retry_after_ms: None,
            })
        },
    )
    .await
    .unwrap();
    assert_eq!(s.state(&t.id).unwrap().paused, Some(PauseReason::Permanent));
    s.repair(&store, &t.id).unwrap();
    let env = environment();
    {
        let run = s.tick(
            &store,
            &env,
            360000,
            |_| AVAILABLE,
            &c,
            |_, _| std::future::pending(),
        );
        tokio::pin!(run);
        tokio::select! {_=&mut run=>panic!("pending"),_=tokio::time::sleep(std::time::Duration::from_millis(5))=>()};
    }
    let restored = BackupScheduler::load(&store).unwrap();
    assert!(restored.state(&t.id).unwrap().interrupted);
    assert!(!restored.state(&t.id).unwrap().running);
}

#[tokio::test]
async fn scheduler_dispatches_real_rm09_backup_and_preserves_mount_backoff() {
    use anynote_services::local_backup::{LocalBackupService, NativeVolumes, initialize_target};
    let temp = temp();
    for name in ["data", "disk", "staging", "state"] {
        fs::create_dir(temp.path().join(name)).unwrap();
    }
    let queue = WriteQueue::open(&temp.path().join("data"), 2).unwrap();
    let notebook = queue
        .submit(|s| Ok(s.create_notebook("scheduled local")?.id))
        .unwrap()
        .wait()
        .unwrap();
    let disk = initialize_target(
        &temp.path().join("disk"),
        &[temp.path().join("data")],
        &NativeVolumes,
    )
    .unwrap();
    let store = RuntimeState::open(&temp.path().join("state")).unwrap();
    let mut scheduler = BackupScheduler::load(&store).unwrap();
    let target = ScheduledTarget {
        id: disk.id.clone(),
        binding: serde_json::to_string(&disk).unwrap(),
        ..target(BackupKind::Local)
    };
    scheduler.configure(&store, target.clone()).unwrap();
    let cancel = CancellationToken::new();
    let execute = |_: ScheduledTarget, token: CancellationToken| {
        let disk = disk.clone();
        let queue = queue.clone();
        let notebook = notebook.clone();
        let staging = temp.path().join("staging");
        async move {
            let storage_cancel = Cancellation::default();
            if token.is_cancelled() {
                storage_cancel.cancel();
            }
            tokio::task::spawn_blocking(move || {
                LocalBackupService::default()
                    .backup(
                        &disk,
                        &queue,
                        &notebook,
                        &staging,
                        &storage_cancel,
                        &NativeVolumes,
                    )
                    .map(|r| r.copied_bytes)
                    .map_err(|e| CloudError::new(&e.code))
            })
            .await
            .unwrap()
        }
    };
    assert_eq!(
        scheduler
            .tick(
                &store,
                &Environment::default(),
                0,
                |_| AVAILABLE,
                &cancel,
                execute
            )
            .await
            .unwrap(),
        1
    );
    assert!(
        disk.path
            .join("notebooks")
            .join(&notebook)
            .join(".backup/manifest.json")
            .exists()
    );
    assert_eq!(scheduler.state(&target.id).unwrap().last_success, Some(0));
    scheduler
        .tick(
            &store,
            &environment(),
            60000,
            |_| AVAILABLE,
            &cancel,
            |_, _| async {
                Err(CloudError {
                    code: "NETWORK".into(),
                    status: None,
                    retry_after_ms: Some(120000),
                })
            },
        )
        .await
        .unwrap();
    scheduler
        .tick(
            &store,
            &environment(),
            60001,
            |_| Availability {
                notebook: true,
                disk: false,
            },
            &cancel,
            |_, _| async { panic!("disk offline") },
        )
        .await
        .unwrap();
    assert_eq!(
        scheduler
            .tick(
                &store,
                &environment(),
                60002,
                |_| AVAILABLE,
                &cancel,
                |_, _| async { panic!("mount must not bypass Retry-After") }
            )
            .await
            .unwrap(),
        0
    );
}
