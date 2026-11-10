use super::*;
use gpui_kit::accesskit::{Node, NodeId, TextPosition, TextSelection};
use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Hash, PartialEq, Eq)]
pub(super) enum Key {
    Text(u64, usize),
    Link(u64, usize),
    Container(anynote_editor::model::BlockId, Vec<usize>),
    Block(u64),
    Row(u64),
    Table(anynote_editor::model::BlockId, Vec<usize>),
}
#[derive(Default)]
pub(super) struct TextMap(HashMap<NodeId, (usize, Vec<usize>)>);
impl TextMap {
    pub fn clear(&mut self) {
        self.0.clear();
    }
    pub fn position(&self, position: TextPosition) -> Option<usize> {
        let (start, offsets) = self.0.get(&position.node)?;
        Some(start + offsets.get(position.character_index)?)
    }
}
#[derive(Clone)]
struct TextLeaf {
    key: u64,
    kind: NodeKind,
    runs: Vec<(String, anynote_editor::inline::Marks)>,
}
#[derive(Clone)]
pub(super) struct Snapshot {
    leaves: Vec<TextLeaf>,
    ancestors: Vec<Vec<(Key, Role)>>,
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
        let mut ancestors = Vec::new();
        let mut block = None;
        let mut structure = None;
        let leaves = state
            .projection
            .leaves
            .iter()
            .enumerate()
            .map(|(ix, leaf)| {
                if block != leaf.id.block {
                    block = leaf.id.block;
                    structure = block.and_then(|block| {
                        anynote_editor::structure::Structure::for_block(
                            state.editor.document(),
                            block,
                        )
                        .ok()
                    });
                }
                let mut parents = Vec::new();
                if let (Some(block), Some(structure)) = (block, &structure) {
                    for depth in 1..leaf.id.path.len() {
                        let path = &leaf.id.path[..depth];
                        let role = match structure.root().node(path).map(|node| node.kind()) {
                            Some(NodeKind::List { .. }) => Role::List,
                            Some(NodeKind::Item { .. }) => Role::ListItem,
                            Some(NodeKind::Quote) => Role::Blockquote,
                            _ => continue,
                        };
                        parents.push((Key::Container(block, path.to_vec()), role));
                    }
                }
                ancestors.push(parents);
                let mut runs = leaf
                    .runs
                    .iter()
                    .map(|run| (run.text().to_owned(), run.marks().clone()))
                    .collect::<Vec<_>>();
                if let Some(c) = state.composition.as_ref().filter(|c| c.leaf == ix) {
                    let mut text = leaf.text.clone();
                    text.replace_range(c.local.clone(), state.editor.composition().unwrap().text());
                    runs = vec![(text, state.marks.clone())];
                }
                if runs.is_empty() {
                    runs.push((leaf.text.clone(), Default::default()));
                }
                if ix + 1 < keys.len() {
                    runs.last_mut().unwrap().0.push('\n');
                }
                TextLeaf {
                    key: keys[ix],
                    kind: leaf.kind.clone(),
                    runs,
                }
            })
            .collect();
        Self {
            leaves,
            ancestors,
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
        for TextLeaf { key, kind, runs } in self.leaves {
            let mut children = Vec::new();
            let leaf_start = start;
            for (text, marks) in runs {
                let text_id = id(Key::Text(key, start - leaf_start));
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
                if marks.has(anynote_editor::inline::Mark::Strong) {
                    run.set_font_weight(700.);
                }
                if marks.has(anynote_editor::inline::Mark::Emphasis) {
                    run.set_italic();
                }
                run.set_value(text);
                run.set_character_lengths(lengths);
                tree.nodes.push((text_id, run));
                if let Some(link) = marks.link() {
                    let link_id = id(Key::Link(key, start - leaf_start));
                    let mut node = Node::new(Role::Link);
                    node.set_url(link.url().to_owned());
                    node.set_children([text_id]);
                    tree.nodes.push((link_id, node));
                    children.push(link_id);
                } else {
                    children.push(text_id);
                }
            }
            let block_id = id(Key::Block(key));
            let mut block = Node::new(match kind {
                NodeKind::Heading(_) => Role::Heading,
                NodeKind::Cell => Role::Cell,
                NodeKind::Code { .. } => Role::Code,
                _ => Role::Paragraph,
            });
            if let NodeKind::Heading(level) = kind {
                block.set_level(level as usize);
            }
            block.set_children(children);
            blocks.push((block_id, block));
        }
        let mut tables: HashMap<Key, (NodeId, Node)> = HashMap::new();
        let mut containers: HashMap<Key, (NodeId, Node)> = HashMap::new();
        for row in self.rows {
            let mut parent = None;
            for (key, role) in &self.ancestors[row.leaves.start] {
                if !containers.contains_key(key) {
                    let node_id = id(key.clone());
                    if let Some(parent) = &parent {
                        containers.get_mut(parent).unwrap().1.push_child(node_id);
                    } else {
                        tree.roots.push(node_id);
                    }
                    containers.insert(key.clone(), (node_id, Node::new(*role)));
                }
                parent = Some(key.clone());
            }
            let mut attach = |node_id| {
                if let Some(parent) = &parent {
                    containers.get_mut(parent).unwrap().1.push_child(node_id);
                } else {
                    tree.roots.push(node_id);
                }
            };
            if let Some((block, path, row_ix, row_count, columns)) = row.table {
                let key = Key::Table(block, path);
                let (table_id, table) = tables.entry(key.clone()).or_insert_with(|| {
                    let table_id = id(key);
                    attach(table_id);
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
                for ix in row.leaves {
                    attach(blocks[ix].0);
                }
            }
        }
        tree.nodes.extend(blocks);
        tree.nodes.extend(tables.into_values());
        tree.nodes.extend(containers.into_values());
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
