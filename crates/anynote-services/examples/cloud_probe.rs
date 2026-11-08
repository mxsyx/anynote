//! Isolated RM10 protocol driver. Synthetic paths and endpoint supplied by the harness.
use anynote_services::cloud::*;
use anynote_storage::notebook::*;
use serde_json::{Value, json};
use std::path::Path;
use tokio_util::sync::CancellationToken;
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let input: Value =
        serde_json::from_slice(&std::fs::read(std::env::args().nth(1).ok_or("input")?)?)?;
    let result = run(input).await;
    println!(
        "{}",
        match result {
            Ok(v) => json!({"ok":v}),
            Err(e) => json!({"error":e.code,"status":e.status,"retryAfterMs":e.retry_after_ms}),
        }
    );
    Ok(())
}
async fn run(input: Value) -> CloudResult<Value> {
    let string = |key: &str| {
        input[key]
            .as_str()
            .ok_or_else(|| CloudError::new("PROBE_INPUT"))
    };
    let op = string("operation")?;
    if op == "stringify" {
        return Ok(json!(stringify(&input["value"])?));
    }
    if op == "manifest" {
        let m = Manifest::parse(string("bytes")?.as_bytes())?;
        return Ok(json!({"bytes":String::from_utf8_lossy(m.bytes()),"hash":m.hash()}));
    }
    let root = Path::new(string("root")?);
    std::fs::create_dir_all(root)?;
    let connection: RecoveryConnection = serde_json::from_value(input["connection"].clone())?;
    let client = CloudClient::new(
        connection,
        &std::env::var("ANYNOTE_TEST_CLOUD_TOKEN").map_err(|_| CloudError::new("TOKEN"))?,
    )?;
    let cancel = CancellationToken::new();
    if let Some(ms) = input["cancelAfterMs"].as_u64() {
        let c = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
            c.cancel();
        });
    }
    if op == "test" {
        return Ok(json!({"capabilities":client.test(&cancel).await?.capabilities}));
    }
    if op == "discover" {
        return Ok(serde_json::to_value(
            client.discover(input["cursor"].as_str(), &cancel).await?,
        )?);
    }
    let identity: TransferIdentity = serde_json::from_value(input["identity"].clone())?;
    let mut session = TransferSession::open(root, identity)?;
    if op == "pair" {
        return Ok(serde_json::to_value(
            client
                .pair_capture_device(
                    &session.identity().notebook_id,
                    &session.identity().lineage_id,
                    &cancel,
                )
                .await?,
        )?);
    }
    if op == "devices" {
        return Ok(serde_json::to_value(
            client.capture_devices(&cancel).await?,
        )?);
    }
    if op == "revoke" {
        client
            .revoke_capture_device(string("device")?, &cancel)
            .await?;
        return Ok(json!(true));
    }
    if op == "consume" {
        let queue = WriteQueue::open(Path::new(string("dataRoot")?), 2)?;
        return Ok(json!(
            consume_captures(
                &client,
                &session,
                &queue,
                string("notebook")?,
                root,
                &cancel
            )
            .await?
        ));
    }
    if op == "cursor" {
        return Ok(serde_json::to_value(session.cursor()?)?);
    }
    if op == "prepare-manifest" {
        let m = Manifest::parse(string("bytes")?.as_bytes())?;
        prepare_manifest(
            &mut session,
            &m,
            Path::new(string("objects")?),
            &Cancellation::default(),
        )?;
        return Ok(json!({"generationId":m.data().generation_id}));
    }
    if op == "prepare" {
        let pending = client
            .pending_capture_acks(
                &session.identity().notebook_id,
                &session.identity().lineage_id,
                &cancel,
            )
            .await?;
        let notebook = string("notebook")?.to_owned();
        let data_root = Path::new(string("dataRoot")?).to_owned();
        let queue = WriteQueue::open(&data_root, 2)?;
        let temp = data_root.clone();
        let mut frozen = queue
            .submit(move |s| s.capture_snapshot(&notebook, &temp, &Cancellation::default()))?
            .wait()?;
        let manifest = prepare_upload_with_captures(
            &mut session,
            &mut frozen,
            input["head"].as_str().unwrap_or(""),
            "2026-11-08T12:00:00.000Z",
            &pending,
            &Cancellation::default(),
        )?;
        return Ok(
            json!({"generationId":manifest.data().generation_id,"bytes":String::from_utf8_lossy(manifest.bytes())}),
        );
    }
    if op == "schedule-resume" {
        use anynote_core::environment::{Environment, EnvironmentEvent};
        use anynote_services::scheduler::*;
        let state = anynote_storage::runtime_state::RuntimeState::open(&root.join("scheduler"))?;
        let mut scheduler = BackupScheduler::load(&state)?;
        let id = session.identity().connection_id.clone();
        if scheduler.state(&id).is_none() {
            scheduler.configure(
                &state,
                ScheduledTarget {
                    id: id.clone(),
                    binding: serde_json::to_string(session.identity())?,
                    kind: BackupKind::Remote,
                    enabled: true,
                    interval_ms: 60000,
                    on_mount: false,
                    last_task_bytes: 0,
                },
            )?;
        }
        let mut env = Environment::default();
        env.apply(EnvironmentEvent::NetworkChanged {
            online: Some(true),
            metered: Some(false),
        });
        let mut owned = Some(session);
        let ran = scheduler
            .tick(
                &state,
                &env,
                0,
                |_| Availability {
                    notebook: true,
                    disk: true,
                },
                &cancel,
                |_, cancel| {
                    let mut session = owned.take().unwrap();
                    let client = client.clone();
                    async move {
                        resume_upload(&client, &mut session, &cancel)
                            .await
                            .map(|_| 0)
                    }
                },
            )
            .await?;
        return Ok(json!({"ran":ran,"state":scheduler.state(&id)}));
    }
    if op == "resume" {
        return Ok(serde_json::to_value(
            resume_upload(&client, &mut session, &cancel).await?,
        )?);
    }
    if op == "abandon" {
        return Ok(serde_json::to_value(
            abandon_upload(&client, &mut session, &cancel).await?,
        )?);
    }
    if op == "restore" {
        return Ok(serde_json::to_value(
            restore(
                &client,
                &mut session,
                string("generation")?,
                Path::new(string("destination")?),
                &cancel,
            )
            .await?,
        )?);
    }
    Err(CloudError::new("PROBE_OPERATION"))
}
