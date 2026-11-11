//! Versioned structural commands prepare RM16 transactions; they never own history or saved state.
mod blocks;
mod range;
mod table;
mod tree;

pub use blocks::{
    BlockSide, atom_position, block_selection, delete_blocks, move_blocks, paste_blocks,
};
pub use table::{CellAddress, CellDirection};
pub use tree::{NodeKind, StructureNode};

use crate::{
    inline::{Marks, Run, normalize, split_runs},
    model::{BlockId, Document},
    selection::{Selection, TextUnit, byte_offset, byte_range},
    source::{SourceError, newline_at},
    transaction::{EditError, EditKind, Patch, Transaction, difference},
};
use std::ops::Range;
use tree::{Caret, render};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StructureError {
    Edit(EditError),
    InvalidPath,
    InvalidTable,
    Unsupported,
    SemanticMismatch,
    Budget,
}
pub type StructureResult<T> = Result<T, StructureError>;
impl From<EditError> for StructureError {
    fn from(value: EditError) -> Self {
        Self::Edit(value)
    }
}
impl From<SourceError> for StructureError {
    fn from(value: SourceError) -> Self {
        Self::Edit(value.into())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ListStyle {
    Bullet,
    Ordered,
    Task,
}

/// Paths start at the synthetic root, whose children are the selected top-level blocks.
/// Reacquire this projection after every mutation; returned transactions retain the base generation.
pub struct Structure<'a> {
    document: &'a Document,
    span: Range<usize>,
    root: StructureNode,
    newline: &'static str,
}
impl<'a> Structure<'a> {
    /// A new paragraph at a blank source boundary, including before/after an atom or an empty document.
    pub fn at_caret(document: &'a Document, selection: Selection) -> StructureResult<Self> {
        selection.validate(document)?;
        let span = selection.range();
        if !span.is_empty()
            || document
                .blocks()
                .iter()
                .any(|b| b.span().start < span.start && span.start < b.span().end)
        {
            return Err(StructureError::InvalidPath);
        }
        Ok(Self {
            document,
            newline: newline_at(document.source(), span.start)?,
            span,
            root: StructureNode::new(NodeKind::Root, vec![StructureNode::paragraph(vec![])]),
        })
    }
    pub fn for_block(document: &'a Document, block: BlockId) -> StructureResult<Self> {
        if !document
            .block(block)
            .ok_or(SourceError::Stale)?
            .parsed()
            .is_editable()
        {
            return Err(StructureError::Unsupported);
        }
        Self::for_blocks(document, block, block)
    }
    pub fn for_blocks(
        document: &'a Document,
        first: BlockId,
        last: BlockId,
    ) -> StructureResult<Self> {
        let selected = block_selection(document, first, last)?;
        let mut span = selected.range();
        let line_start = document.source()[..span.start]
            .rfind(['\r', '\n', '\u{2028}', '\u{2029}'])
            .map_or(0, |at| {
                at + document.source()[at..].chars().next().unwrap().len_utf8()
            });
        if document.source()[line_start..span.start]
            .chars()
            .all(|c| matches!(c, ' ' | '\t'))
        {
            span.start = line_start;
        }
        let mut children = Vec::new();
        for block in document
            .blocks()
            .iter()
            .filter(|b| b.span().start >= span.start && b.span().end <= span.end)
        {
            children.push(StructureNode::from_block(document, block)?);
        }
        Ok(Self {
            document,
            newline: newline_at(document.source(), span.start)?,
            span,
            root: StructureNode::new(NodeKind::Root, children),
        })
    }
    pub fn root(&self) -> &StructureNode {
        &self.root
    }
    /// Include a view-only empty paragraph at a source boundary outside the selected blocks.
    pub fn with_blank_boundary(mut self, at: usize, before: bool) -> StructureResult<Self> {
        if !self.document.source().is_char_boundary(at)
            || (before && at > self.span.start)
            || (!before && at < self.span.end)
        {
            return Err(StructureError::InvalidPath);
        }
        let gap = if before {
            at..self.span.start
        } else {
            self.span.end..at
        };
        if !self.document.source()[gap].trim().is_empty() {
            return Err(StructureError::InvalidPath);
        }
        if before {
            self.span.start = at;
            self.root
                .children
                .insert(0, StructureNode::paragraph(vec![]));
        } else {
            self.span.end = at;
            self.root.children.push(StructureNode::paragraph(vec![]));
        }
        Ok(self)
    }
    pub fn insert_task_text(
        &self,
        path: &[usize],
        text: &str,
        marks: Marks,
        checked: bool,
        millis: u64,
    ) -> StructureResult<Transaction> {
        let mut root = self.root.clone();
        let node = root.node_mut(path)?;
        if node.kind != NodeKind::Paragraph || !node.runs.is_empty() {
            return Err(StructureError::Unsupported);
        }
        let paragraph = StructureNode::paragraph(vec![Run::literal(text.into(), marks)]);
        *node = StructureNode::new(
            NodeKind::List {
                ordered: false,
                start: 1,
            },
            vec![StructureNode::new(
                NodeKind::Item {
                    checked: Some(checked),
                },
                vec![paragraph],
            )],
        );
        self.finish(
            root,
            Some(Caret {
                path: [path, &[0, 0]].concat(),
                offset: text.len(),
            }),
            millis,
        )
    }
    /// An empty task has no lossless GFM spelling. The host keeps that pending
    /// item in its projection and materializes it with its first real text.
    pub fn insert_task_after(
        &self,
        item: &[usize],
        text: &str,
        marks: Marks,
        checked: bool,
        millis: u64,
    ) -> StructureResult<Transaction> {
        let (ix, parent) = item.split_last().ok_or(StructureError::InvalidPath)?;
        let mut root = self.root.clone();
        let list = root.node_mut(parent)?;
        if !matches!(list.kind, NodeKind::List { .. }) || *ix >= list.children.len() {
            return Err(StructureError::InvalidPath);
        }
        list.children.insert(
            ix + 1,
            StructureNode::new(
                NodeKind::Item {
                    checked: Some(checked),
                },
                vec![StructureNode::paragraph(vec![Run::literal(
                    text.into(),
                    marks,
                )])],
            ),
        );
        self.finish(
            root,
            Some(Caret {
                path: [parent, &[ix + 1, 0]].concat(),
                offset: text.len(),
            }),
            millis,
        )
    }
    /// Consume a typed Markdown prefix in the same structural transaction.
    pub fn input_rule(
        &self,
        path: &[usize],
        prefix: &str,
        millis: u64,
    ) -> StructureResult<Transaction> {
        let mut root = self.root.clone();
        let node = root.node_mut(path)?;
        if node.kind != NodeKind::Paragraph {
            return Err(StructureError::Unsupported);
        }
        node.runs.clear();
        let mut caret_path = path.to_vec();
        match prefix {
            "# " | "## " | "### " | "#### " | "##### " | "###### " => {
                node.kind = NodeKind::Heading((prefix.len() - 1) as u8)
            }
            "> " => {
                *node = StructureNode::new(NodeKind::Quote, vec![StructureNode::paragraph(vec![])]);
                caret_path.push(0);
            }
            "- " | "* " | "1. " | "[] " | "[ ] " => {
                let checked = matches!(prefix, "[] " | "[ ] ").then_some(false);
                let item = StructureNode::new(
                    NodeKind::Item { checked },
                    vec![StructureNode::paragraph(vec![])],
                );
                *node = StructureNode::new(
                    NodeKind::List {
                        ordered: prefix == "1. ",
                        start: 1,
                    },
                    vec![item],
                );
                caret_path.extend([0, 0]);
            }
            _ => return Err(StructureError::Unsupported),
        }
        self.finish(
            root,
            Some(Caret {
                path: caret_path,
                offset: 0,
            }),
            millis,
        )
    }
    /// Replace a range whose endpoints are top-level text blocks, preserving the
    /// unselected runs and removing only the intervening selected blocks.
    pub fn replace_between_blocks(
        &self,
        start: usize,
        end: usize,
        text: &str,
        marks: Marks,
        millis: u64,
    ) -> StructureResult<Transaction> {
        let first = self
            .root
            .children
            .first()
            .ok_or(StructureError::InvalidPath)?;
        let last = self
            .root
            .children
            .last()
            .ok_or(StructureError::InvalidPath)?;
        if !matches!(first.kind, NodeKind::Paragraph | NodeKind::Heading(_))
            || !matches!(last.kind, NodeKind::Paragraph | NodeKind::Heading(_))
        {
            return Err(StructureError::Unsupported);
        }
        let start = byte_offset(&first.text(), start, TextUnit::Utf8)?;
        let end = byte_offset(&last.text(), end, TextUnit::Utf8)?;
        let (left, _) = cut_runs(&first.runs, start);
        let (_, right) = cut_runs(&last.runs, end);
        let mut merged = first.clone();
        merged.runs = normalize([left, vec![Run::literal(text.into(), marks)], right].concat());
        self.finish(
            StructureNode::new(NodeKind::Root, vec![merged]),
            Some(Caret {
                path: vec![0],
                offset: start + text.len(),
            }),
            millis,
        )
    }
    /// Change a text block's presentation without round-tripping unrelated blocks.
    pub fn set_text_kind(
        &self,
        path: &[usize],
        kind: NodeKind,
        millis: u64,
    ) -> StructureResult<Transaction> {
        if !matches!(
            kind,
            NodeKind::Paragraph | NodeKind::Heading(1..=6) | NodeKind::Code { .. }
        ) {
            return Err(StructureError::Unsupported);
        }
        let mut root = self.root.clone();
        let node = root.node_mut(path)?;
        if !matches!(
            node.kind,
            NodeKind::Paragraph | NodeKind::Heading(_) | NodeKind::Code { .. }
        ) {
            return Err(StructureError::Unsupported);
        }
        let text = node.text();
        if matches!(kind, NodeKind::Code { .. }) {
            node.code = text;
            node.runs.clear();
        } else if matches!(node.kind, NodeKind::Code { .. }) {
            node.runs = vec![Run::literal(text, Marks::default())];
            node.code.clear();
        }
        node.kind = kind;
        self.finish(
            root,
            Some(Caret {
                path: path.into(),
                offset: 0,
            }),
            millis,
        )
    }

