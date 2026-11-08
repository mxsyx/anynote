//! RM11 isolated protocol driver. Never loads real user paths or credentials.
use anynote_services::cloud::*;
use anynote_storage::runtime_state::RuntimeState;
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
            Err(e) => json!({"error":e.code,"status":e.status}),
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
    let root = Path::new(string("root")?);
    std::fs::create_dir_all(root)?;
    let op = string("operation")?;
    if op == "save-policy" || op == "policy" {
        let store = RuntimeState::open(&root.join("runtime"))?;
        let target = string("target")?;
        if op == "save-policy" {
            save_remote_retention(
                &store,
                target,
                &serde_json::from_value(input["policy"].clone())?,
            )?;
        }
        return Ok(serde_json::to_value(remote_retention_policy(
            &store, target,
        )?)?);
    }
    let client = CloudClient::new(
        serde_json::from_value(input["connection"].clone())?,
        &std::env::var("ANYNOTE_TEST_CLOUD_TOKEN").map_err(|_| CloudError::new("TOKEN"))?,
    )?;
    let mut session =
        TransferSession::open(root, serde_json::from_value(input["identity"].clone())?)?;
    let cancel = CancellationToken::new();
    if let Some(ms) = input["cancelAfterMs"].as_u64() {
        let c = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
            c.cancel();
        });
    }
    let confirmed = input["confirmed"].as_bool().unwrap_or(false);
    Ok(match op {
        "takeover-resume" => {
            serde_json::to_value(resume_takeover(&client, &mut session, &cancel).await?)?
        }
        "takeover-pending" => serde_json::to_value(pending_takeover(&session)?)?,
        "writer" => serde_json::to_value(remote_writer(&client, &session, &cancel).await?)?,
        "takeover" => serde_json::to_value(
            takeover_writer(
                &client,
                &mut session,
                &serde_json::from_value(input["request"].clone())?,
                confirmed,
                &cancel,
            )
            .await?,
        )?,
        "preview" => serde_json::to_value(
            preview_retention(
                &client,
                &mut session,
                &serde_json::from_value(input["policy"].clone())?,
                &cancel,
            )
            .await?,
        )?,
        "apply" => serde_json::to_value(
            apply_retention(&client, &mut session, string("plan")?, confirmed, &cancel).await?,
        )?,
        "resume" => serde_json::to_value(resume_retention(&client, &mut session, &cancel).await?)?,
        "recover" => serde_json::to_value(
            recover_retention(&client, &mut session, string("plan")?, confirmed, &cancel).await?,
        )?,
        "state" => serde_json::to_value(remote_retention_state(&client, &session, &cancel).await?)?,
        "pending" => serde_json::to_value(pending_retention(&session)?)?,
        "diagnostics" => {
            serde_json::to_value(maintenance_diagnostics(&client, &session, &cancel).await?)?
        }
        "release" => {
            release_legacy_maintenance_lock(
                &client,
                &session,
                string("plan")?,
                string("execution")?,
                confirmed,
                &cancel,
            )
            .await?;
            json!({"released":true})
        }
        "upload" => serde_json::to_value(resume_upload(&client, &mut session, &cancel).await?)?,
        _ => return Err(CloudError::new("PROBE_OPERATION")),
    })
}
