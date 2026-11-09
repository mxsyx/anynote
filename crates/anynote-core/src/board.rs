//! Explicit whiteboard commits bind one immutable document and directive identity.
use crate::{document_session::DocumentSnapshot, protocol::markdown::parse_blocks};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub const SCENE_MIME: &str = "application/vnd.anynote.whiteboard+json";
pub const MAX_SCENE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BoardSave {
    base: DocumentSnapshot,
    block: String,
    scene: String,
    resource: Uuid,
    preview: Uuid,
    images: Vec<Uuid>,
}
impl BoardSave {
    pub fn new(
        base: DocumentSnapshot,
        block: String,
        scene: String,
        resource: Uuid,
        preview: Uuid,
        images: Vec<Uuid>,
    ) -> Self {
        Self {
            base,
            block,
            scene,
            resource,
            preview,
            images,
        }
    }
    pub fn base(&self) -> &DocumentSnapshot {
        &self.base
    }
    pub fn block(&self) -> &str {
        &self.block
    }
    pub fn scene(&self) -> &str {
        &self.scene
    }
    pub fn resource(&self) -> Uuid {
        self.resource
    }
    pub fn preview(&self) -> Uuid {
        self.preview
    }
    pub fn images(&self) -> &[Uuid] {
        &self.images
    }
    pub fn body(&self) -> Option<String> {
        replace(
            self.base.content().body(),
            &self.block,
            self.resource,
            self.preview,
        )
    }
}

#[derive(Clone, Debug)]
pub struct BoardBlock {
    id: String,
    resource: Option<Uuid>,
    preview: Option<Uuid>,
}
impl BoardBlock {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn resource(&self) -> Option<Uuid> {
        self.resource
    }
    pub fn preview(&self) -> Option<Uuid> {
        self.preview
    }
}
pub fn parse(source: &str) -> Option<BoardBlock> {
    let blocks = parse_blocks(source);
    if blocks.len() != 1 {
        return None;
    }
    let d = blocks[0].directive()?;
    if d.attrs().get("type")? != "core.whiteboard" || d.attrs().get("version")? != "1" {
        return None;
    }
    let id = d.attrs().get("id")?.clone();
    if id.is_empty() {
        return None;
    }
    let data = d.data()?.as_object()?;
    let resource = |key| match data.get(key) {
        None | Some(Value::Null) => Some(None),
        Some(v) => Some(Some(Uuid::parse_str(v.as_str()?).ok()?)),
    };
    Some(BoardBlock {
        id,
        resource: resource("resourceId")?,
        preview: resource("previewResourceId")?,
    })
}
pub fn empty(id: Uuid) -> String {
    format!(":::anynote{{type=\"core.whiteboard\" version=\"1\" id=\"{id}\"}}\n{{}}\n:::\n")
}
fn replace(body: &str, id: &str, resource: Uuid, preview: Uuid) -> Option<String> {
    let mut result = None;
    for b in parse_blocks(body) {
        let Some(d) = b.directive() else { continue };
        if d.attrs().get("id").map(String::as_str) != Some(id) {
            continue;
        }
        if result.is_some()
            || d.attrs().get("type")? != "core.whiteboard"
            || d.attrs().get("version")? != "1"
        {
            return None;
        }
        let mut data = d.data()?.as_object()?.clone();
        data.insert("resourceId".into(), Value::String(resource.to_string()));
        data.insert(
            "previewResourceId".into(),
            Value::String(preview.to_string()),
        );
        let span = d.payload_span();
        let mut next = body.to_owned();
        let old = body.get(span.clone())?;
        let trailing = &old[old.trim_end_matches([' ', '\t', '\r', '\n']).len()..];
        next.replace_range(span, &(serde_json::to_string(&data).ok()? + trailing));
        result = Some(next);
    }
    result
}