    pub fn replace_code(
        &self,
        path: &[usize],
        range: Range<usize>,
        text: &str,
        millis: u64,
    ) -> StructureResult<Transaction> {
        let mut root = self.root.clone();
        let node = root.node_mut(path)?;
        if !matches!(node.kind, NodeKind::Code { .. }) {
            return Err(StructureError::Unsupported);
        }
        let range = byte_range(&node.code, range, TextUnit::Utf8)?;
        node.code.replace_range(range.clone(), text);
        self.finish(
            root,
            Some(Caret {
                path: path.into(),
                offset: range.start + text.len(),
            }),
            millis,
        )
    }
    /// Select nested nodes in source order (or reverse order), including across cells and blocks.
    pub fn select_nodes(&self, anchor: &[usize], head: &[usize]) -> StructureResult<Selection> {
        let anchor = self
            .get(anchor)?
            .span()
            .ok_or(StructureError::InvalidPath)?;
        let head = self.get(head)?.span().ok_or(StructureError::InvalidPath)?;
        let (a, h) = if anchor.start <= head.start {
            (anchor.start, head.end)
        } else {
            (anchor.end, head.start)
        };
        Ok(Selection::new(
            self.document.generation(),
            crate::selection::Position::new(a, crate::selection::Affinity::Before),
            crate::selection::Position::new(h, crate::selection::Affinity::After),
        ))
    }
    fn get(&self, path: &[usize]) -> StructureResult<&StructureNode> {
        self.root.node(path).ok_or(StructureError::InvalidPath)
    }
    fn finish(
        &self,
        root: StructureNode,
        caret: Option<Caret>,
        millis: u64,
    ) -> StructureResult<Transaction> {
        if caret.is_none() && root.semantic() == self.root.semantic() {
            return Ok(Transaction::new(
                self.document.generation(),
                vec![],
                EditKind::Format,
                millis,
            ));
        }
        let rendered = render(&root, self.newline, caret.as_ref())?;
        if rendered.text.encode_utf16().count() > anynote_core::protocol::rich::MAX_RICH_UTF16 {
            return Err(StructureError::Budget);
        }
        let check = Document::new(rendered.text.clone());
        let mut children = Vec::new();
        for block in check.blocks() {
            if matches!(
                block.parsed().reason(),
                Some(
                    anynote_core::protocol::rich::OpaqueReason::Budget
                        | anynote_core::protocol::rich::OpaqueReason::Oversize
                )
            ) {
                return Err(StructureError::Budget);
            }
            children.push(StructureNode::from_block(&check, block)?);
        }
        if StructureNode::new(NodeKind::Root, children).semantic() != root.semantic() {
            return Err(StructureError::SemanticMismatch);
        }
        prepared(
            self.document,
            self.span.clone(),
            rendered.text,
            rendered.caret,
            EditKind::Format,
            millis,
        )
    }

