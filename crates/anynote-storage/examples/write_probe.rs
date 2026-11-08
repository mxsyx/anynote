//! Offline interoperability driver. All inputs must point at isolated synthetic workspaces.
use anynote_storage::notebook::*;
use serde_json::{Value, json};
use std::{io::Write, path::Path};
fn required<'a>(v: &'a Value, key: &str) -> ReadResult<&'a str> {
    v[key].as_str().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, format!("missing {key}")).into()
    })
}
fn operation(store: &mut WriteCatalog, p: Value) -> ReadResult<Value> {
    let op = required(&p, "op")?;
    if op == "createNotebook" {
        return Ok(serde_json::to_value(
            store.create_notebook(required(&p, "title")?)?,
        )?);
    }
    if op == "renameNotebook" {
        return Ok(serde_json::to_value(store.rename_notebook(
            required(&p, "notebookId")?,
            required(&p, "title")?,
            p["icon"].as_str(),
            p["coverColor"].as_str(),
        )?)?);
    }
    let book = store.notebook(required(&p, "notebookId")?)?;
    let id = p["id"].as_str().unwrap_or("");
    let expected = p["expectedRevision"].as_i64().unwrap_or(0);
    let resources = p["resources"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|r| {
                    ResourceWrite::bytes(
                        required(r, "id")?.into(),
                        required(r, "name")?.into(),
                        required(r, "mime")?.into(),
                        serde_json::from_value(r["bytes"].clone())?,
                    )
                })
                .collect::<ReadResult<Vec<_>>>()
        })
        .transpose()?
        .unwrap_or_default();
    match op {
        "hold" => {
            println!("READY");
            std::io::stdout().flush()?;
            loop {
                std::thread::park();
            }
        }
        "createNode" => Ok(serde_json::to_value(book.create_node(
            &serde_json::from_value(p["request"].clone())?,
            &resources,
        )?)?),
        "saveNote" => Ok(serde_json::to_value(book.save_note(
            id,
            expected,
            &serde_json::from_value(p["patch"].clone())?,
            &resources,
        )?)?),
        "restoreRevision" => Ok(serde_json::to_value(book.restore_revision(
            id,
            expected,
            required(&p, "revisionId")?,
        )?)?),
        "moveNode" => Ok(serde_json::to_value(
            book.move_node(id, p["parentId"].as_str())?,
        )?),
        "placeNode" => Ok(serde_json::to_value(book.place_node(
            id,
            expected,
            p["parentId"].as_str(),
            p["beforeId"].as_str(),
        )?)?),
        "trashNode" => Ok(json!(book.trash_node(id)?)),
        "restoreNode" => Ok(json!(book.restore_node(id)?)),
        "setExtensionSetting" => Ok(json!(book.set_core_setting(
            required(&p, "extensionId")?,
            required(&p, "key")?,
            p["enabled"].as_bool().unwrap_or(false)
        )?)),
        "proposePatch" => Ok(serde_json::to_value(book.propose(
            id,
            expected,
            required(&p, "body")?,
            p["reason"].as_str(),
        )?)?),
        "applyProposal" => Ok(serde_json::to_value(
            book.apply_proposal(id, required(&p, "proposalId")?)?,
        )?),
        "undoProposal" => Ok(serde_json::to_value(
            book.undo_proposal(id, required(&p, "proposalId")?)?,
        )?),
        "addAnnotation" => Ok(
            json!({"id":book.add_annotation(id,&serde_json::from_value(p["annotation"].clone())?)?}),
        ),
        "deleteAnnotation" => Ok(json!(book.delete_annotation(id)?)),
        "reanchorAnnotation" => book.reanchor_annotations(id, required(&p, "assetHash")?),
        "snapshot" => {
            let view = book.read();
            let nodes = view.nodes()?;
            let notes=nodes.iter().map(|n|Ok(json!({"note":view.note(&n.id)?,"history":view.history(&n.id)?,"annotations":view.annotations(&n.id,true)?}))).collect::<ReadResult<Vec<_>>>()?;
            Ok(
                json!({"meta":view.metadata(),"notes":notes,"extensionRecords":view.extension_records()?,"revisionResources":view.revision_resources()?}),
            )
        }
        _ => Err(
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "unknown probe operation").into(),
        ),
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let input: Value = serde_json::from_slice(&std::fs::read(
        std::env::args().nth(1).ok_or("input file required")?,
    )?)?;
    let queue = WriteQueue::open(Path::new(required(&input, "root")?), 2)?;
    let operations = input["operations"]
        .as_array()
        .ok_or("operations required")?
        .clone();
    let results = queue
        .submit(move |store| {
            Ok(operations
                .into_iter()
                .map(|p| match operation(store, p) {
                    Ok(v) => json!({"ok":v}),
                    Err(e) => json!({"error":e.kind(),"message":e.message()}),
                })
                .collect::<Vec<_>>())
        })?
        .wait()?;
    drop(queue);
    println!("{}", json!({"results":results}));
    Ok(())
}
