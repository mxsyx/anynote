use anynote_core::{backend::*, management::*};
use anynote_desktop::backend_client::{BackendClient, Response};
use std::{path::PathBuf, time::Duration};
use uuid::Uuid;
const WAIT: Duration = Duration::from_secs(30);
struct Backend {
    root: PathBuf,
    client: BackendClient,
}
impl Backend {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tmp/rm29")
            .join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let client = BackendClient::launch(
            PathBuf::from(env!("CARGO_BIN_EXE_anynote-desktop")),
            root.clone(),
        )
        .recv_blocking()
        .unwrap()
        .unwrap();
        Self { root, client }
    }
    fn request(&self, command: Command) -> Reply {
        match self
            .client
            .submit(command, WAIT)
            .unwrap()
            .receive_blocking()
            .unwrap()
        {
            Response::Reply(r) => r,
            _ => panic!("reply"),
        }
    }
    fn run(&self, operation: Operation, confirmed: bool) -> JobDetails {
        let Reply::Management(ManagementReply::Started(task)) =
            self.request(Command::Management(ManagementCommand::Start {
                operation,
                confirmed,
            }))
        else {
            panic!("task")
        };
        let Reply::Task(done) = self.request(Command::WaitTask { task_id: task.id() }) else {
            panic!("terminal")
        };
        assert!(!done.status().is_active());
        self.job(task.id())
    }
    fn job(&self, id: Uuid) -> JobDetails {
        let Reply::Management(ManagementReply::Jobs(jobs)) =
            self.request(Command::Management(ManagementCommand::Jobs))
        else {
            panic!()
        };
        jobs.into_iter().find(|j| j.task().id() == id).unwrap()
    }
    fn book(&self) -> String {
        let Reply::Document(d) = self.request(Command::CreateDocument) else {
            panic!()
        };
        d.id().notebook().to_string()
    }
}
impl Drop for Backend {
    fn drop(&mut self) {
        let _ = self
            .client
            .submit(Command::Shutdown, WAIT)
            .and_then(|h| h.receive_blocking());
        for _ in 0..100 {
            if self.client.has_exited() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
#[test]
fn real_backend_group_backup_verify_restore_and_restart_history() {
    let b = Backend::new();
    let book = b.book();
    let disk = b.root.join("disk");
    std::fs::create_dir(&disk).unwrap();
    let added = b.run(
        Operation::AddLocal {
            directory: disk.clone(),
            name: "Drive".into(),
            notebooks: vec![book.clone()],
            interval_minutes: 60,
        },
        false,
    );
    assert_eq!(
        added.task().status(),
        TaskStatus::Completed,
        "{:?}",
        added.report()
    );
    let overview = b.run(Operation::Overview, false);
    let target = overview
        .report()
        .choices()
        .iter()
        .find(|c| *c.kind() == ChoiceKind::LocalTarget)
        .unwrap()
        .id()
        .to_owned();
    let enabled = b.run(
        Operation::SetPaused {
            target: target.clone(),
            paused: false,
        },
        false,
    );
    assert_eq!(enabled.task().status(), TaskStatus::Completed);
    let scheduled = b.run(Operation::RunScheduled, false);
    assert_eq!(scheduled.task().status(), TaskStatus::Completed);
    assert!(scheduled.report().summary().contains("1 个"));
    let scheduled = b.run(Operation::RunScheduled, false);
    assert_eq!(scheduled.task().status(), TaskStatus::Completed);
    assert!(scheduled.report().summary().contains("0 个"));
    let changed = b.run(
        Operation::UpdateLocal {
            target: target.clone(),
            notebooks: vec![book.clone()],
            interval_minutes: 30,
        },
        false,
    );
    assert_eq!(changed.task().status(), TaskStatus::Completed);
    let backup = b.run(
        Operation::LocalBackup {
            target: target.clone(),
        },
        false,
    );
    assert_eq!(
        backup.task().status(),
        TaskStatus::Completed,
        "{:?}",
        backup.report()
    );
    let verify = b.run(
        Operation::LocalVerify {
            target: target.clone(),
            notebook: book.clone(),
        },
        false,
    );
    assert_eq!(
        verify.task().status(),
        TaskStatus::Completed,
        "{:?}",
        verify.report()
    );
    let contents = b.run(
        Operation::LocalContents {
            target: target.clone(),
            offset: 0,
        },
        false,
    );
    assert!(
        contents.report().actions().iter().any(
            |a| matches!(a.operation(),Operation::LocalRestore{notebook,..} if notebook==&book)
        )
    );
    let restored = b.root.join("restored");
    std::fs::create_dir(&restored).unwrap();
    let restore = Operation::LocalRestore {
        target: target.clone(),
        notebook: book.clone(),
        destination: restored.clone(),
    };
    let error = b
        .client
        .submit(
            Command::Management(ManagementCommand::Start {
                operation: restore.clone(),
                confirmed: false,
            }),
            WAIT,
        )
        .unwrap()
        .receive_blocking()
        .unwrap_err();
    assert_eq!(error.code(), ErrorCode::InvalidRequest);
    let done = b.run(restore, true);
    assert_eq!(
        done.task().status(),
        TaskStatus::Completed,
        "{:?}",
        done.report()
    );
    let entries = std::fs::read_dir(&restored)
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(entries.len(), 1);
    assert_ne!(entries[0].file_name().to_string_lossy(), book);
    let restored_id = entries[0].file_name().to_string_lossy().to_string();
    let overview = b.run(Operation::Overview, false);
    assert!(
        overview
            .report()
            .choices()
            .iter()
            .any(|c| c.id() == restored_id)
    );
    let cancelled = b.run(
        Operation::Integrity {
            notebook: restored_id,
        },
        false,
    );
    assert_eq!(cancelled.task().status(), TaskStatus::Completed);
    let missing = b.root.join("disk-away");
    std::fs::rename(&disk, &missing).unwrap();
    let offline = b.run(
        Operation::LocalBackup {
            target: target.clone(),
        },
        false,
    );
    assert_eq!(offline.task().status(), TaskStatus::Interrupted);
    assert!(offline.can_retry());
    std::fs::rename(&missing, &disk).unwrap();
    let Reply::Management(ManagementReply::Started(retry)) =
        b.request(Command::Management(ManagementCommand::Retry {
            task: offline.task().id(),
        }))
    else {
        panic!()
    };
    let Reply::Task(done) = b.request(Command::WaitTask {
        task_id: retry.id(),
    }) else {
        panic!()
    };
    assert_eq!(done.status(), TaskStatus::Completed);
    b.client.terminate();
    let next = b.client.reconnect().recv_blocking().unwrap().unwrap();
    let Response::Reply(Reply::Management(ManagementReply::Jobs(jobs))) = next
        .submit(Command::Management(ManagementCommand::Jobs), WAIT)
        .unwrap()
        .receive_blocking()
        .unwrap()
    else {
        panic!()
    };
    assert!(
        jobs.iter()
            .any(|j| j.task().id() == backup.task().id()
                && j.task().status() == TaskStatus::Completed)
    );
    let _ = next
        .submit(Command::Shutdown, WAIT)
        .unwrap()
        .receive_blocking();
}
#[test]
fn cleanup_is_preview_bound_and_has_recovery_after_failure() {
    let b = Backend::new();
    let book = b.book();
    let snapshots = b.root.join("workspace").join(&book).join("snapshots");
    std::fs::create_dir(&snapshots).unwrap();
    for n in 1..=3 {
        std::fs::write(
            snapshots.join(format!("{n}.anynote")),
            format!("snapshot{n}"),
        )
        .unwrap();
    }
    let p = b.run(
        Operation::CleanupPreview {
            notebook: book.clone(),
            keep: 1,
            days: 0,
        },
        false,
    );
    assert_eq!(p.task().status(), TaskStatus::Completed);
    let apply = p.report().actions()[0].operation().clone();
    let done = b.run(apply, true);
    assert_eq!(done.task().status(), TaskStatus::Completed);
    assert!(!snapshots.join("1.anynote").exists());
    let recover = done
        .report()
        .actions()
        .iter()
        .find(|a| matches!(a.operation(), Operation::CleanupRecover { .. }))
        .unwrap()
        .operation()
        .clone();
    let restored = b.run(recover, false);
    assert_eq!(restored.task().status(), TaskStatus::Completed);
    assert!(snapshots.join("1.anynote").exists());
    let p = b.run(
        Operation::CleanupPreview {
            notebook: book.clone(),
            keep: 1,
            days: 0,
        },
        false,
    );
    std::fs::write(snapshots.join("1.anynote"), "changed").unwrap();
    let failed = b.run(p.report().actions()[0].operation().clone(), true);
    assert_eq!(failed.task().status(), TaskStatus::Failed);
    assert!(
        failed
            .report()
            .actions()
            .iter()
            .any(|a| matches!(a.operation(), Operation::CleanupRecover { .. }))
    );
    assert!(snapshots.join("1.anynote").exists());
}
#[test]
fn diagnostic_settings_export_and_clear_use_existing_protocol() {
    let b = Backend::new();
    b.request(Command::SetDiagnosticLevel {
        level: DiagnosticLevel::Full,
    });
    b.request(Command::Ping);
    let Reply::Diagnostics(d) = b.request(Command::GetDiagnostics) else {
        panic!()
    };
    assert_eq!(d.level(), DiagnosticLevel::Full);
    assert!(!d.events().is_empty());
    let Reply::Resource { token, length } = b.request(Command::ExportDiagnostics) else {
        panic!()
    };
    assert!(length > 0);
    let Response::Chunk(_, bytes) = b
        .client
        .submit(
            Command::ReadResource {
                token,
                offset: 0,
                length: length.min(MAX_CHUNK_BYTES as u64) as u32,
            },
            WAIT,
        )
        .unwrap()
        .receive_blocking()
        .unwrap()
    else {
        panic!()
    };
    assert!(serde_json::from_slice::<serde_json::Value>(&bytes).is_ok());
    b.request(Command::ReleaseResource { token });
    b.request(Command::ClearDiagnostics);
    let Reply::Diagnostics(d) = b.request(Command::GetDiagnostics) else {
        panic!()
    };
    assert!(d.events().is_empty());
}