    pub fn split(
        &self,
        path: &[usize],
        offset: usize,
        unit: TextUnit,
        millis: u64,
    ) -> StructureResult<Transaction> {
        let original = self.get(path)?;
        if !matches!(original.kind, NodeKind::Paragraph | NodeKind::Heading(_)) {
            return Err(StructureError::Unsupported);
        }
        let offset = byte_offset(&original.text(), offset, unit)?;
        let (left, right) = cut_runs(&original.runs, offset);
        let mut root = self.root.clone();
        let (ix, parent_path) = path.split_last().ok_or(StructureError::InvalidPath)?;
        let parent = root.node_mut(parent_path)?;
        let mut caret_path = path.to_vec();
        if matches!(parent.kind, NodeKind::Item { .. }) && *ix == 0 {
            if original.runs.is_empty() && parent.children.len() == 1 {
                return self.outdent(parent_path, millis);
            }
            let mut next = parent.clone();
            next.kind = match next.kind {
                NodeKind::Item { checked: Some(_) } => NodeKind::Item {
                    checked: Some(false),
                },
                kind => kind,
            };
            next.children[0].runs = right;
            next.children[0].kind = NodeKind::Paragraph;
            parent.children.truncate(1);
            parent.children[0].runs = left;
            let (item_ix, list_path) = parent_path
                .split_last()
                .ok_or(StructureError::InvalidPath)?;
            root.node_mut(list_path)?.children.insert(item_ix + 1, next);
            caret_path = [list_path, &[item_ix + 1, 0]].concat();
        } else {
            parent.children[*ix].runs = left;
            parent
                .children
                .insert(ix + 1, StructureNode::paragraph(right));
            *caret_path.last_mut().unwrap() += 1;
        }
        self.finish(
            root,
            Some(Caret {
                path: caret_path,
                offset: 0,
            }),
            millis,
        )
    }

