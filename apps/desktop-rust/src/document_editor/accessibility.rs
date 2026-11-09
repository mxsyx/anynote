use super::*;
use gpui_kit::accesskit::{Node, NodeId, TextPosition, TextSelection};
use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Hash, PartialEq, Eq)]
pub(super) enum Key {
    Text(u64),
    Block(u64),
    Row(u64),
    Table(anynote_editor::model::BlockId, Vec<usize>),
}
#[derive(Default)]
pub(super) struct TextMap(HashMap<NodeId, (usize, Vec<usize>)>);
impl TextMap {
    pub fn position(&self, position: TextPosition) -> Option<usize> {
        let (start, offsets) = self.0.get(&position.node)?;
        Some(start + offsets.get(position.character_index)?)
    }
}
#[derive(Clone)]
pub(super) struct Snapshot {
    leaves: Vec<(u64, NodeKind, String)>,
    rows: Vec<projection::Row>,
    selection: Range<usize>,
    reversed: bool,
}
pub(super) struct Tree {
    pub nodes: Vec<(NodeId, Node)>,
    pub roots: Vec<NodeId>,
    pub selection: Option<TextSelection>,
    pub positions: TextMap,
}
impl Snapshot {
    pub fn new(state: &DocumentSession, keys: &[u64]) -> Self {
        let leaves = state
            .projection
            .leaves
            .iter()
            .enumerate()
            .map(|(ix, leaf)| {
                let mut text = leaf.text.clone();
                if let Some(c) = state.composition.as_ref().filter(|c| c.leaf == ix) {
                    text.replace_range(c.local.clone(), state.editor.composition().unwrap().text());
                }
                if ix + 1 < keys.len() {
                    text.push('\n');
                }
                (keys[ix], leaf.kind.clone(), text)
            })
            .collect();
        Self {
            leaves,
            rows: state.projection.rows.clone(),
            selection: state.display_selection(),
            reversed: state.anchor > state.head,
        }
    }
    pub fn build(self, id: impl Fn(Key) -> NodeId) -> Tree {
        let mut tree = Tree {
            nodes: Vec::new(),
            roots: Vec::new(),
            selection: None,
            positions: TextMap::default(),
        };
        let mut blocks = Vec::new();
        let mut start = 0;
        let mut anchor = None;
        let mut focus = None;
        for (key, kind, text) in self.leaves {
            let text_id = id(Key::Text(key));
            let mut lengths = Vec::new();
            for grapheme in text.graphemes(true) {
                if let Ok(len) = u8::try_from(grapheme.len()) {
                    lengths.push(len);
                } else {
                    // AccessKit stores each character's byte length in a u8.
                    // Preserve pathological combining sequences without truncating text.
                    lengths.extend(grapheme.chars().map(|ch| ch.len_utf8() as u8));
                }
            }
            let mut offsets = vec![0];
            for length in &lengths {
                offsets.push(offsets.last().unwrap() + *length as usize);
            }
            for (at, position) in [
                (self.selection.start, &mut anchor),
                (self.selection.end, &mut focus),
            ] {
                if at >= start && at <= start + text.len() {
                    *position = Some(TextPosition {
                        node: text_id,
                        character_index: offsets
                            .partition_point(|offset| *offset < at - start)
                            .min(offsets.len() - 1),
                    });
                }
            }
            tree.positions.0.insert(text_id, (start, offsets));
            start += text.len();
            let mut run = Node::new(Role::TextRun);
            run.set_value(text);
            run.set_character_lengths(lengths);
            tree.nodes.push((text_id, run));
            let block_id = id(Key::Block(key));
            let mut block = Node::new(match kind {
                NodeKind::Heading(_) => Role::Heading,
                NodeKind::Cell => Role::Cell,
                _ => Role::Paragraph,
            });
            if let NodeKind::Heading(level) = kind {
                block.set_level(level as usize);
            }
            block.set_children([text_id]);
            blocks.push((block_id, block));
        }
        let mut tables: HashMap<Key, (NodeId, Node)> = HashMap::new();
        for row in self.rows {
            if let Some((block, path, row_ix, row_count, columns)) = row.table {
                let key = Key::Table(block, path);
                let (table_id, table) = tables.entry(key.clone()).or_insert_with(|| {
                    let table_id = id(key);
                    tree.roots.push(table_id);
                    let mut table = Node::new(Role::Table);
                    table.set_row_count(row_count);
                    table.set_column_count(columns);
                    (table_id, table)
                });
                let _ = table_id;
                let row_id = id(Key::Row(blocks[row.leaves.start].0.0));
                let mut node = Node::new(Role::Row);
                node.set_row_index(row_ix);
                for (column, ix) in row.leaves.enumerate() {
                    blocks[ix].1.set_row_index(row_ix);
                    blocks[ix].1.set_column_index(column);
                    if row_ix == 0 {
                        blocks[ix].1.set_role(Role::ColumnHeader);
                    }
                    node.push_child(blocks[ix].0);
                }
                table.push_child(row_id);
                tree.nodes.push((row_id, node));
            } else {
                tree.roots.extend(row.leaves.map(|ix| blocks[ix].0));
            }
        }
        tree.nodes.extend(blocks);
        tree.nodes.extend(tables.into_values());
        if let (Some(anchor), Some(focus)) = (anchor, focus) {
            tree.selection = Some(if self.reversed {
                TextSelection {
                    anchor: focus,
                    focus: anchor,
                }
            } else {
                TextSelection { anchor, focus }
            });
        }
        tree
    }
}
