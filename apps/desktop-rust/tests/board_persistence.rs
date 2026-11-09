use anynote_core::{backend::*, board::*, document_session::*, image::*};
use anynote_desktop::{
    backend_client::{BackendClient, Response},
    board::preview,
};
use anynote_editor::board::{Board, Command as Edit, EditStamp, Point, Scene};
use anynote_services::{archive::*, open_export::*, transfer::*};
use anynote_storage::notebook::*;
use serde_json::{Value, json};
use std::{fs, path::PathBuf, time::Duration};
use uuid::Uuid;
const WAIT: Duration = Duration::from_secs(20);
struct Fixture {
    root: PathBuf,
    client: BackendClient,
}
impl Fixture {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tmp/rm24-persistence")
            .join(Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let client = BackendClient::launch(
            PathBuf::from(env!("CARGO_BIN_EXE_anynote-desktop")),
            root.clone(),
        )
        .recv_blocking()
        .unwrap()
        .unwrap();
        Self { root, client }
    }
    fn call(&self, command: Command) -> ServiceResult<Reply> {
        match self.client.submit(command, WAIT)?.receive_blocking()? {
            Response::Reply(reply) => Ok(reply),
            _ => panic!(),
        }
    }
    fn doc(&self, command: Command) -> DocumentSnapshot {
        match self.call(command).unwrap() {
            Reply::Document(d) => d,
            Reply::DocumentSaved(d) => d.snapshot().clone(),
            _ => panic!(),
        }
    }
    fn upload(&self, doc: &DocumentSnapshot, id: Uuid, bytes: &[u8]) {
        for (ix, part) in bytes.chunks(MAX_CHUNK_BYTES).enumerate() {
            self.call(Command::Image(ImageCommand::Upload {
                document: doc.id().clone(),
                resource: id,
                name: "board.png".into(),
                offset: (ix * MAX_CHUNK_BYTES) as u64,
                bytes: part.to_vec(),
                complete: (ix * MAX_CHUNK_BYTES) + part.len() == bytes.len(),
            }))
            .unwrap();
        }
    }
    fn bytes(&self, doc: &DocumentSnapshot, resource: Uuid) -> Vec<u8> {
        let Reply::Image(ImageReply::Info { length, .. }) = self
            .call(Command::Image(ImageCommand::Info {
                scope: ImageScope {
                    document: doc.id().clone(),
                    revision: doc.head(),
                    resource,
                },
            }))
            .unwrap()
        else {
            panic!()
        };
        let Reply::DocumentResource { bytes } = self
            .call(Command::DocumentResource {
                id: doc.id().clone(),
                revision: doc.head(),
                resource,
                offset: 0,
                length: length as u32,
            })
            .unwrap()
        else {
            panic!()
        };
        bytes
    }
    fn shutdown(&self) {
        self.call(Command::Shutdown).unwrap();
        for _ in 0..200 {
            if self.client.has_exited() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("backend did not stop");
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if !self.client.has_exited() {
            let _ = self.call(Command::Shutdown);
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn save_body(base: &DocumentSnapshot, body: String) -> Command {
    Command::SaveDocument(SaveDocument::new(
        Uuid::new_v4(),
        1,
        DocumentSnapshot::new(
            base.id().clone(),
            base.revision(),
            base.head(),
            base.content().with_body(body),
        ),
    ))
}
fn scene(image: Uuid, x: f64) -> Scene {
    Scene::from_json(json!({"type":"excalidraw","version":2,"elements":[{"id":"picture","type":"image","x":x,"y":20,"width":60,"height":40,"angle":0,"fileId":"image"},{"id":"rect","type":"rectangle","x":100,"y":20,"width":30,"height":40,"angle":0,"strokeColor":"#ff0000","backgroundColor":"#00ff00","fillStyle":"solid"}],"files":{"image":{"resourceId":image,"mimeType":"image/png","created":1,"future":12345678901234567890u64}},"future":{"keep":true}})).unwrap()
}
fn image() -> Vec<u8> {
    let scene=Scene::from_json(json!({"elements":[{"id":"r","type":"rectangle","x":0,"y":0,"width":12,"height":8,"angle":0,"backgroundColor":"#ff0000","fillStyle":"solid"}]})).unwrap();
    preview::png(&scene).unwrap()
}
#[test]
fn real_backend_atomic_board_history_retry_transfer_archive_and_export() {
    let mut f = Fixture::new();
    let initial = f.doc(Command::CreateDocument);
    let block = Uuid::new_v4();
    let base = f.doc(save_body(
        &initial,
        format!("正文\n\n{}\n尾部", empty(block)),
    ));
    let image_id = Uuid::new_v4();
    let original = image();
    f.upload(&base, image_id, &original);
    let scene = scene(image_id, 10.);
    let mut loaded = scene.to_json();
    use base64::Engine;
    loaded["files"]["image"]["dataURL"] = json!(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&original)
    ));
    let png = preview::png(&Scene::from_json(loaded).unwrap()).unwrap();
    assert!(image::load_from_memory(&png).unwrap().width() > 100);
    let request = BoardSave::new(
        base.clone(),
        block.to_string(),
        scene.serialize().unwrap(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        vec![image_id],
    );
    assert_eq!(
        f.call(Command::SaveBoard(request.clone()))
            .unwrap_err()
            .code(),
        ErrorCode::InvalidRequest
    );
    assert_eq!(
        f.doc(Command::OpenDocument {
            id: base.id().clone()
        }),
        base
    );
    f.upload(&base, request.preview(), &png);
    use sha2::{Digest, Sha256};
    let scene_hash = format!("{:x}", Sha256::digest(request.scene().as_bytes()));
    let blocked = f
        .root
        .join("workspace")
        .join(base.id().notebook().to_string())
        .join("assets/sha256")
        .join(&scene_hash[..2])
        .join(format!("{scene_hash}.bin"));
    fs::create_dir_all(&blocked).unwrap();
    assert_eq!(
        f.call(Command::SaveBoard(request.clone()))
            .unwrap_err()
            .code(),
        ErrorCode::Storage
    );
    assert_eq!(
        f.doc(Command::OpenDocument {
            id: base.id().clone()
        }),
        base
    );
    assert!(
        f.call(Command::Image(ImageCommand::Info {
            scope: ImageScope {
                document: base.id().clone(),
                revision: base.head(),
                resource: image_id
            }
        }))
        .is_err()
    );
    fs::remove_dir(&blocked).unwrap();
    let first = f.doc(Command::SaveBoard(request.clone()));
    assert_eq!(first.revision(), base.revision() + 1);
    assert_eq!(f.doc(Command::SaveBoard(request.clone())), first);
    assert_eq!(f.bytes(&first, image_id), original);
    assert_eq!(
        f.bytes(&first, request.resource()),
        request.scene().as_bytes()
    );
    assert_eq!(f.bytes(&first, request.preview()), png);
    assert_eq!(first.resources().len(), 3);
    let mut edited = Board::new(scene.clone(), 100);
    edited.select(["rect".to_owned()]).unwrap();
    edited
        .apply(
            Edit::Translate {
                delta: Point::new(30., 10.),
            },
            EditStamp::new(2, 2),
        )
        .unwrap();
    let second_scene = edited.scene().to_json();
    f.shutdown();
    f.client = f.client.reconnect().recv_blocking().unwrap().unwrap();
    f.upload(&base, image_id, &original);
    f.upload(&base, request.preview(), &png);
    assert_eq!(f.doc(Command::SaveBoard(request.clone())), first);
    let missing = BoardSave::new(
        first.clone(),
        block.to_string(),
        self::scene(Uuid::new_v4(), 10.).serialize().unwrap(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        vec![],
    );
    f.upload(&first, missing.preview(), &png);
    assert_eq!(
        f.call(Command::SaveBoard(missing)).unwrap_err().code(),
        ErrorCode::InvalidRequest
    );
    assert_eq!(
        f.doc(Command::OpenDocument {
            id: first.id().clone()
        }),
        first
    );
    let other = f.doc(Command::CreateDocument);
    let changed_png = anynote_desktop::image::codec::rotate(
        &original,
        1,
        &std::sync::atomic::AtomicBool::new(false),
    )
    .unwrap();
    f.call(Command::Image(ImageCommand::Release {
        document: base.id().clone(),
        resources: vec![image_id],
    }))
    .unwrap();
    f.upload(&other, image_id, &changed_png);
    let other_saved = f.doc(Command::SaveDocument(
        SaveDocument::new(
            Uuid::new_v4(),
            1,
            DocumentSnapshot::new(
                other.id().clone(),
                other.revision(),
                other.head(),
                other
                    .content()
                    .with_body(format!("![other](anynote-resource:{image_id})")),
            ),
        )
        .with_resources(vec![image_id]),
    ));
    assert_eq!(f.bytes(&other_saved, image_id), changed_png);
    f.call(Command::Image(ImageCommand::Release {
        document: other.id().clone(),
        resources: vec![image_id],
    }))
    .unwrap();
    f.upload(&base, image_id, &original);

    assert_eq!(f.bytes(&first, image_id), original);
    let second = BoardSave::new(
        first.clone(),
        block.to_string(),
        serde_json::to_string(&second_scene).unwrap(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        vec![],
    );
    let mut hydrated = second_scene.clone();
    hydrated["files"]["image"]["dataURL"] = json!(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&original)
    ));
    let second_png = preview::png(&Scene::from_json(hydrated).unwrap()).unwrap();
    assert_ne!(second_png, png);
    f.upload(&first, second.preview(), &second_png);
    let saved = f.doc(Command::SaveBoard(second.clone()));
    assert_eq!(f.bytes(&saved, second.preview()), second_png);
    assert_eq!(
        f.call(Command::SaveBoard(request.clone()))
            .unwrap_err()
            .code(),
        ErrorCode::Conflict
    );
    assert_eq!(
        f.bytes(&first, request.resource()),
        request.scene().as_bytes()
    );
    assert_eq!(f.bytes(&saved, image_id), original);
    let later = f.doc(save_body(
        &saved,
        format!("{}\n后续正文", saved.content().body()),
    ));
    assert_eq!(
        f.call(Command::SaveBoard(second)).unwrap_err().code(),
        ErrorCode::Conflict
    );
    assert_eq!(
        f.doc(Command::OpenDocument {
            id: later.id().clone()
        }),
        later
    );
    f.shutdown();
    let root = f.root.join("workspace");
    let q = WriteQueue::open(&root, 4).unwrap();
    let source = base.id().notebook().to_string();
    let note = base.id().note().to_string();
    let target = q
        .submit(|c| c.create_notebook("target").map(|n| n.id))
        .unwrap()
        .wait()
        .unwrap();
    let transfer = TransferRequest {
        notebook_id: source.clone(),
        target_notebook_id: target.clone(),
        id: note.clone(),
        target_parent_id: None,
        mode: TransferMode::Copy,
        operation_id: Uuid::new_v4().to_string(),
        expected_revision: later.revision(),
    };
    let copied = transfer_node(&q, transfer.clone()).unwrap().wait().unwrap();
    let capture = |id: &str, mode| {
        let id = id.to_owned();
        let root = root.clone();
        let mut s = q
            .submit(move |c| c.capture_snapshot(&id, &root, &Cancellation::default()))
            .unwrap()
            .wait()
            .unwrap();
        s.prepare(mode, &Cancellation::default()).unwrap();
        s
    };
    let full = capture(&target, SnapshotMode::Full);
    let book = ReadonlyNotebook::open(full.path(), Some(&target)).unwrap();
    let copied_note = book.note(&copied.id).unwrap();
    assert!(copied_note.body.contains("后续正文"));
    let pins = book.revision_resources().unwrap();
    assert!(pins.len() >= 9);
    for pin in &pins {
        let mut asset = book
            .resource(
                &pin.resource_id,
                Some(ResourceScope::note(&copied.id).with_revision(&pin.revision_id)),
            )
            .unwrap();
        if asset.info().mime == SCENE_MIME {
            let bytes = asset
                .read_range(&pin.asset_hash, 0, asset.info().size as usize)
                .unwrap();
            let scene: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(scene["future"]["keep"], true);
            let id = scene["files"]["image"]["resourceId"].as_str().unwrap();
            let mut image = book
                .resource(
                    id,
                    Some(ResourceScope::note(&copied.id).with_revision(&pin.revision_id)),
                )
                .unwrap();
            let hash = image.info().hash.clone();
            assert_eq!(
                image.read_range(&hash, 0, original.len()).unwrap(),
                original
            );
        }
    }
    let archive = f.root.join("board.anynote");
    export_archive(
        &mut capture(&target, SnapshotMode::Full),
        SnapshotMode::Full,
        &archive,
        false,
        &Cancellation::default(),
    )
    .unwrap();
    let imported_root = f.root.join("imported");
    fs::create_dir_all(&imported_root).unwrap();
    let imported = import_archive(&archive, &imported_root, &Cancellation::default()).unwrap();
    let imported_book =
        ReadonlyNotebook::open(&imported_root.join(&imported.id), Some(&imported.id)).unwrap();
    assert_eq!(
        imported_book.revision_resources().unwrap().len(),
        pins.len()
    );
    let export = f.root.join("markdown");
    export_markdown(
        &mut capture(&target, SnapshotMode::Current),
        &export,
        OpenExportFormat::Directory,
        &Cancellation::default(),
    )
    .unwrap();
    let map: Value =
        serde_json::from_slice(&fs::read(export.join("EXPORT-MAP.json")).unwrap()).unwrap();
    let paths = map["resources"].as_array().unwrap()[0]["resources"]
        .as_object()
        .unwrap();
    let scene_path = paths
        .values()
        .filter_map(Value::as_str)
        .find(|p| p.ends_with(".excalidraw.json"))
        .unwrap();
    let exported: Value =
        serde_json::from_slice(&fs::read(export.join(scene_path)).unwrap()).unwrap();
    assert_eq!(
        exported["files"]["image"]["dataURL"],
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&original)
        )
    );
    let moved = transfer_node(
        &q,
        TransferRequest {
            mode: TransferMode::Move,
            operation_id: Uuid::new_v4().to_string(),
            ..transfer
        },
    )
    .unwrap()
    .wait()
    .unwrap();
    assert!(!moved.id.is_empty());
    drop(imported_book);
    drop(book);
    drop(full);
    drop(q);
}
