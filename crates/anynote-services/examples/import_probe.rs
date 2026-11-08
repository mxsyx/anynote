use anynote_services::importer::*;
use anynote_storage::notebook::WriteQueue;
use serde_json::{Value, json};
use std::{fs::File, path::Path};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let request: Value =
        serde_json::from_reader(File::open(std::env::args().nth(1).ok_or("request path")?)?)?;
    let root = request["root"].as_str().ok_or("root")?;
    let q = WriteQueue::open(Path::new(root), 2)?;
    let book = if let Some(id) = request["notebookId"].as_str() {
        id.to_owned()
    } else {
        q.submit(|c| c.create_notebook("RM07 interop"))?.wait()?.id
    };
    let target = PreviewTarget {
        notebook_id: book.clone(),
        parent_id: None,
    };
    let mut service = ImportService::new(Path::new(root))?;
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let input = if let Some(path) = request["file"].as_str() {
        ImportInput::File {
            file: File::open(path)?,
            name: path.rsplit('/').next().unwrap().into(),
        }
    } else {
        ImportInput::Html(request["html"].as_str().ok_or("html")?.into())
    };
    let preview = rt.block_on(service.preview(
        target.clone(),
        input,
        ImportOptions {
            page: true,
            keep_original: request["keepOriginal"] == true,
            ..Default::default()
        },
        &CancellationToken::new(),
    ))?;
    let note = service.commit(&q, &target, &preview.id, &CancellationToken::new())?;
    println!(
        "{}",
        json!({"notebookId":book,"note":note,"preview":preview})
    );
    Ok(())
}
