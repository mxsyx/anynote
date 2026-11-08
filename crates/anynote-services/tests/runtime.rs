use anynote_core::{
    backend::*,
    environment::{Environment, EnvironmentEvent},
};
use anynote_services::{
    diagnostics::{Diagnostics, EVENT_LIMIT},
    resources::Resources,
    scheduler::{ScheduleDecision, background_decision},
    tasks::TaskHistory,
};
use anynote_storage::runtime_state::RuntimeState;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use uuid::Uuid;
struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tmp/rm03")
            .join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn task_restart_preserves_recovery_and_sequences_without_replay() {
    let directory = Directory::new();
    let store = RuntimeState::open(&directory.0).unwrap();
    let mut tasks = TaskHistory::load(&store).unwrap();
    let receipt = RecoveryPolicy::Receipt {
        operation_id: Uuid::new_v4(),
    };
    let revision = RecoveryPolicy::Revision {
        notebook_id: Uuid::new_v4(),
        node_id: Uuid::new_v4(),
        expected_revision: 19,
    };
    let a = tasks.start(&store, receipt.clone()).unwrap();
    let b = tasks.start(&store, revision.clone()).unwrap();
    tasks
        .transition(&store, b.id(), TaskStatus::Committing)
        .unwrap();
    assert!(
        tasks
            .transition(&store, b.id(), TaskStatus::Cancelled)
            .is_err()
    );
    drop(store);
    let store = RuntimeState::open(&directory.0).unwrap();
    let mut tasks = TaskHistory::load(&store).unwrap();
    let records = tasks.list();
    assert_eq!(records[0].id(), a.id());
    assert_eq!(records[0].recovery(), &receipt);
    assert_eq!(records[1].recovery(), &revision);
    assert_eq!(records[0].sequence(), 2);
    assert_eq!(records[1].sequence(), 3);
    assert!(
        records
            .iter()
            .all(|r| r.status() == TaskStatus::Interrupted)
    );
    assert!(
        tasks
            .transition(&store, a.id(), TaskStatus::Completed)
            .is_err()
    );
    for _ in 0..220 {
        let task = tasks.start(&store, RecoveryPolicy::ReadOnly).unwrap();
        tasks
            .transition(&store, task.id(), TaskStatus::Completed)
            .unwrap();
    }
    assert_eq!(tasks.list().len(), 200);
}
#[test]
fn resource_limits_ranges_expiry_and_release() {
    let mut resources = Resources::default();
    let now = Instant::now();
    let bytes: Vec<_> = (0..MAX_CHUNK_BYTES * 2 + 11)
        .map(|ix| (ix % 251) as u8)
        .collect();
    let (token, length) = resources.grant(bytes.clone(), now).unwrap();
    assert_eq!(length as usize, bytes.len());
    let mut result = vec![];
    while result.len() < bytes.len() {
        let (part, end) = resources
            .read(token, result.len() as u64, MAX_CHUNK_BYTES as u32, now)
            .unwrap();
        result.extend(part);
        assert_eq!(end, result.len() == bytes.len());
    }
    assert_eq!(result, bytes);
    assert!(
        resources
            .read(token, 0, MAX_CHUNK_BYTES as u32 + 1, now)
            .is_err()
    );
    assert_eq!(
        resources
            .read(token, 0, 1, now + Duration::from_secs(61))
            .unwrap_err()
            .code(),
        ErrorCode::InvalidToken
    );
    let (token, _) = resources.grant(vec![1], now).unwrap();
    resources.release(token).unwrap();
    assert!(resources.read(token, 0, 1, now).is_err());
    assert!(resources.grant(vec![0; 4 * 1024 * 1024 + 1], now).is_err());
    for _ in 0..8 {
        resources.grant(vec![], now).unwrap();
    }
    assert!(resources.grant(vec![], now).is_err());
}
#[test]
fn diagnostics_restart_budget_minimization_and_clear_preserve_legacy() {
    let directory = Directory::new();
    let legacy = directory.0.join("diagnostics.json");
    std::fs::write(&legacy, b"legacy evidence must survive").unwrap();
    let store = RuntimeState::open(&directory.0).unwrap();
    let mut diagnostics = Diagnostics::load(&store).unwrap();
    diagnostics
        .set_level(&store, DiagnosticLevel::Full)
        .unwrap();
    for _ in 0..1000 {
        diagnostics
            .record(
                &store,
                DiagnosticEvent::new(DiagnosticKind::RequestCompleted, None, 3, 4),
            )
            .unwrap();
    }
    assert_eq!(diagnostics.snapshot().events().len(), EVENT_LIMIT);
    assert_eq!(diagnostics.snapshot().dropped(), 700);
    assert!(diagnostics.export().unwrap().len() < 64 * 1024);
    drop(store);
    let store = RuntimeState::open(&directory.0).unwrap();
    let mut diagnostics = Diagnostics::load(&store).unwrap();
    assert_eq!(diagnostics.snapshot().level(), DiagnosticLevel::Full);
    assert_eq!(diagnostics.snapshot().events().len(), EVENT_LIMIT);
    diagnostics.clear(&store).unwrap();
    assert!(
        Diagnostics::load(&store)
            .unwrap()
            .snapshot()
            .events()
            .is_empty()
    );
    diagnostics.set_level(&store, DiagnosticLevel::Off).unwrap();
    diagnostics
        .record(
            &store,
            DiagnosticEvent::new(
                DiagnosticKind::RequestRejected,
                Some(ErrorCode::Storage),
                0,
                0,
            ),
        )
        .unwrap();
    assert_eq!(diagnostics.snapshot().samples(), 0);
    assert_eq!(
        std::fs::read(legacy).unwrap(),
        b"legacy evidence must survive"
    );
    // Diagnostics accept only enum codes and numbers; content, paths and credentials have no field.
    assert!(serde_json::from_str::<DiagnosticEvent>(r#"{"timestamp_ms":0,"kind":"request_completed","code":null,"elapsed_ms":0,"bytes":0,"detail":"password=secret body text"}"#).is_err());
}
#[test]
fn corrupt_diagnostics_are_preserved_and_write_failure_does_not_publish_settings() {
    let directory = Directory::new();
    let store = RuntimeState::open(&directory.0).unwrap();
    store
        .write("diagnostics.state.v1", b"broken private evidence")
        .unwrap();
    let mut diagnostics = Diagnostics::load(&store).unwrap();
    assert_eq!(diagnostics.snapshot().level(), DiagnosticLevel::Minimal);
    assert_eq!(
        store.read("diagnostics.damaged.v1").unwrap().unwrap(),
        b"broken private evidence"
    );
    let mut tasks = TaskHistory::load(&store).unwrap();
    let task = tasks.start(&store, RecoveryPolicy::ReadOnly).unwrap();
    let journal = directory.0.join("backend.state.sqlite-journal");
    std::fs::create_dir(&journal).unwrap();
    assert_eq!(
        diagnostics
            .set_level(&store, DiagnosticLevel::Full)
            .unwrap_err()
            .code(),
        ErrorCode::Storage
    );
    assert_eq!(diagnostics.snapshot().level(), DiagnosticLevel::Minimal);
    assert!(diagnostics.clear(&store).is_err());
    assert!(
        tasks
            .transition(&store, task.id(), TaskStatus::Completed)
            .is_err()
    );
    assert_eq!(tasks.list()[0].status(), TaskStatus::Running);
    std::fs::remove_dir(journal).unwrap();
    assert_eq!(
        Diagnostics::load(&store).unwrap().snapshot().level(),
        DiagnosticLevel::Minimal
    );
}
#[test]
fn runtime_owner_exclusion_and_unknown_environment() {
    let directory = Directory::new();
    let owner = RuntimeState::open(&directory.0).unwrap();
    assert!(RuntimeState::open(&directory.0).is_err());
    drop(owner);
    assert!(RuntimeState::open(&directory.0).is_ok());
    let mut environment = Environment::default();
    assert_eq!(
        background_decision(&environment),
        ScheduleDecision::WaitingForObservation
    );
    environment.apply(EnvironmentEvent::PowerChanged(Some(false)));
    environment.apply(EnvironmentEvent::NetworkChanged {
        online: Some(true),
        metered: Some(false),
    });
    assert_eq!(background_decision(&environment), ScheduleDecision::Ready);
    environment.apply(EnvironmentEvent::Resumed);
    assert_eq!(
        background_decision(&environment),
        ScheduleDecision::WaitingForObservation
    );
}
