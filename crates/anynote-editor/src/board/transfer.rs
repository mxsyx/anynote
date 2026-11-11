//! Clipboard fragments retain source data; insertion resolves identity in one Board transaction.
use super::{Board, BoardError, Command, Element, ElementKind, Point, Scene, scene::invalid};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_ELEMENTS: usize = 10_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Clipboard {
    elements: Vec<Value>,
    #[serde(default)]
    files: Map<String, Value>,
}
impl Clipboard {
    pub fn from_board(board: &Board) -> Result<Self, BoardError> {
        let selected = board.selected_ids();
        let mut elements = Vec::new();
        let mut files = Map::new();
        for element in board
            .scene()
            .elements()
            .filter(|e| !e.is_deleted() && selected.contains(e.id()))
        {
            let mut value = element.to_json();
            if element
                .reference("frameId")
                .is_some_and(|id| !selected.contains(id))
            {
                value["frameId"] = Value::Null;
            }
            if let Some(id) = element.reference("fileId") {
                let file = board
                    .scene()
                    .field("files")
                    .and_then(|f| f.get(id))
                    .ok_or_else(|| invalid("missing image file"))?;
                files.insert(id.to_owned(), file.clone());
            }
            elements.push(value);
        }
        let fragment = Self { elements, files };
        fragment.validate()?;
        Ok(fragment)
    }

    pub fn parse(source: &str) -> Result<Self, BoardError> {
        if source.len() > MAX_BYTES {
            return Err(invalid("clipboard exceeds 16 MiB"));
        }
        let value: Value = serde_json::from_str(source)?;
        if value.get("type").and_then(Value::as_str) != Some("excalidraw/clipboard") {
            return Err(invalid("not an Excalidraw clipboard"));
        }
        let fragment: Self = serde_json::from_value(value)?;
        fragment.validate()?;
        Ok(fragment)
    }

    pub fn serialize(&self) -> Result<String, BoardError> {
        self.validate()?;
        let source = serde_json::to_string(
            &json!({"type":"excalidraw/clipboard", "elements": self.elements, "files": self.files}),
        )?;
        if source.len() > MAX_BYTES {
            return Err(invalid("clipboard exceeds 16 MiB"));
        }
        Ok(source)
    }

    pub fn elements(&self) -> &[Value] {
        &self.elements
    }
    pub fn files(&self) -> &Map<String, Value> {
        &self.files
    }

    /// IDs and seeds are supplied by the caller so replay never depends on RNG.
    pub fn paste(self, ids: TransferIds, delta: Point) -> Command {
        Command::Paste {
            clipboard: self,
            ids,
            delta,
        }
    }

    fn validate(&self) -> Result<Scene, BoardError> {
        if self.elements.is_empty() || self.elements.len() > MAX_ELEMENTS {
            return Err(invalid("clipboard needs 1..10000 elements"));
        }
        let scene = Scene::from_json(json!({"elements":self.elements,"files":self.files}))?;
        for e in scene.elements() {
            if e.is_deleted() || e.kind() == ElementKind::Unknown {
                return Err(invalid("clipboard requires live known elements"));
            }
            validate_references(e)?;
            if let Some(id) = e.reference("fileId")
                && !self.files.get(id).is_some_and(Value::is_object)
            {
                return Err(invalid("missing image file"));
            }
        }
        Ok(scene)
    }

