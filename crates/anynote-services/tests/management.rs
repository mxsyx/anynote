use anynote_core::{backend::*, management::*};
use anynote_services::{
    cloud::*,
    config_migration::{Result as SecretResult, credentials::SecretStore},
    management::{ManagementCancellation, Outcome, execute},
};
use anynote_storage::{notebook::*, runtime_state::RuntimeState};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    io::{Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use zeroize::Zeroizing;
#[derive(Default)]
struct Vault(RefCell<BTreeMap<String, Vec<u8>>>);
impl SecretStore for Vault {
    fn read(&self, id: &str) -> SecretResult<Option<Zeroizing<Vec<u8>>>> {
        Ok(self.0.borrow().get(id).cloned().map(Zeroizing::new))
    }
    fn write(&self, id: &str, bytes: &[u8]) -> SecretResult<()> {
        self.0.borrow_mut().insert(id.into(), bytes.to_vec());
        Ok(())
    }
}
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
struct Fixture {
    root: tempfile::TempDir,
    queue: WriteQueue,
    vault: Vault,
    notebook: String,
}
impl Fixture {
    fn new() -> Self {
        let tmp = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm29-services");
        std::fs::create_dir_all(&tmp).unwrap();
        let root = tempfile::tempdir_in(tmp.canonicalize().unwrap()).unwrap();
        std::fs::create_dir(root.path().join("workspace")).unwrap();
        let queue = WriteQueue::open(&root.path().join("workspace"), 4).unwrap();
        let notebook = queue
            .submit(|s| Ok(s.create_notebook("Cloud book")?.id))
            .unwrap()
            .wait()
            .unwrap();
        Self {
            root,
            queue,
            vault: Vault::default(),
            notebook,
        }
    }
    fn run(&self, op: Operation, confirmed: bool) -> Outcome {
        execute(
            self.root.path(),
            &self.queue,
            op,
            confirmed,
            &Default::default(),
            &self.vault,
            &|_| {},
        )
    }
}
struct Server {
    endpoint: String,
    denied: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    requests: Arc<Mutex<Vec<String>>>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    fn new(notebook: String) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let denied = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let (d, s, r) = (denied.clone(), stop.clone(), requests.clone());
        let device = id();
        let generation = id();
        let lineage = id();
        let worker = std::thread::spawn(move || {
            while !s.load(Ordering::SeqCst) {
                let Ok((mut stream, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buf = [0u8; 4096];
                let mut length = None;
                loop {
                    let n = stream.read(&mut buf).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buf[..n]);
                    if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&bytes[..end]);
                        let content = header
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length: ")
                                    .and_then(|s| s.parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        length = Some(end + 4 + content);
                    }
                    if length.is_some_and(|n| bytes.len() >= n) {
                        break;
                    }
                }
                let raw = String::from_utf8_lossy(&bytes);
                let line = raw.lines().next().unwrap_or("").to_owned();
                r.lock().unwrap().push(line.clone());
                let path = line.split_whitespace().nth(1).unwrap_or("");
                let (value, status) = if d.load(Ordering::SeqCst) {
                    (json!({"error":{"code":"FORBIDDEN"}}), "403 Forbidden")
                } else if path == "/v1/capabilities" {
                    (
                        json!({"protocolVersion":1,"schemaVersions":[5],"capabilities":["sqlite-assets-v1","conditional-head","backup-discovery-v1","writer-takeover","capture-v1","retention-gc","maintenance-lifecycle-v1"]}),
                        "200 OK",
                    )
                } else if path.starts_with("/v1/backups") {
                    (
                        json!({"backups":[{"id":generation,"notebookId":notebook,"lineageId":lineage,"name":"Remote book","createdAt":"2026-11-10T00:00:00Z","snapshotSeq":1,"databaseBytes":4096}],"warnings":[],"cursor":null}),
                        "200 OK",
                    )
                } else if path == "/v1/devices" {
                    (
                        json!([{"id":device,"notebookId":notebook,"lineageId":lineage,"expiresAt":2000000000000u64,"revoked":0}]),
                        "200 OK",
                    )
                } else if path.starts_with("/v1/devices/") {
                    (json!({"ok":true}), "200 OK")
                } else {
                    (json!({"error":{"code":"UNKNOWN"}}), "404 Not Found")
                };
                let body = serde_json::to_vec(&value).unwrap();
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(&body);
            }
        });
        Self {
            endpoint,
            denied,
            stop,
            requests,
            worker: Some(worker),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.worker.take().unwrap().join().unwrap();
    }
}
#[test]
fn cloud_adapter_discovers_without_local_source_and_rechecks_device_permissions() {
    let f = Fixture::new();
    let server = Server::new(id());
    let connection = id();
    {
        let state = RuntimeState::open(&f.root.path().join("management")).unwrap();
        save_recovery_connection(
            &state,
            &f.vault,
            RecoveryConnection {
                id: connection.clone(),
                name: "Fixture".into(),
                endpoint: server.endpoint.clone(),
                allow_insecure: true,
            },
            "fixture-token",
        )
        .unwrap();
    }
    let o = f.run(
        Operation::Discover {
            connection: connection.clone(),
            cursor: None,
        },
        false,
    );
    assert_eq!(o.status(), TaskStatus::Completed, "{:?}", o.report());
    assert!(
        o.report()
            .actions()
            .iter()
            .any(|a| matches!(a.operation(), Operation::CloudRestore { .. }))
    );
    let o = f.run(
        Operation::AddCloud {
            connection: connection.clone(),
            notebook: f.notebook.clone(),
            interval_minutes: 10,
        },
        false,
    );
    assert_eq!(o.status(), TaskStatus::Completed, "{:?}", o.report());
    let o = f.run(Operation::Overview, false);
    let target = o
        .report()
        .choices()
        .iter()
        .find(|c| *c.kind() == ChoiceKind::CloudTarget)
        .unwrap()
        .id()
        .to_owned();
    let o = f.run(
        Operation::RetentionSave {
            target: target.clone(),
            keep: 3,
            days: 7,
            weeks: 4,
            months: 2,
        },
        false,
    );
    assert_eq!(o.status(), TaskStatus::Completed);
    let o = f.run(
        Operation::Devices {
            connection: connection.clone(),
        },
        false,
    );
    assert_eq!(o.status(), TaskStatus::Completed);
    let revoke = o.report().actions()[0].operation().clone();
    let rejected = f.run(revoke.clone(), false);
    assert_eq!(rejected.status(), TaskStatus::Failed);
    assert!(
        !server
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.starts_with("DELETE"))
    );
    server.denied.store(true, Ordering::SeqCst);
    let denied = f.run(revoke.clone(), true);
    assert_eq!(denied.status(), TaskStatus::Failed);
    assert!(denied.report().summary().contains("权限"));
    assert!(
        !server
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.starts_with("DELETE"))
    );
    server.denied.store(false, Ordering::SeqCst);
    let done = f.run(revoke, true);
    assert_eq!(done.status(), TaskStatus::Completed);
    assert!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.starts_with("DELETE"))
    );
    let cancel = ManagementCancellation::default();
    cancel.cancel();
    let o = execute(
        f.root.path(),
        &f.queue,
        Operation::CloudBackup { target },
        false,
        &cancel,
        &f.vault,
        &|_| {},
    );
    assert_eq!(o.status(), TaskStatus::Cancelled);
}
#[test]
fn group_cancellation_preserves_committed_book_and_reports_unstarted_books() {
    for scheduled in [false, true] {
        let f = Fixture::new();
        let second = f
            .queue
            .submit(|s| Ok(s.create_notebook("Second")?.id))
            .unwrap()
            .wait()
            .unwrap();
        let disk = f.root.path().join("disk");
        std::fs::create_dir(&disk).unwrap();
        let added = f.run(
            Operation::AddLocal {
                directory: disk,
                name: "Group".into(),
                notebooks: vec![f.notebook.clone(), second.clone()],
                interval_minutes: 60,
            },
            false,
        );
        assert_eq!(
            added.status(),
            TaskStatus::Completed,
            "{:?}",
            added.report()
        );
        let overview = f.run(Operation::Overview, false);
        let target = overview
            .report()
            .choices()
            .iter()
            .find(|c| *c.kind() == ChoiceKind::LocalTarget)
            .unwrap()
            .id()
            .to_owned();
        let operation = if scheduled {
            let enabled = f.run(
                Operation::SetPaused {
                    target: target.clone(),
                    paused: false,
                },
                false,
            );
            assert_eq!(enabled.status(), TaskStatus::Completed);
            Operation::RunScheduled
        } else {
            Operation::LocalBackup {
                target: target.clone(),
            }
        };
        let cancel = ManagementCancellation::default();
        let outcome = execute(
            f.root.path(),
            &f.queue,
            operation,
            false,
            &cancel,
            &f.vault,
            &|report| {
                if report.summary() == "备份已提交" {
                    cancel.cancel();
                }
            },
        );
        assert_eq!(
            outcome.status(),
            TaskStatus::Cancelled,
            "{:?}",
            outcome.report()
        );
        assert!(
            outcome
                .report()
                .lines()
                .iter()
                .any(|(id, value)| id == &f.notebook && value.contains("已提交"))
        );
        assert!(
            outcome
                .report()
                .lines()
                .iter()
                .any(|(id, value)| id == &second && value == "未执行（已取消）")
        );
        let verified = f.run(
            Operation::LocalVerify {
                target: target.clone(),
                notebook: f.notebook.clone(),
            },
            false,
        );
        assert_eq!(verified.status(), TaskStatus::Completed);
        let absent = f.run(
            Operation::LocalVerify {
                target,
                notebook: second,
            },
            false,
        );
        assert_ne!(absent.status(), TaskStatus::Completed);
    }
}
#[test]
fn sensitive_jobs_are_not_persisted_and_restore_replay_is_not_offered() {
    let task = TaskRecord::new(uuid::Uuid::new_v4(), RecoveryPolicy::ReadOnly);
    let mut job = JobDetails::new(
        task.clone(),
        &Operation::SaveConnection {
            name: "secret".into(),
            endpoint: "https://example.invalid".into(),
            token: "do-not-store".into(),
        },
    );
    job.progress(Report::new("do-not-store"));
    let json = serde_json::to_string(&job.persisted(false)).unwrap();
    assert!(!json.contains("do-not-store"));
    let mut task = task;
    task.transition(TaskStatus::Interrupted).unwrap();
    let restore = JobDetails::new(
        task,
        &Operation::LocalRestore {
            target: id(),
            notebook: id(),
            destination: PathBuf::from("/tmp"),
        },
    );
    assert!(!restore.can_retry());
    let _: Value = serde_json::from_str(&json).unwrap();
}