    pub fn split_item(
        &self,
        path: &[usize],
        offset: usize,
        unit: TextUnit,
        millis: u64,
    ) -> StructureResult<Transaction> {
        let node = self.get(path)?;
        if !matches!(node.kind, NodeKind::Item { .. }) {
            return Err(StructureError::Unsupported);
        }
        if node.children.is_empty() && offset == 0 {
            return self.outdent(path, millis);
        }
        self.split(&[path, &[0]].concat(), offset, unit, millis)
    }

    /// Join with the preceding sibling; adjacent list items join their boundary paragraphs.
    pub fn join(&self, path: &[usize], millis: u64) -> StructureResult<Transaction> {
        let (ix, parent_path) = path.split_last().ok_or(StructureError::InvalidPath)?;
        if *ix == 0 {
            return Err(StructureError::InvalidPath);
        }
        let mut root = self.root.clone();
        let parent = root.node_mut(parent_path)?;
        if *ix >= parent.children.len() {
            return Err(StructureError::InvalidPath);
        }
        let right = parent.children.remove(*ix);
        let left = &mut parent.children[ix - 1];
        let mut caret_path = [parent_path, &[ix - 1]].concat();
        let offset;
        if matches!(left.kind, NodeKind::Item { .. }) && matches!(right.kind, NodeKind::Item { .. })
        {
            let last = left
                .children
                .last_mut()
                .ok_or(StructureError::Unsupported)?;
            let first = right.children.first().ok_or(StructureError::Unsupported)?;
            if last.is_inline() && first.is_inline() {
                offset = join_inline(last, first)?;
                caret_path.push(left.children.len() - 1);
                left.children.extend(right.children.into_iter().skip(1));
            } else {
                offset = 0;
                caret_path.push(left.children.len());
                left.children.extend(right.children);
            }
        } else if matches!((&left.kind, &right.kind), (NodeKind::List { ordered: a, .. }, NodeKind::List { ordered: b, .. }) if a == b)
        {
            left.children.extend(right.children);
            return self.finish(root, None, millis);
        } else {
            offset = join_inline(left, &right)?;
        }
        self.finish(
            root,
            Some(Caret {
                path: caret_path,
                offset,
            }),
            millis,
        )
    }

