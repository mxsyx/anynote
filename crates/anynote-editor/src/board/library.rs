//! Library data is independent of scene history and has no filesystem or URL side effects.
use super::{Board, BoardError, Clipboard, ElementKind, Scene, scene::invalid};
use serde_json::{Map, Value, json};
use std::{collections::BTreeSet, sync::Arc};

#[derive(Clone, Debug)]
pub struct Library {
    fields: Map<String, Value>,
    original: Option<Arc<str>>,
}
impl Default for Library {
    fn default() -> Self {
        Self {
            fields: json!({"type":"excalidrawlib","version":2,"libraryItems":[]})
                .as_object()
                .unwrap()
                .clone(),
            original: None,
        }
    }
}
impl Library {
    pub fn parse(source: &str) -> Result<Self, BoardError> {
        if source.len() > 16 * 1024 * 1024 {
            return Err(invalid("library exceeds 16 MiB"));
        }
        let value: Value = serde_json::from_str(source)?;
        let fields = value
            .as_object()
            .ok_or_else(|| invalid("library must be an object"))?
            .clone();
        let library = Self {
            fields,
            original: Some(Arc::from(source)),
        };
        library.validate()?;
        Ok(library)
    }
    pub fn serialize(&self) -> Result<String, BoardError> {
        match &self.original {
            Some(original) => Ok(original.to_string()),
            None => Ok(serde_json::to_string(&self.fields)?),
        }
    }
    pub fn items(&self) -> &[Value] {
        self.fields["libraryItems"].as_array().unwrap()
    }
    pub fn clipboard(&self, id: &str) -> Result<Clipboard, BoardError> {
        let item = self
            .items()
            .iter()
            .find(|item| item["id"] == id)
            .ok_or_else(|| invalid("missing library item"))?;
        Clipboard::parse(
            &json!({"type":"excalidraw/clipboard","elements":item["elements"],"files":{}})
                .to_string(),
        )
    }
    pub fn add_selection(
        &mut self,
        board: &Board,
        id: &str,
        created: u64,
    ) -> Result<(), BoardError> {
        let elements: Vec<_> = board
            .scene()
            .elements()
            .filter(|e| !e.is_deleted() && board.selected_ids().contains(e.id()))
            .map(|e| e.to_json())
            .collect();
        let item = json!({"id":id,"status":"unpublished","created":created,"elements":elements});
        let mut items = Vec::with_capacity(self.items().len() + 1);
        items.push(item);
        items.extend_from_slice(self.items());
        self.replace(items).map(|_| ())
    }
    /// Pinned Excalidraw deduplicates by the ordered element IDs/versionNonces,
    /// not by the library item's ID or display metadata.
    pub fn merge(&mut self, other: &Library) -> Result<bool, BoardError> {
        let mut items = Vec::new();
        for item in other.items() {
            if !self
                .items()
                .iter()
                .any(|existing| same_elements(existing, item))
            {
                items.push(item.clone());
            }
        }
        items.extend_from_slice(self.items());
        self.replace(items)
    }
    pub fn remove(&mut self, ids: &BTreeSet<String>) -> Result<bool, BoardError> {
        if !ids
            .iter()
            .all(|id| self.items().iter().any(|item| item["id"] == *id))
        {
            return Err(invalid("missing library item"));
        }
        self.replace(
            self.items()
                .iter()
                .filter(|item| !ids.contains(item["id"].as_str().unwrap()))
                .cloned()
                .collect(),
        )
    }
    pub fn reorder(&mut self, ids: &[String]) -> Result<bool, BoardError> {
        if ids.len() != self.items().len() || ids.iter().collect::<BTreeSet<_>>().len() != ids.len()
        {
            return Err(invalid("library reorder requires every ID once"));
        }
        let items = ids
            .iter()
            .map(|id| {
                self.items()
                    .iter()
                    .find(|item| item["id"] == *id)
                    .cloned()
                    .ok_or_else(|| invalid("missing library item"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.replace(items)
    }
    fn replace(&mut self, items: Vec<Value>) -> Result<bool, BoardError> {
        if items == self.items() {
            return Ok(false);
        }
        let mut next = self.clone();
        next.fields.insert("libraryItems".into(), json!(items));
        next.original = None;
        next.validate()?;
        if next.serialize()?.len() > 16 * 1024 * 1024 {
            return Err(invalid("library exceeds 16 MiB"));
        }
        *self = next;
        Ok(true)
    }
    fn validate(&self) -> Result<(), BoardError> {
        if self.fields.get("type").and_then(Value::as_str) != Some("excalidrawlib")
            || self.fields.get("version").and_then(Value::as_u64) != Some(2)
        {
            return Err(invalid("requires Excalidraw library version 2"));
        }
        let items = self
            .fields
            .get("libraryItems")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("invalid library items"))?;
        if items.len() > 10_000 {
            return Err(invalid("too many library items"));
        }
        let mut ids = BTreeSet::new();
        for item in items {
            let id = item
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| invalid("invalid library ID"))?;
            if !ids.insert(id) {
                return Err(invalid("duplicate library ID"));
            }
            if !matches!(
                item.get("status").and_then(Value::as_str),
                Some("published" | "unpublished")
            ) || item.get("created").and_then(Value::as_u64).is_none()
            {
                return Err(invalid("invalid library metadata"));
            }
            let elements = item
                .get("elements")
                .and_then(Value::as_array)
                .ok_or_else(|| invalid("missing library elements"))?;
            if elements.is_empty() || elements.len() > 10_000 {
                return Err(invalid("invalid library element count"));
            }
            let scene = Scene::from_json(json!({"elements":elements}))?;
            for e in scene.elements() {
                super::transfer::validate_references(e)?;
                if e.is_deleted()
                    || matches!(
                        e.kind(),
                        ElementKind::Unknown
                            | ElementKind::Image
                            | ElementKind::Iframe
                            | ElementKind::Embeddable
                    )
                {
                    return Err(invalid("element type is unavailable in libraries"));
                }
            }
        }
        Ok(())
    }
}
fn same_elements(a: &Value, b: &Value) -> bool {
    let a = a["elements"].as_array().unwrap();
    let b = b["elements"].as_array().unwrap();
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(a, b)| a["id"] == b["id"] && a["versionNonce"] == b["versionNonce"])
}
