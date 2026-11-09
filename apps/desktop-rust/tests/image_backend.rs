use anynote_core::{backend::*, document_session::*, image::*};
use anynote_desktop::{
    backend_client::{BackendClient, Response},
    image::codec,
};
use std::{io::Cursor, path::PathBuf, sync::atomic::AtomicBool, time::Duration};
use uuid::Uuid;
const WAIT: Duration = Duration::from_secs(15);
struct Fixture {
    path: PathBuf,
    client: BackendClient,
}
impl Fixture {
    fn new() -> Self {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tmp/rm21-backend")
            .join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(&path).unwrap();
        let path = path.canonicalize().unwrap();
        let client = BackendClient::launch(
            PathBuf::from(env!("CARGO_BIN_EXE_anynote-desktop")),
            path.clone(),
        )
        .recv_blocking()
        .unwrap()
        .unwrap();
        Self { path, client }
    }
    fn reply(&self, command: Command) -> Reply {
        let encoded = serde_json::to_vec(&command).unwrap();
        let _: Command = serde_json::from_slice(&encoded)
            .unwrap_or_else(|e| panic!("wire: {e}; {}", String::from_utf8_lossy(&encoded)));
        match self
            .client
            .submit(command, WAIT)
            .unwrap()
            .receive_blocking()
            .unwrap()
        {
            Response::Reply(reply) => reply,
            _ => panic!("reply expected"),
        }
    }
    fn failure(&self, command: Command) -> ErrorCode {
        self.client
            .submit(command, WAIT)
            .unwrap()
            .receive_blocking()
            .err()
            .unwrap()
            .code()
    }
    fn document(&self) -> DocumentSnapshot {
        let Reply::Document(doc) = self.reply(Command::CreateDocument) else {
            panic!()
        };
        doc
    }
    fn upload(&self, doc: &DocumentSnapshot, id: Uuid, bytes: &[u8]) {
        for (ix, part) in bytes.chunks(17).enumerate() {
            assert!(matches!(
                self.reply(Command::Image(ImageCommand::Upload {
                    document: doc.id().clone(),
                    resource: id,
                    name: "image.png".into(),
                    offset: (ix * 17) as u64,
                    bytes: part.to_vec(),
                    complete: (ix * 17) + part.len() == bytes.len()
                })),
                Reply::Image(ImageReply::Uploaded { .. })
            ));
        }
    }
    fn save(&self, doc: &DocumentSnapshot, resource: Uuid, body: String) -> DocumentSnapshot {
        let request = SaveDocument::new(
            Uuid::new_v4(),
            1,
            DocumentSnapshot::new(
                doc.id().clone(),
                doc.revision(),
                doc.head(),
                doc.content().with_body(body),
            ),
        )
        .with_resources(vec![resource]);
        let Reply::DocumentSaved(saved) = self.reply(Command::SaveDocument(request)) else {
            panic!()
        };
        saved.snapshot().clone()
    }
    fn release(&self, doc: &DocumentSnapshot, resource: Uuid) {
        self.reply(Command::Image(ImageCommand::Release {
            document: doc.id().clone(),
            resources: vec![resource],
        }));
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self
            .client
            .submit(Command::Shutdown, WAIT)
            .and_then(|h| h.receive_blocking());
        for _ in 0..100 {
            if self.client.has_exited() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
fn png() -> Vec<u8> {
    let pixels = image::RgbaImage::from_fn(8, 4, |x, y| {
        image::Rgba([(x * 30) as u8, (y * 60) as u8, 127, 255])
    });
    let mut out = Cursor::new(vec![]);
    image::DynamicImage::ImageRgba8(pixels)
        .write_to(&mut out, image::ImageFormat::Png)
        .unwrap();
    out.into_inner()
}
fn scope(doc: &DocumentSnapshot, resource: Uuid) -> ImageScope {
    ImageScope {
        document: doc.id().clone(),
        revision: doc.head(),
        resource,
    }
}
#[test]
fn upload_save_rotate_history_and_hash_bound_annotations_use_real_backend() {
    let f = Fixture::new();
    let original = png();
    let initial = f.document();
    let id = Uuid::new_v4();
    f.upload(&initial, id, &original);
    let body = anynote_editor::image::markdown(&id.to_string(), "图片").unwrap();
    let first = f.save(&initial, id, body.clone());
    f.release(&first, id);
    let hash = first.resources()[&id].clone();
    let s = scope(&first, id);
    let rectangle = ImageRect {
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.4,
    };
    assert!(matches!(
        f.reply(Command::Image(ImageCommand::Annotate {
            scope: s.clone(),
            hash: hash.clone(),
            rectangle,
            body: "原图区域".into()
        })),
        Reply::Image(ImageReply::Ack)
    ));
    let rotated = codec::rotate(&original, 1, &AtomicBool::new(false)).unwrap();
    f.upload(&first, id, &rotated);
    let second = f.save(&first, id, body);
    f.release(&second, id);
    assert_ne!(second.resources()[&id], hash);
    let read = |doc: &DocumentSnapshot, length: usize| {
        let Reply::DocumentResource { bytes } = f.reply(Command::DocumentResource {
            id: doc.id().clone(),
            revision: doc.head(),
            resource: id,
            offset: 0,
            length: length as u32,
        }) else {
            panic!()
        };
        bytes
    };
    assert_eq!(read(&first, original.len()), original);
    assert_eq!(read(&second, rotated.len()), rotated);
    let token = Uuid::new_v4();
    assert!(
        matches!(f.reply(Command::Image(ImageCommand::BeginRead{scope:scope(&first,id),token})),Reply::Image(ImageReply::Info{hash:h,..}) if h==hash)
    );
    let mut streamed = vec![];
    for offset in (0..original.len()).step_by(11) {
        let length = (original.len() - offset).min(11) as u32;
        let Reply::Image(ImageReply::Chunk { bytes }) =
            f.reply(Command::Image(ImageCommand::Read {
                token,
                offset: offset as u64,
                length,
            }))
        else {
            panic!()
        };
        streamed.extend(bytes);
    }
    assert_eq!(streamed, original);
    f.reply(Command::Image(ImageCommand::EndRead { token }));
    assert_eq!(
        f.failure(Command::Image(ImageCommand::Read {
            token,
            offset: 0,
            length: 1
        })),
        ErrorCode::InvalidToken
    );

    let Reply::Image(ImageReply::Annotations { annotations }) =
        f.reply(Command::Image(ImageCommand::Annotations {
            scope: scope(&second, id),
        }))
    else {
        panic!()
    };
    assert_eq!(annotations.len(), 1);
    assert_eq!(annotations[0].hash, hash);
    assert_eq!(annotations[0].rectangles, vec![rectangle]);
    assert_eq!(
        f.failure(Command::Image(ImageCommand::Annotate {
            scope: s,
            hash: hash.clone(),
            rectangle,
            body: "迟到".into()
        })),
        ErrorCode::Conflict
    );
    assert_eq!(
        f.failure(Command::Image(ImageCommand::Annotate {
            scope: scope(&second, id),
            hash,
            rectangle,
            body: "旧 hash".into()
        })),
        ErrorCode::Conflict
    );
    let Reply::Image(ImageReply::Revisions { revisions }) =
        f.reply(Command::Image(ImageCommand::Revisions {
            scope: scope(&second, id),
        }))
    else {
        panic!()
    };
    assert_eq!(revisions.len(), 2);
    assert_eq!(revisions[0].revision, second.head());
    assert_eq!(revisions[1].revision, first.head());
}
#[test]
fn wrong_document_partial_cancel_and_conflict_never_publish_a_resource() {
    let f = Fixture::new();
    let doc = f.document();
    let other = f.document();
    let id = Uuid::new_v4();
    let bytes = png();
    f.reply(Command::Image(ImageCommand::Upload {
        document: doc.id().clone(),
        resource: id,
        name: "partial".into(),
        offset: 0,
        bytes: bytes[..16].to_vec(),
        complete: false,
    }));
    assert_eq!(
        f.failure(Command::Image(ImageCommand::Upload {
            document: other.id().clone(),
            resource: id,
            name: "partial".into(),
            offset: 16,
            bytes: bytes[16..].to_vec(),
            complete: true
        })),
        ErrorCode::InvalidRequest
    );
    f.release(&doc, id);
    let save = SaveDocument::new(
        Uuid::new_v4(),
        1,
        DocumentSnapshot::new(
            doc.id().clone(),
            doc.revision(),
            doc.head(),
            doc.content()
                .with_body(anynote_editor::image::markdown(&id.to_string(), "").unwrap()),
        ),
    )
    .with_resources(vec![id]);
    assert_eq!(
        f.failure(Command::SaveDocument(save.clone())),
        ErrorCode::InvalidRequest
    );
    f.upload(&doc, id, &bytes);
    let Reply::DocumentSaved(_) = f.reply(Command::SaveDocument(SaveDocument::new(
        Uuid::new_v4(),
        1,
        DocumentSnapshot::new(
            doc.id().clone(),
            doc.revision(),
            doc.head(),
            doc.content().with_body("concurrent edit".into()),
        ),
    ))) else {
        panic!()
    };
    assert_eq!(f.failure(Command::SaveDocument(save)), ErrorCode::Conflict);
    assert_eq!(
        f.failure(Command::Image(ImageCommand::Info {
            scope: scope(&doc, id)
        })),
        ErrorCode::NotFound
    );
    f.release(&doc, id);
}