    pub fn set_list(
        &self,
        path: &[usize],
        style: ListStyle,
        millis: u64,
    ) -> StructureResult<Transaction> {
        let mut root = self.root.clone();
        let node = root.node_mut(path)?;
        if !matches!(node.kind, NodeKind::List { .. }) {
            if !matches!(
                node.kind,
                NodeKind::Paragraph | NodeKind::Heading(_) | NodeKind::Quote
            ) {
                return Err(StructureError::Unsupported);
            }
            let mut child = node.clone();
            if matches!(child.kind, NodeKind::Heading(_)) {
                child.kind = NodeKind::Paragraph;
            }
            *node = StructureNode::new(
                NodeKind::List {
                    ordered: false,
                    start: 1,
                },
                vec![StructureNode::new(
                    NodeKind::Item { checked: None },
                    vec![child],
                )],
            );
        }
        node.kind = NodeKind::List {
            ordered: style == ListStyle::Ordered,
            start: 1,
        };
        for item in &mut node.children {
            let old = match item.kind {
                NodeKind::Item { checked } => checked,
                _ => return Err(StructureError::Unsupported),
            };
            item.kind = NodeKind::Item {
                checked: (style == ListStyle::Task).then_some(old.unwrap_or(false)),
            };
        }
        self.finish(root, None, millis)
    }

    pub fn indent(&self, item_path: &[usize], millis: u64) -> StructureResult<Transaction> {
        let (ix, list_path) = item_path.split_last().ok_or(StructureError::InvalidPath)?;
        let mut root = self.root.clone();
        let list = root.node_mut(list_path)?;
        if *ix == 0 || *ix >= list.children.len() || !matches!(list.kind, NodeKind::List { .. }) {
            return Err(StructureError::InvalidPath);
        }
        let item = list.children.remove(*ix);
        let kind = list.kind.clone();
        let previous = &mut list.children[ix - 1];
        if previous.children.last().is_some_and(|n| n.kind == kind) {
            let nested = previous.children.last_mut().unwrap();
            nested.children.push(item);
        } else {
            previous.children.push(StructureNode::new(kind, vec![item]));
        }
        self.finish(root, None, millis)
    }

    /// Lift an item one nesting level. At the outer list, split the list and emit its contents.
    pub fn outdent(&self, item_path: &[usize], millis: u64) -> StructureResult<Transaction> {
        let (ix, list_path) = item_path.split_last().ok_or(StructureError::InvalidPath)?;
        let (list_ix, container_path) =
            list_path.split_last().ok_or(StructureError::InvalidPath)?;
        let mut root = self.root.clone();
        let list = root.node_mut(list_path)?;
        if !matches!(list.kind, NodeKind::List { .. }) || *ix >= list.children.len() {
            return Err(StructureError::InvalidPath);
        }
        let kind = list.kind.clone();
        let following = list.children.split_off(ix + 1);
        let mut item = list.children.pop().unwrap();
        let empty = list.children.is_empty();
        let container = root.node_mut(container_path)?;
        if matches!(container.kind, NodeKind::Item { .. }) {
            if !following.is_empty() {
                item.children.push(StructureNode::new(kind, following));
            }
            // Blocks after the nested list remain after the lifted item, not before it.
            item.children
                .extend(container.children.drain(list_ix + 1..));
            if empty {
                container.children.remove(*list_ix);
            }
            let (parent_ix, outer_path) = container_path
                .split_last()
                .ok_or(StructureError::InvalidPath)?;
            root.node_mut(outer_path)?
                .children
                .insert(parent_ix + 1, item);
        } else {
            let insert = if empty {
                container.children.remove(*list_ix);
                *list_ix
            } else {
                list_ix + 1
            };
            let mut lifted = item.children;
            if lifted.is_empty() {
                lifted.push(StructureNode::paragraph(vec![]));
            }
            if !following.is_empty() {
                lifted.push(StructureNode::new(kind, following));
            }
            container.children.splice(insert..insert, lifted);
        }
        self.finish(root, None, millis)
    }

