//! RM08 isolated interoperability driver. Paths are supplied by the synthetic harness.
use anynote_services::{archive::*, open_export::*};
use anynote_storage::notebook::*;
use serde_json::{Value, json};
use std::path::Path;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let input: Value =
        serde_json::from_slice(&std::fs::read(std::env::args().nth(1).ok_or("input")?)?)?;
    let cancel = Cancellation::default();
    let root = Path::new(input["root"].as_str().ok_or("root")?);
    let operation = input["operation"].as_str().ok_or("operation")?;
    let result: ArchiveResult<Value> = (|| {
        if operation == "import" {
            return Ok(serde_json::to_value(import_archive(
                Path::new(input["file"].as_str().unwrap()),
                root,
                &cancel,
            )?)?);
        }
        if operation == "validate" {
            let a = validate_archive(Path::new(input["file"].as_str().unwrap()), root, &cancel)?;
            return Ok(serde_json::to_value(a.manifest)?);
        }
        let id = input["id"].as_str().unwrap().to_owned();
        let q = WriteQueue::open(root, 2)?;
        let temp = root.to_owned();
        let mut frozen = q
            .submit(move |s| s.capture_snapshot(&id, &temp, &Cancellation::default()))?
            .wait()?;
        let output = Path::new(input["file"].as_str().unwrap());
        if operation == "markdown" {
            export_markdown(
                &mut frozen,
                output,
                if input["directory"] == true {
                    OpenExportFormat::Directory
                } else {
                    OpenExportFormat::Zip
                },
                &cancel,
            )?;
            Ok(json!({"ok":true}))
        } else {
            let mode = if input["current"] == true {
                SnapshotMode::Current
            } else {
                SnapshotMode::Full
            };
            Ok(serde_json::to_value(export_archive(
                &mut frozen,
                mode,
                output,
                input["zip64"] == true,
                &cancel,
            )?)?)
        }
    })();
    println!(
        "{}",
        match result {
            Ok(v) => json!({"ok":v}),
            Err(e) => json!({"error":e.to_string()}),
        }
    );
    Ok(())
}
