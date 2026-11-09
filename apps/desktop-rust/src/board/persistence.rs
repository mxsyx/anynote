//! Storage transaction boundary shared by desktop IPC and persistence integration tests.
use anynote_core::{backend::*, board::*};
use anynote_editor::board::{ElementKind, Scene};
use anynote_storage::notebook::*;
use std::collections::BTreeSet;
use uuid::Uuid;

fn invalid() -> ServiceError {
    ServiceError::new(ErrorCode::InvalidRequest)
}
fn storage(error: ReadError) -> ServiceError {
    ServiceError::new(match error.kind() {
        ReadErrorKind::Conflict => ErrorCode::Conflict,
        ReadErrorKind::NotFound => ErrorCode::NotFound,
        ReadErrorKind::InvalidInput => ErrorCode::InvalidRequest,
        _ => ErrorCode::Storage,
    })
}

pub fn commit(
    book: &mut WritableNotebook,
    request: &BoardSave,
    mut uploads: Vec<ResourceWrite>,
) -> ServiceResult<Note> {
    let base = request.base();
    let note_id = base.id().note().to_string();
    let current = book.read().note(&note_id).map_err(storage)?;
    let body = request.body().ok_or_else(invalid)?;
    if request.scene().len() > MAX_SCENE_BYTES || request.images().len() > 30 {
        return Err(invalid());
    }
    let scene = Scene::parse(request.scene()).map_err(|_| invalid())?;
    let scene_hash = format!(
        "{:x}",
        <sha2::Sha256 as sha2::Digest>::digest(request.scene().as_bytes())
    );
    // An uncertain response may be retried, but only this exact commit is acknowledged.
    if current.node.revision == base.revision() + 1 && current.body == body {
        let pins = book
            .read()
            .resources_at_revision(
                &note_id,
                current.head_revision_id.as_deref().ok_or_else(invalid)?,
            )
            .map_err(storage)?;
        if pins
            .iter()
            .any(|p| p.resource_id == request.resource().to_string() && p.asset_hash == scene_hash)
            && pins
                .iter()
                .any(|p| p.resource_id == request.preview().to_string())
        {
            return Ok(current);
        }
    }
    if current.node.revision != base.revision()
        || current.head_revision_id.as_deref() != Some(&base.head().to_string())
    {
        return Err(ServiceError::new(ErrorCode::Conflict));
    }
    if current.node.note_type != Some(NoteType::Markdown) || current.body != base.content().body() {
        return Err(invalid());
    }
    let mut expected: BTreeSet<_> = request.images().iter().map(Uuid::to_string).collect();
    if expected.len() != request.images().len()
        || !expected.insert(request.preview().to_string())
        || expected.contains(&request.resource().to_string())
    {
        return Err(invalid());
    }
    let actual: BTreeSet<_> = uploads.iter().map(|r| r.id.clone()).collect();
    if actual != expected
        || actual.len() != uploads.len()
        || uploads.iter().any(|r| {
            !r.mime.starts_with("image/")
                || (r.id == request.preview().to_string() && r.mime != "image/png")
        })
    {
        return Err(invalid());
    }
    let pins = book
        .read()
        .resources_at_revision(&note_id, &base.head().to_string())
        .map_err(storage)?;
    let mut referenced = BTreeSet::new();
    if let Some(files) = scene.field("files").and_then(serde_json::Value::as_object) {
        if files.len() > 128 {
            return Err(invalid());
        }
        for file in files.values() {
            let f = file.as_object().ok_or_else(invalid)?;
            if f.contains_key("dataURL") {
                return Err(invalid());
            }
            let id = Uuid::parse_str(
                f.get("resourceId")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(invalid)?,
            )
            .map_err(|_| invalid())?;
            if id == request.resource() || id == request.preview() {
                return Err(invalid());
            }
            if !request.images().contains(&id) {
                if !pins.iter().any(|p| p.resource_id == id.to_string()) {
                    return Err(invalid());
                }
                let asset = book
                    .read()
                    .resource(
                        &id.to_string(),
                        Some(ResourceScope::note(&note_id).with_revision(&base.head().to_string())),
                    )
                    .map_err(storage)?;
                if !asset.info().mime.starts_with("image/") {
                    return Err(invalid());
                }
            }
            referenced.insert(id);
        }
    }
    if request.images().iter().any(|id| !referenced.contains(id)) {
        return Err(invalid());
    }
    for e in scene
        .elements()
        .filter(|e| e.kind() == ElementKind::Image && !e.is_deleted())
    {
        let file = e
            .field("fileId")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(invalid)?;
        if scene
            .field("files")
            .and_then(|files| files.get(file))
            .is_none()
        {
            return Err(invalid());
        }
    }
    uploads.push(
        ResourceWrite::bytes(
            request.resource().to_string(),
            "whiteboard.excalidraw.json".into(),
            SCENE_MIME.into(),
            request.scene().as_bytes().to_vec(),
        )
        .map_err(storage)?,
    );
    book.save_note(
        &note_id,
        base.revision(),
        &NotePatch {
            body: Some(body),
            ..Default::default()
        },
        &uploads,
    )
    .map_err(storage)
}
