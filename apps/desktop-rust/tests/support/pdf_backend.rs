use anynote_core::{asset::AssetScope, backend::*, document_session::DocumentId};
use anynote_desktop::backend_client::{BackendClient, Response};
use anynote_storage::notebook::*;
use std::{path::PathBuf, time::Duration};
use uuid::Uuid;
pub struct PdfBackend {
    pub root: PathBuf,
    pub client: BackendClient,
    pub scope: AssetScope,
}
impl PdfBackend {
    pub fn new(name: &str) -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tmp/rm25/backend")
            .join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(root.join("workspace")).unwrap();
        let root = root.canonicalize().unwrap();
        let queue = WriteQueue::open(&root.join("workspace"), 8).unwrap();
        let bytes = std::fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../tests/fixtures/pdf")
                .join(name),
        )
        .unwrap();
        let scope = queue
            .submit(move |catalog| {
                let book = catalog.create_notebook("PDF fixtures")?.id;
                let resource = Uuid::new_v4();
                let mut request = CreateNode::note("PDF fixture", "");
                request.note_type = Some(NoteType::Pdf);
                request.primary_resource_id = Some(resource.to_string());
                let node = catalog.notebook(&book)?.create_node(
                    &request,
                    &[ResourceWrite::bytes(
                        resource.to_string(),
                        "test.pdf".into(),
                        "application/pdf".into(),
                        bytes,
                    )?],
                )?;
                Ok(AssetScope::new(
                    DocumentId::new(
                        Uuid::parse_str(&book).unwrap(),
                        Uuid::parse_str(&node.node.id).unwrap(),
                    ),
                    Uuid::parse_str(node.head_revision_id.as_ref().unwrap()).unwrap(),
                    resource,
                ))
            })
            .unwrap()
            .wait()
            .unwrap();
        drop(queue);
        let client = BackendClient::launch(
            option_env!("CARGO_BIN_EXE_anynote-desktop")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    std::env::current_exe()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .join(if cfg!(windows) {
                            "anynote-desktop.exe"
                        } else {
                            "anynote-desktop"
                        })
                }),
            root.clone(),
        )
        .recv_blocking()
        .unwrap()
        .unwrap();
        Self {
            root,
            client,
            scope,
        }
    }
    pub fn reply(&self, command: Command) -> Reply {
        match self
            .client
            .submit(command, Duration::from_secs(15))
            .unwrap()
            .receive_blocking()
            .unwrap()
        {
            Response::Reply(reply) => reply,
            _ => panic!("expected reply"),
        }
    }
}
impl Drop for PdfBackend {
    fn drop(&mut self) {
        let _ = self
            .client
            .submit(Command::Shutdown, Duration::from_secs(5))
            .and_then(|h| h.receive_blocking());
        for _ in 0..100 {
            if self.client.has_exited() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
