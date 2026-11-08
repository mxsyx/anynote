//! Offline compatibility harness; never starts the UI or mutates notebook files.
use anynote_storage::notebook::{ReadonlyCatalog, SearchRequest};
use serde_json::{Value, json};
use std::{
    io::Read,
    path::Path,
    sync::{Arc, atomic::AtomicBool},
};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    if let Some(path) = std::env::args().nth(1) {
        input = std::fs::read_to_string(path)?;
    } else {
        std::io::stdin().read_to_string(&mut input)?;
    }
    let input: Value = serde_json::from_str(&input)?;
    let root = input["root"].as_str().ok_or("root required")?;
    let mut catalog = ReadonlyCatalog::open(Path::new(root), 2)?;
    let mut output = Vec::new();
    for operation in input["operations"]
        .as_array()
        .ok_or("operations required")?
    {
        let id = operation["notebookId"].as_str().unwrap_or("");
        let note = operation["id"].as_str().unwrap_or("");
        let result = match operation["op"].as_str().ok_or("op required")? {
            "searchWorkspace" => serde_json::to_value(catalog.search(
                &serde_json::from_value::<SearchRequest>(operation["input"].clone())?,
                Arc::new(AtomicBool::new(false)),
            )?)?,
            "getBacklinks" => serde_json::to_value(catalog.backlinks(id, note)?)?,
            "getNote" => serde_json::to_value(catalog.read(id)?.note(note)?)?,
            "listNodes" => serde_json::to_value(catalog.read(id)?.nodes()?)?,
            "history" => serde_json::to_value(catalog.read(id)?.history(note)?)?,
            "listAnnotations" => serde_json::to_value(catalog.read(id)?.annotations(note, false)?)?,
            "extensionRecords" => serde_json::to_value(catalog.read(id)?.extension_records()?)?,
            "diagnose" => serde_json::to_value(catalog.diagnose())?,
            _ => return Err("unsupported probe operation".into()),
        };
        output.push(result);
    }
    println!(
        "{}",
        json!({"results":output,"connections":catalog.connection_count()})
    );
    Ok(())
}
