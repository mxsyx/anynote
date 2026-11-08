//! Isolated RM06 interoperability and process interruption driver.
use anynote_services::transfer::*;
use anynote_storage::notebook::*;
use serde_json::{Value, json};
use std::{io::Write, path::Path};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let file = std::env::args().nth(1).ok_or("missing input")?;
    let input: Value = serde_json::from_slice(&std::fs::read(file)?)?;
    let request: TransferRequest = serde_json::from_value(input["request"].clone())?;
    let queue = WriteQueue::open(Path::new(input["root"].as_str().ok_or("root")?), 1)?;
    let phase = input["phase"].as_str().unwrap_or("complete");
    let result = if phase == "copy" || phase == "crash-after-copy" {
        let result = queue
            .submit(move |catalog| {
                catalog.with_pair(
                    &request.notebook_id,
                    &request.target_notebook_id,
                    |source, target| Ok(target.copy_transfer(source, &request)?.result()),
                )
            })?
            .wait();
        if phase == "crash-after-copy" && result.is_ok() {
            println!("READY");
            std::io::stdout().flush()?;
            loop {
                std::thread::park();
            }
        }
        result
    } else {
        transfer_node(&queue, request)?.wait()
    };
    println!(
        "{}",
        match result {
            Ok(value) => json!({"ok":value}),
            Err(error) => json!({"error":error.to_string(),"kind":error.kind()}),
        }
    );
    Ok(())
}