    pub fn set_quote(
        &self,
        path: &[usize],
        enabled: bool,
        millis: u64,
    ) -> StructureResult<Transaction> {
        let mut root = self.root.clone();
        let node = root.node_mut(path)?;
        if enabled {
            if node.kind == NodeKind::Quote {
                return self.finish(root, None, millis);
            }
            if matches!(
                node.kind,
                NodeKind::Root
                    | NodeKind::Item { .. }
                    | NodeKind::Cell
                    | NodeKind::Row
                    | NodeKind::Atom
            ) {
                return Err(StructureError::Unsupported);
            }
            *node = StructureNode::new(NodeKind::Quote, vec![node.clone()]);
        } else {
            if node.kind != NodeKind::Quote {
                return Err(StructureError::Unsupported);
            }
            let children = node.children.clone();
            let (ix, parent) = path.split_last().ok_or(StructureError::InvalidPath)?;
            root.node_mut(parent)?
                .children
                .splice(*ix..ix + 1, children);
        }
        self.finish(root, None, millis)
    }

    pub fn set_checked(
        &self,
        path: &[usize],
        checked: bool,
        millis: u64,
    ) -> StructureResult<Transaction> {
        let mut root = self.root.clone();
        let node = root.node_mut(path)?;
        if !matches!(node.kind, NodeKind::Item { checked: Some(_) }) {
            return Err(StructureError::Unsupported);
        }
        node.kind = NodeKind::Item {
            checked: Some(checked),
        };
        self.finish(root, None, millis)
    }

