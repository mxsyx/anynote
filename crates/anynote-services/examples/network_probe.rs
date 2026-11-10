//! Runs the shipped downloader and business services without replacing transport.
use anynote_core::{builtin::*, document_session::*, video::VideoCard};
use anynote_services::{
    builtin,
    importer::*,
    network::{self, NetworkEvent},
    video,
};
use anynote_storage::notebook::*;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    io,
    sync::{Arc, Mutex},
    time::Instant,
};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    kind: String,
    url: String,
    max_bytes: u64,
    response_ms: u64,
    #[serde(default)]
    cancel_after_response: bool,
}

async fn run(request: &Request, cancel: &CancellationToken) -> Value {
    if request.kind == "download" {
        let mut bytes = Vec::new();
        return match network::download(
            &request.url,
            request.max_bytes,
            request.response_ms,
            cancel,
            &mut bytes,
        )
        .await
        {
            Ok(result) => {
                json!({"ok":true,"body":String::from_utf8_lossy(&bytes),"bytes":result.size,"finalUrl":result.url})
            }
            Err(error) => {
                json!({"ok":false,"error":error.message,"cancelled":error.cancelled,"writtenBytes":bytes.len()})
            }
        };
    }
    if request.kind == "video" {
        let Some(card) = VideoCard::parse(&request.url) else {
            return json!({"ok":false,"error":"invalid video URL"});
        };
        return match video::fetch(&card, cancel).await {
            Ok(metadata) => {
                json!({"ok":true,"title":metadata.title(),"thumbnailBytes":metadata.thumbnail().map(|b| b.len())})
            }
            Err(error) => json!({"ok":false,"error":format!("{error:?}")}),
        };
    }
    let staging = std::path::Path::new("tmp/rm35");
    std::fs::create_dir_all(staging).unwrap();
    let root = tempfile::tempdir_in(staging.canonicalize().unwrap()).unwrap();
    let queue = WriteQueue::open(root.path(), 2).unwrap();
    let book = queue
        .submit(|c| c.create_notebook("RM35 synthetic data"))
        .unwrap()
        .wait()
        .unwrap()
        .id;
    if request.kind == "web" {
        let mut service = ImportService::new(root.path()).unwrap();
        let target = PreviewTarget {
            notebook_id: book.clone(),
            parent_id: None,
        };
        let options = ImportOptions {
            page: true,
            budget: ImportBudget {
                html_bytes: request.max_bytes,
                response_bytes: request.max_bytes,
                response_ms: request.response_ms,
                ..Default::default()
            },
            ..Default::default()
        };
        let result = match service
            .preview(
                target.clone(),
                ImportInput::Url(request.url.clone()),
                options,
                cancel,
            )
            .await
        {
            Ok(preview) => service.commit(&queue, &target, &preview.id, cancel),
            Err(error) => Err(error),
        };
        let nodes = queue
            .submit(move |c| c.notebook(&book)?.read().nodes())
            .unwrap()
            .wait()
            .unwrap();
        return match result {
            Ok(note) => {
                json!({"ok":true,"body":note.body,"revision":note.node.revision,"nodes":nodes.len()})
            }
            Err(error) => {
                json!({"ok":false,"error":error.message,"cancelled":error.cancelled,"nodes":nodes.len()})
            }
        };
    }
    assert_eq!(request.kind, "text");
    let b = book.clone();
    let note = queue
        .submit(move |c| {
            c.notebook(&b)?
                .create_node(&CreateNode::note("RM35", "private-note-canary"), &[])
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = DocumentSnapshot::new(
        DocumentId::new(
            Uuid::parse_str(&book).unwrap(),
            Uuid::parse_str(&note.node.id).unwrap(),
        ),
        note.node.revision,
        Uuid::parse_str(note.head_revision_id.as_ref().unwrap()).unwrap(),
        DocumentContent::new(
            note.node.title.clone(),
            note.body.clone(),
            note.node.tags.clone(),
            false,
        ),
    );
    let result = builtin::execute(
        &queue,
        ReadingRequest::new(
            Uuid::new_v4(),
            snapshot,
            ReadingCommand::PublicText {
                url: request.url.clone(),
            },
        ),
        cancel,
    )
    .await;
    let id = note.node.id.clone();
    let after = queue
        .submit(move |c| c.notebook(&book)?.read().note(&id))
        .unwrap()
        .wait()
        .unwrap();
    json!({"ok":result.is_ok(),"error":result.err().map(|e| format!("{e:?}")),"before":{"body":note.body,"revision":note.node.revision},"after":{"body":after.body,"revision":after.node.revision}})
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let request: Request = serde_json::from_reader(io::stdin())?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let events = Arc::new(Mutex::new(Vec::new()));
    let record = events.clone();
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let abort = request.cancel_after_response;
    let observer = Arc::new(move |event: NetworkEvent| {
        if abort && matches!(event, NetworkEvent::Response { .. }) {
            trigger.cancel();
        }
        record.lock().unwrap().push(event);
    });
    let start = Instant::now();
    let outcome = runtime.block_on(network::observe(observer, run(&request, &cancel)));
    println!(
        "{}",
        json!({"outcome":outcome,"elapsedMs":start.elapsed().as_millis(),"events":*events.lock().unwrap(),"device":{"os":std::env::consts::OS,"arch":std::env::consts::ARCH},"version":env!("CARGO_PKG_VERSION")})
    );
    Ok(())
}
