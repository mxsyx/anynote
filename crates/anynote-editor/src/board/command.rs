use super::operation::{active, execute, expand_selection};
use super::{BoardError, ElementKind, Geometry, Point, Scene, scene::invalid};
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
    Geometry {
        id: String,
        geometry: Geometry,
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
        delta: Point,
    },
    Lock {
        locked: bool,
    },
    Frame {
        id: Option<String>,
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
    pub fn select(&mut self, ids: impl IntoIterator<Item = String>) -> Result<(), BoardError> {
        let selected: BTreeSet<_> = ids.into_iter().collect();
        for id in &selected {
            active(self.scene(), id)?;
        }
        self.state.selected = expand_selection(self.scene(), selected);
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
