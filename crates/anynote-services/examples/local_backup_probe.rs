//! Synthetic RM09 interoperability and process-exit driver.
use anynote_services::local_backup::*;
use anynote_storage::notebook::*;
use serde_json::{Value, json};
use std::path::Path;
struct ExitAt(String);
impl Observer for ExitAt {
    fn checkpoint(&mut self, point: Checkpoint) -> Result<()> {
        if self.0 == format!("{point:?}") {
            std::process::exit(73);
        }
        Ok(())
    }
}
fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let input: Value =
        serde_json::from_slice(&std::fs::read(std::env::args().nth(1).ok_or("input")?)?)?;
    let root = Path::new(input["root"].as_str().ok_or("root")?);
    let disk = Path::new(input["disk"].as_str().ok_or("disk")?);
    let temp = Path::new(input["temporary"].as_str().ok_or("temporary")?);
    let id = input["id"].as_str().ok_or("id")?;
    let result: Result<Value> = (|| {
        let target = initialize_target(disk, &[root.to_owned()], &NativeVolumes)?;
        let cancel = Cancellation::default();
        let mut service = LocalBackupService::default();
        match input["operation"].as_str().unwrap_or("backup") {
            "verify" => Ok(serde_json::to_value(service.verify(
                &target,
                id,
                temp,
                &cancel,
                &NativeVolumes,
            )?)?),
            "restore" => Ok(serde_json::to_value(service.restore(
                &target,
                id,
                Path::new(input["destination"].as_str().unwrap()),
                &cancel,
                &NativeVolumes,
            )?)?),
            _ => {
                let queue = WriteQueue::open(root, 2)?;
                let mut observer = ExitAt(input["exitAt"].as_str().unwrap_or("").into());
                Ok(serde_json::to_value(service.backup_observed(
                    &target,
                    &queue,
                    id,
                    temp,
                    &cancel,
                    &NativeVolumes,
                    &mut observer,
                )?)?)
            }
        }
    })();
    println!(
        "{}",
        match result {
            Ok(v) => json!({"ok": v}),
            Err(e) => json!({"error": e.to_string(), "code": e.code}),
        }
    );
    Ok(())
}