    /// Insert already converted Markdown at an inline selection, retaining marks on both sides.
    /// HTML conversion and resource localization belong to the existing importer/clipboard adapter.
    pub fn paste(
        &self,
        path: &[usize],
        range: Range<usize>,
        unit: TextUnit,
        markdown: &str,
        millis: u64,
    ) -> StructureResult<Transaction> {
        let (root, caret) = paste_into(self.root.clone(), path, range, unit, markdown, None)?;
        self.finish(root, Some(caret), millis)
    }
    /// Plain clipboard text cannot introduce Markdown syntax or resource directives.
    pub fn paste_plain(
        &self,
        path: &[usize],
        range: Range<usize>,
        unit: TextUnit,
        text: &str,
        millis: u64,
    ) -> StructureResult<Transaction> {
        let markdown = plain_markdown(text, self.newline)?;
        self.paste(path, range, unit, &markdown, millis)
    }
    pub fn replace_text(
        &self,
        path: &[usize],
        range: Range<usize>,
        unit: TextUnit,
        text: &str,
        marks: Marks,
        millis: u64,
    ) -> StructureResult<Transaction> {
        let mut root = self.root.clone();
        let node = root.node_mut(path)?;
        if !node.is_inline() {
            return Err(StructureError::Unsupported);
        }
        let range = byte_range(&node.text(), range, unit)?;
        let (left, _) = cut_runs(&node.runs, range.start);
        let (_, right) = cut_runs(&node.runs, range.end);
        node.runs = normalize([left, vec![Run::literal(text.into(), marks)], right].concat());
        self.finish(
            root,
            Some(Caret {
                path: path.into(),
                offset: range.start + text.len(),
            }),
            millis,
        )
    }
}

fn paste_into(
    mut root: StructureNode,
    path: &[usize],
    range: Range<usize>,
    unit: TextUnit,
    markdown: &str,
    selected_end: Option<&[usize]>,
) -> StructureResult<(StructureNode, Caret)> {
    let node = root.node(path).ok_or(StructureError::InvalidPath)?;
    if !matches!(
        node.kind,
        NodeKind::Paragraph | NodeKind::Heading(_) | NodeKind::Cell | NodeKind::Code { .. }
    ) {
        return Err(StructureError::Unsupported);
    }
    let range = byte_range(&node.text(), range, unit)?;
    if matches!(node.kind, NodeKind::Code { .. }) {
        root.node_mut(path)?
            .code
            .replace_range(range.clone(), markdown);
        return Ok((
            root,
            Caret {
                path: path.into(),
                offset: range.start + markdown.len(),
            },
        ));
    }
    let fragment = Document::new(markdown.into());
    let mut inserted = Vec::new();
    for block in fragment.blocks() {
        inserted.push(StructureNode::from_block(&fragment, block)?);
    }
    if node.kind == NodeKind::Cell {
        if inserted.len() == 1 && inserted[0].kind == NodeKind::Table {
            let mut rows = inserted[0]
                .children
                .iter()
                .map(|row| row.children.clone())
                .collect::<Vec<_>>();
            let left = cut_runs(&node.runs, range.start).0;
            let mut right = cut_runs(&node.runs, range.end).1;
            // A matrix can cover the last selected cell. Move its unselected
            // suffix to the end of the pasted fragment instead of overwriting it.
            if let Some(end) = selected_end.filter(|end| {
                end.len() == path.len()
                    && *end != path
                    && end[..end.len() - 2] == path[..path.len() - 2]
                    && end[end.len() - 2] < path[path.len() - 2] + rows.len()
                    && end[end.len() - 1] >= path[path.len() - 1]
                    && end[end.len() - 1] < path[path.len() - 1] + rows[0].len()
            }) {
                right.extend(
                    root.node(end)
                        .ok_or(StructureError::InvalidPath)?
                        .runs
                        .clone(),
                );
            }
            let first = &mut rows[0][0];
            first.runs = normalize([left, first.runs.clone()].concat());
            let last_row = rows.len() - 1;
            let last_column = rows[last_row].len() - 1;
            let last = &mut rows[last_row][last_column];
            let offset = last.text().len();
            last.runs = normalize([last.runs.clone(), right].concat());
            let table_path = &path[..path.len() - 2];
            let row = path[path.len() - 2];
            let column = path[path.len() - 1];
            table::write_matrix(
                root.node_mut(table_path)?,
                CellAddress::new(row, column),
                &rows,
            )?;
            return Ok((
                root,
                Caret {
                    path: [table_path, &[row + last_row, column + last_column]].concat(),
                    offset,
                },
            ));
        }
        let mut runs = Vec::new();
        for (ix, block) in inserted.iter().enumerate() {
            if !matches!(block.kind, NodeKind::Paragraph | NodeKind::Heading(_)) {
                return Err(StructureError::Unsupported);
            }
            if ix > 0 {
                runs.push(Run::literal("\n".into(), Marks::default()));
            }
            runs.extend(block.runs.clone());
        }
        let offset = range.start + runs.iter().map(|run| run.text().len()).sum::<usize>();
        let left = cut_runs(&node.runs, range.start).0;
        let right = cut_runs(&node.runs, range.end).1;
        root.node_mut(path)?.runs = normalize([left, runs, right].concat());
        return Ok((
            root,
            Caret {
                path: path.into(),
                offset,
            },
        ));
    }
    if path.len() > 1 && inserted.iter().any(|node| node.kind == NodeKind::Atom) {
        // Opaque blocks have only a top-level lossless spelling. Split the
        // surrounding containers instead of indenting and reparsing their bytes.
        let mut before = root.clone();
        let mut after = root.clone();
        range::retain_side(&mut before, path, range.start, true)?;
        range::retain_side(&mut after, path, range.end, false)?;
        let fragment = StructureNode::new(NodeKind::Root, vec![StructureNode::paragraph(vec![])]);
        let (mut fragment, mut caret) =
            paste_into(fragment, &[0], 0..0, TextUnit::Utf8, markdown, None)?;
        caret.path[0] += before.children.len();
        before.children.append(&mut fragment.children);
        before.children.append(&mut after.children);
        return Ok((before, caret));
    }
    let (left, _) = cut_runs(&node.runs, range.start);
    let (_, right) = cut_runs(&node.runs, range.end);
    if inserted
        .first()
        .is_none_or(|n| n.kind != NodeKind::Paragraph)
    {
        inserted.insert(0, StructureNode::paragraph(vec![]));
    }
    let first = &mut inserted[0];
    first.runs = normalize([left, first.runs.clone()].concat());
    first.kind = node.kind.clone();
    if inserted
        .last()
        .is_none_or(|n| n.kind != NodeKind::Paragraph && !matches!(n.kind, NodeKind::Heading(_)))
    {
        inserted.push(StructureNode::paragraph(vec![]));
    }
    let last = inserted.last_mut().unwrap();
    let offset = last.text().len();
    last.runs = normalize([last.runs.clone(), right].concat());
    let (ix, parent) = path.split_last().ok_or(StructureError::InvalidPath)?;
    let caret = Caret {
        path: [parent, &[ix + inserted.len() - 1]].concat(),
        offset,
    };
    root.node_mut(parent)?
        .children
        .splice(*ix..ix + 1, inserted);
    Ok((root, caret))
}

fn plain_markdown(text: &str, newline: &'static str) -> StructureResult<String> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let fragments = normalized
        .split("\n\n")
        .map(|text| {
            crate::inline::encode_fragment(
                &[Run::literal(text.into(), Marks::default())],
                false,
                newline,
                None,
            )
            .map(|(text, _)| text)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(fragments.join(&newline.repeat(2)))
}

fn cut_runs(runs: &[Run], at: usize) -> (Vec<Run>, Vec<Run>) {
    let mut offset = 0;
    split_runs(runs, at).into_iter().partition(|run| {
        offset += run.text().len();
        offset <= at
    })
}
fn join_inline(left: &mut StructureNode, right: &StructureNode) -> StructureResult<usize> {
    if !matches!(left.kind, NodeKind::Paragraph | NodeKind::Heading(_))
        || !matches!(right.kind, NodeKind::Paragraph | NodeKind::Heading(_))
    {
        return Err(StructureError::Unsupported);
    }
    let offset = left.text().len();
    left.runs = normalize([left.runs.clone(), right.runs.clone()].concat());
    Ok(offset)
}

fn prepared(
    document: &Document,
    span: Range<usize>,
    mut replacement: String,
    mut caret: Option<usize>,
    kind: EditKind,
    millis: u64,
) -> StructureResult<Transaction> {
    let expected = document
        .source()
        .get(span.clone())
        .ok_or(SourceError::InvalidRange)?;
    let newline = newline_at(document.source(), span.start)?;
    if let Some(previous) = document
        .blocks()
        .iter()
        .rev()
        .find(|b| b.span().end <= span.start)
    {
        let separator = &document.source()[previous.span().end..span.start];
        let leading = &replacement
            [..replacement.len() - replacement.trim_start_matches(char::is_whitespace).len()];
        if line_breaks(separator) + line_breaks(leading) < 2 {
            let padding = newline.repeat(2);
            replacement.insert_str(0, &padding);
            caret = caret.map(|c| c + padding.len());
        }
    }
    if let Some(next) = document
        .blocks()
        .iter()
        .find(|b| b.span().start >= span.end)
    {
        let separator = &document.source()[span.end..next.span().start];
        let trailing = &replacement[replacement.trim_end_matches(char::is_whitespace).len()..];
        if line_breaks(separator) + line_breaks(trailing) < 2 {
            replacement.push_str(&newline.repeat(2));
        }
    }
    let mut source = document.source().to_owned();
    source.replace_range(span.clone(), &replacement);
    if source.encode_utf16().count() > anynote_core::protocol::rich::MAX_RICH_UTF16 {
        return Err(StructureError::Budget);
    }
    let check = Document::new(source);
    let local = Document::new(replacement.clone());
    for block in local.blocks() {
        let at = span.start + block.span().start..span.start + block.span().end;
        if !check.blocks().iter().any(|b| {
            b.span().start == at.start
                && b.parsed().reason() == block.parsed().reason()
                && check.source()[b.span()].trim_end() == local.source()[block.span()].trim_end()
        }) {
            return Err(StructureError::SemanticMismatch);
        }
    }
    // A neighboring fence/reference/list may absorb an apparently valid local replacement.
    // Require every untouched block to retain both its bytes and its safety classification.
    for old in document
        .blocks()
        .iter()
        .filter(|b| b.span().end <= span.start || b.span().start >= span.end)
    {
        let old_span = old.span();
        let start = if old_span.start >= span.end {
            span.start + replacement.len() + old_span.start - span.end
        } else {
            old_span.start
        };
        if !check.blocks().iter().any(|b| {
            b.span().start == start
                && b.parsed().reason() == old.parsed().reason()
                && check.source()[b.span()].trim_end()
                    == document.source()[old_span.clone()].trim_end()
        }) {
            return Err(StructureError::SemanticMismatch);
        }
    }
    let local = difference(expected, &replacement);
    let patch = Patch::new(
        span.start + local.range().start..span.start + local.range().end,
        local.removed(),
        local.inserted(),
    );
    let transaction = Transaction::new(document.generation(), vec![patch], kind, millis);
    Ok(if let Some(caret) = caret {
        transaction.with_selection(Selection::caret(document.generation(), span.start + caret))
    } else {
        transaction
    })
}

fn line_breaks(text: &str) -> usize {
    text.chars()
        .filter(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
        .count()
        - text.matches("\r\n").count()
}
