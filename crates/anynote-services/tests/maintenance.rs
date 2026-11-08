use anynote_services::cloud::*;
use anynote_storage::runtime_state::RuntimeState;
use serde_json::json;
use tokio_util::sync::CancellationToken;
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn temp() -> tempfile::TempDir {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm11");
    std::fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root.canonicalize().unwrap()).unwrap()
}
#[test]
fn retention_preferences_are_local_target_scoped_validated_and_durable() {
    let root = temp();
    let store = RuntimeState::open(root.path()).unwrap();
    let target = id();
    let policy = RetentionPolicy {
        keep: 1,
        calendar: CalendarRetention {
            daily_days: 365,
            weekly_weeks: 104,
            monthly_months: 120,
        },
    };
    save_remote_retention(&store, &target, &policy).unwrap();
    assert_eq!(
        remote_retention_policy(&store, &id()).unwrap(),
        RetentionPolicy::default()
    );
    for bad in [
        RetentionPolicy {
            keep: 0,
            ..policy.clone()
        },
        RetentionPolicy {
            keep: 1001,
            ..policy.clone()
        },
        RetentionPolicy {
            calendar: CalendarRetention {
                daily_days: 366,
                ..Default::default()
            },
            ..policy.clone()
        },
        RetentionPolicy {
            calendar: CalendarRetention {
                weekly_weeks: 105,
                ..Default::default()
            },
            ..policy.clone()
        },
        RetentionPolicy {
            calendar: CalendarRetention {
                monthly_months: 121,
                ..Default::default()
            },
            ..policy.clone()
        },
    ] {
        assert!(save_remote_retention(&store, &target, &bad).is_err());
    }
    assert!(save_remote_retention(&store, "../wrong", &policy).is_err());
    assert!(serde_json::from_value::<RetentionPolicy>(json!({"keep":1,"calendar":{"dailyDays":1,"weeklyWeeks":0,"monthlyMonths":0,"automatic":true}})).is_err());
    drop(store);
    let store = RuntimeState::open(root.path()).unwrap();
    assert_eq!(remote_retention_policy(&store, &target).unwrap(), policy);
    assert!(
        store
            .read(&format!("cloud.retention.{target}"))
            .unwrap()
            .is_some()
    );
}
#[tokio::test]
async fn destructive_requests_require_confirmation_and_a_preview_before_network() {
    let root = temp();
    let connection = RecoveryConnection {
        id: id(),
        name: "offline".into(),
        endpoint: "http://127.0.0.1:1".into(),
        allow_insecure: true,
    };
    let client = CloudClient::new(connection.clone(), "synthetic").unwrap();
    let identity = TransferIdentity {
        connection_id: connection.id,
        endpoint: connection.endpoint,
        notebook_id: id(),
        lineage_id: id(),
        direction: Direction::Upload,
        writer: Some(WriterIdentity {
            device_id: id(),
            epoch: 1,
        }),
    };
    let mut session = TransferSession::open(root.path(), identity.clone()).unwrap();
    let cancel = CancellationToken::new();
    assert_eq!(
        resume_takeover(&client, &mut session, &cancel)
            .await
            .unwrap_err()
            .code,
        "TAKEOVER_NOT_CONFIRMED"
    );
    let request = TakeoverRequest {
        request_id: id(),
        expected_head: String::new(),
        expected_writer_epoch: 1,
    };
    assert_eq!(
        takeover_writer(&client, &mut session, &request, false, &cancel)
            .await
            .unwrap_err()
            .code,
        "CONFIRMATION_REQUIRED"
    );
    assert_eq!(
        apply_retention(&client, &mut session, &id(), false, &cancel)
            .await
            .unwrap_err()
            .code,
        "CONFIRMATION_REQUIRED"
    );
    assert_eq!(
        apply_retention(&client, &mut session, &id(), true, &cancel)
            .await
            .unwrap_err()
            .code,
        "PLAN_NOT_PREVIEWED"
    );
    assert_eq!(
        resume_retention(&client, &mut session, &cancel)
            .await
            .unwrap_err()
            .code,
        "PLAN_NOT_CONFIRMED"
    );
    assert_eq!(
        recover_retention(&client, &mut session, &id(), false, &cancel)
            .await
            .unwrap_err()
            .code,
        "CONFIRMATION_REQUIRED"
    );
    assert_eq!(
        release_legacy_maintenance_lock(&client, &session, &id(), &id(), false, &cancel)
            .await
            .unwrap_err()
            .code,
        "CONFIRMATION_REQUIRED"
    );
    let writer = RemoteWriter {
        head: String::new(),
        device_id: identity.writer.as_ref().unwrap().device_id.clone(),
        writer_epoch: 1,
        lineage_id: identity.lineage_id.clone(),
    };
    assert!(writer.owns(&identity));
    assert!(
        !RemoteWriter {
            writer_epoch: 2,
            ..writer
        }
        .owns(&identity)
    );
    let invalid = TakeoverRequest {
        expected_writer_epoch: JS_SAFE,
        ..request
    };
    assert_eq!(
        takeover_writer(&client, &mut session, &invalid, true, &cancel)
            .await
            .unwrap_err()
            .code,
        "TAKEOVER_REQUEST"
    );
}
