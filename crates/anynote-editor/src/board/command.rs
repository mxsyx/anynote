use super::operation::{active, execute, expand_selection};
use super::{BoardError, CropHandle, ElementKind, Geometry, Point, Scene, scene::invalid};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::Arc,
};

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct EditStamp {
    updated: u64,
    nonce: u32,
}
impl EditStamp {
    pub fn new(updated: u64, nonce: u32) -> Self {
        Self { updated, nonce }
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Layer {
    Back,
    Backward,
    Forward,
    Front,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Axis {
    X,
    Y,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Alignment {
    Start,
    Center,
    End,
}

/// Intent operates on the board's selection. Text geometry must come from the
/// eventual font/layout adapter, never from an estimated character width.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Command {
    Paste {
        clipboard: super::Clipboard,
        ids: super::TransferIds,
        delta: Point,
    },
    Insert {
        elements: Vec<Value>,
        files: Map<String, Value>,
    },
    Translate {
        delta: Point,
    },
    Align {
        axis: Axis,
        alignment: Alignment,
    },
    Distribute {
        axis: Axis,
    },
    Flip {
        axis: Axis,
    },
    Style {
        properties: Map<String, Value>,
    },
    Roughness {
        value: f64,
        seeds: BTreeMap<String, u32>,
    },
    Text {
        id: String,
        text: String,
        geometry: Geometry,
    },
    Points {
        id: String,
        points: Vec<Point>,
        pressures: Option<Vec<f64>>,
    },
    MovePoints {
        id: String,
        updates: Vec<(usize, Point)>,
    },
    AddPoints {
        id: String,
        points: Vec<Point>,
    },
    DeletePoints {
        id: String,
        indices: Vec<usize>,
    },
    Geometry {
        id: String,
        geometry: Geometry,
    },
    ResizePath {
        id: String,
        geometry: Geometry,
    },
    CropImage {
        id: String,
        handle: CropHandle,
        natural_width: f64,
        natural_height: f64,
        pointer: Point,
        aspect_ratio: Option<f64>,
    },
    Group {
        id: String,
    },
    Ungroup {
        id: String,
    },
    Layer {
        layer: Layer,
    },
    Delete,
    Duplicate {
        ids: BTreeMap<String, String>,
        groups: BTreeMap<String, String>,
        seeds: BTreeMap<String, u32>,
        delta: Point,
    },
    Lock {
        locked: bool,
    },
    Frame {
        id: Option<String>,
    },
    ResizeFrame {
        id: String,
        geometry: Geometry,
    },
    BindText {
        text: String,
        container: Option<String>,
    },
    BindArrow {
        arrow: String,
        end: bool,
        binding: Option<Value>,
    },
    View {
        properties: Map<String, Value>,
    },
}
#[derive(Clone)]
pub(super) struct Snapshot {
    pub(super) scene: Scene,
    pub(super) selected: BTreeSet<String>,
    pub(super) editing_group: Option<String>,
}
#[derive(Clone)]
struct HistoryEntry {
    before: Snapshot,
    after: Snapshot,
}

/// The sole owner of draft scene, selection and bounded undo/redo history.
/// One `apply` is one gesture/transaction; callers coalesce pointer previews.
pub struct Board {
    state: Snapshot,
    undo: VecDeque<HistoryEntry>,
    redo: Vec<HistoryEntry>,
    history_limit: usize,
}
impl Board {
    pub fn new(scene: Scene, history_limit: usize) -> Self {
        Self {
            state: Snapshot {
                scene,
                selected: BTreeSet::new(),
                editing_group: None,
            },
            undo: VecDeque::new(),
            redo: Vec::new(),
            history_limit,
        }
    }
    pub fn scene(&self) -> &Scene {
        &self.state.scene
    }
    pub fn selected_ids(&self) -> &BTreeSet<String> {
        &self.state.selected
    }
    pub fn has_undo(&self) -> bool {
        !self.undo.is_empty()
    }
    pub fn has_redo(&self) -> bool {
        !self.redo.is_empty()
    }
    pub fn editing_group(&self) -> Option<&str> {
        self.state.editing_group.as_deref()
    }
    /// Group editing is transient selection state, never a scene/appState write.
    pub fn edit_group(&mut self, id: Option<String>) -> Result<(), BoardError> {
        if let Some(id) = &id
            && !self
                .scene()
                .elements()
                .any(|e| !e.is_deleted() && e.group_ids().contains(&id.as_str()))
        {
            return Err(invalid("missing live group"));
        }
        let selected = self
            .state
            .selected
            .iter()
            .filter(|selected| {
                id.as_ref().is_none_or(|id| {
                    self.scene()
                        .element(selected)
                        .is_some_and(|e| e.group_ids().contains(&id.as_str()))
                })
            })
            .cloned()
            .collect();
        self.state.selected = expand_selection(self.scene(), selected, id.as_deref());
        self.state.editing_group = id;
        Ok(())
    }
    pub fn select(&mut self, ids: impl IntoIterator<Item = String>) -> Result<(), BoardError> {
        let selected: BTreeSet<_> = ids.into_iter().collect();
        for id in &selected {
            active(self.scene(), id)?;
        }
        let editing_group = self
            .state
            .editing_group
            .as_deref()
            .filter(|group| {
                selected.iter().all(|id| {
                    self.scene()
                        .element(id)
                        .is_some_and(|e| e.group_ids().contains(group))
                })
            })
            .map(str::to_owned);
        self.state.selected = expand_selection(self.scene(), selected, editing_group.as_deref());
        self.state.editing_group = editing_group;
        Ok(())
    }
    pub fn apply(&mut self, command: Command, stamp: EditStamp) -> Result<bool, BoardError> {
        self.apply_batch(&[command], stamp)
    }
    /// All mutations, validation and metadata updates succeed together or leave
    /// scene, selection, redo and original bytes untouched.
    pub fn apply_batch(
        &mut self,
        commands: &[Command],
        stamp: EditStamp,
    ) -> Result<bool, BoardError> {
        let before = self.state.clone();
        let mut after = before.clone();
        for command in commands {
            execute(&mut after, command)?;
        }
        if after.scene.elements == before.scene.elements
            && after.scene.fields == before.scene.fields
        {
            return Ok(false);
        }
        let previous: BTreeMap<_, _> = before.scene.elements().map(|e| (e.id(), e)).collect();
        for element in &mut after.scene.elements {
            let previous = previous.get(element.id()).copied();
            if previous == Some(element.as_ref()) {
                continue;
            }
            let version = previous
                .and_then(|e| e.field("version"))
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .checked_add(1)
                .ok_or_else(|| invalid("element version overflow"))?;
            let element = Arc::make_mut(element);
            element.fields.insert("version".into(), json!(version));
            element
                .fields
                .insert("versionNonce".into(), json!(stamp.nonce));
            element
                .fields
                .insert("updated".into(), json!(stamp.updated));
            if element.kind() != ElementKind::Unknown {
                element.geometry()?;
            }
        }
        after.scene.original = None;
        self.state = after.clone();
        self.redo.clear();
        if self.history_limit > 0 {
            self.undo.push_back(HistoryEntry { before, after });
            while self.undo.len() > self.history_limit {
                self.undo.pop_front();
            }
        }
        Ok(true)
    }
    pub fn undo(&mut self) -> bool {
        let Some(entry) = self.undo.pop_back() else {
            return false;
        };
        self.state = entry.before.clone();
        self.redo.push(entry);
        true
    }
    pub fn redo(&mut self) -> bool {
        let Some(entry) = self.redo.pop() else {
            return false;
        };
        self.state = entry.after.clone();
        self.undo.push_back(entry);
        true
    }
}