    pub(super) fn insert(
        &self,
        destination: &Scene,
        ids: &TransferIds,
        delta: Point,
    ) -> Result<Command, BoardError> {
        delta.validate()?;
        let source = self.validate()?;
        let old_ids = source.elements().map(|e| e.id().to_owned()).collect();
        let old_groups = source
            .elements()
            .flat_map(Element::group_ids)
            .map(str::to_owned)
            .collect();
        let old_files = source
            .elements()
            .filter_map(|e| e.reference("fileId"))
            .map(str::to_owned)
            .collect();
        validate_mapping(&ids.elements, &old_ids, |id| {
            destination.element(id).is_some()
        })?;
        validate_mapping(&ids.groups, &old_groups, |id| {
            destination.elements().any(|e| e.group_ids().contains(&id))
        })?;
        validate_mapping(&ids.files, &old_files, |id| {
            destination
                .field("files")
                .and_then(|files| files.get(id))
                .is_some()
        })?;
        if !ids.seeds.is_empty() && ids.seeds.keys().cloned().collect::<BTreeSet<_>>() != old_ids {
            return Err(invalid("paste requires a seed for every element"));
        }
        let mut elements = Vec::with_capacity(self.elements.len());
        for e in source.elements() {
            let mut copy = remap(e, &ids.elements, &ids.groups, delta, false)?;
            if let Some(seed) = ids.seeds.get(e.id()) {
                copy.fields.insert("seed".into(), json!(seed));
            }
            if let Some(file) = e.reference("fileId") {
                copy.fields.insert("fileId".into(), json!(ids.files[file]));
            }
            elements.push(copy.to_json());
        }
        let mut files = Map::new();
        for (old, new) in &ids.files {
            let mut file = self.files[old].clone();
            file["id"] = json!(new);
            files.insert(new.clone(), file);
        }
        Ok(Command::Insert { elements, files })
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TransferIds {
    elements: BTreeMap<String, String>,
    groups: BTreeMap<String, String>,
    files: BTreeMap<String, String>,
    #[serde(default)]
    seeds: BTreeMap<String, u32>,
}
impl TransferIds {
    pub fn new(
        elements: BTreeMap<String, String>,
        groups: BTreeMap<String, String>,
        files: BTreeMap<String, String>,
    ) -> Self {
        Self {
            elements,
            groups,
            files,
            seeds: BTreeMap::new(),
        }
    }
    pub fn with_seeds(mut self, seeds: BTreeMap<String, u32>) -> Self {
        self.seeds = seeds;
        self
    }
}

fn validate_mapping(
    mapping: &BTreeMap<String, String>,
    expected: &BTreeSet<String>,
    exists: impl Fn(&str) -> bool,
) -> Result<(), BoardError> {
    if mapping.keys().cloned().collect::<BTreeSet<_>>() != *expected {
        return Err(invalid("incomplete transfer ID mapping"));
    }
    let mut used = BTreeSet::new();
    if mapping
        .values()
        .any(|id| id.is_empty() || exists(id) || !used.insert(id))
    {
        return Err(invalid("transfer ID collision"));
    }
    Ok(())
}

pub(super) fn remap(
    element: &Element,
    ids: &BTreeMap<String, String>,
    groups: &BTreeMap<String, String>,
    delta: Point,
    retain_external: bool,
) -> Result<Element, BoardError> {
    let mut copy = element.clone();
    copy.fields.insert("id".into(), json!(ids[element.id()]));
    copy.geometry()?.translated(delta)?.write(&mut copy);
    for name in ["containerId", "frameId"] {
        if let Some(old) = copy.reference(name) {
            let next = ids.get(old).map(|id| json!(id)).unwrap_or_else(|| {
                if retain_external {
                    json!(old)
                } else {
                    Value::Null
                }
            });
            copy.fields.insert(name.into(), next);
        }
    }
    for name in ["startBinding", "endBinding"] {
        if let Some(binding) = copy.fields.get_mut(name).filter(|v| !v.is_null()) {
            if let Some(new) = binding
                .get("elementId")
                .and_then(Value::as_str)
                .and_then(|id| ids.get(id))
            {
                binding["elementId"] = json!(new);
            } else if !retain_external {
                *binding = Value::Null;
            }
        }
    }
    if let Some(bound) = copy
        .fields
        .get_mut("boundElements")
        .and_then(Value::as_array_mut)
    {
        bound.retain_mut(|binding| {
            if let Some(id) = binding
                .get("id")
                .and_then(Value::as_str)
                .and_then(|id| ids.get(id))
            {
                binding["id"] = json!(id);
                true
            } else {
                retain_external
            }
        });
    }
    // DuplicateSelection initializes an empty reverse-binding list to null;
    // clipboard duplication retains the supplied array representation.
    if retain_external
        && copy
            .field("boundElements")
            .and_then(Value::as_array)
            .is_none_or(|v| v.is_empty())
    {
        copy.fields.insert("boundElements".into(), Value::Null);
    }
    let new_groups: Vec<_> = element
        .group_ids()
        .iter()
        .map(|id| groups.get(*id).map(String::as_str).unwrap_or(id))
        .collect();
    copy.fields.insert("groupIds".into(), json!(new_groups));
    Ok(copy)
}

pub(super) fn validate_references(e: &Element) -> Result<(), BoardError> {
    for key in ["frameId", "containerId", "fileId"] {
        if e.field(key)
            .is_some_and(|v| !v.is_null() && !v.as_str().is_some_and(|s| !s.is_empty()))
        {
            return Err(invalid("invalid clipboard reference"));
        }
    }
    if let Some(groups) = e.field("groupIds") {
        let groups = groups
            .as_array()
            .ok_or_else(|| invalid("invalid clipboard groups"))?;
        if groups
            .iter()
            .any(|v| !v.as_str().is_some_and(|s| !s.is_empty()))
        {
            return Err(invalid("invalid clipboard groups"));
        }
    }
    for key in ["startBinding", "endBinding"] {
        if let Some(binding) = e.field(key).filter(|v| !v.is_null())
            && (!binding
                .get("elementId")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty())
                || !binding
                    .get("focus")
                    .and_then(Value::as_f64)
                    .is_some_and(|v| (-1.0..=1.0).contains(&v))
                || !binding
                    .get("gap")
                    .and_then(Value::as_f64)
                    .is_some_and(|v| v.is_finite() && v >= 0.0))
        {
            return Err(invalid("invalid clipboard binding"));
        }
    }
    if let Some(bound) = e.field("boundElements").filter(|v| !v.is_null()) {
        let bound = bound
            .as_array()
            .ok_or_else(|| invalid("invalid clipboard reverse bindings"))?;
        if bound.iter().any(|v| {
            !v.get("id")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty())
                || !v.get("type").is_some_and(Value::is_string)
        }) {
            return Err(invalid("invalid clipboard reverse bindings"));
        }
    }
    Ok(())
}
