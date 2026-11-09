use super::{StructureError, StructureResult};
use crate::inline::{Marks, Run, encode_fragment, flatten, normalize};
use anynote_core::protocol::rich::MarkdownNode as Ast;
use std::ops::Range;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NodeKind {
    Root,
    Paragraph,
    Heading(u8),
    Quote,
    List { ordered: bool, start: u32 },
    Item { checked: Option<bool> },
    Code { language: Option<String> },
    Rule,
    Table,
    Row,
    Cell,
    Atom,
}

/// A disposable semantic projection, addressed by child paths within its versioned block.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StructureNode {
    pub(super) kind: NodeKind,
    pub(super) children: Vec<Self>,
    pub(super) runs: Vec<Run>,
    pub(super) code: String,
    pub(super) raw: String,
    pub(super) span: Option<Range<usize>>,
}
impl StructureNode {
    pub fn kind(&self) -> &NodeKind {
        &self.kind
    }
    pub fn children(&self) -> &[Self] {
        &self.children
    }
    pub fn runs(&self) -> &[Run] {
        &self.runs
    }
    pub fn text(&self) -> String {
        if matches!(self.kind, NodeKind::Code { .. }) {
            self.code.clone()
        } else {
            self.runs.iter().map(Run::text).collect()
        }
    }
    pub fn span(&self) -> Option<Range<usize>> {
        self.span.clone()
    }
    pub fn node(&self, path: &[usize]) -> Option<&Self> {
        let mut node = self;
        for &ix in path {
            node = node.children.get(ix)?;
        }
        Some(node)
    }
    pub(super) fn node_mut(&mut self, path: &[usize]) -> StructureResult<&mut Self> {
        let mut node = self;
        for &ix in path {
            node = node
                .children
                .get_mut(ix)
                .ok_or(StructureError::InvalidPath)?;
        }
        Ok(node)
    }
    pub(super) fn new(kind: NodeKind, children: Vec<Self>) -> Self {
        Self {
            kind,
            children,
            runs: Vec::new(),
            code: String::new(),
            raw: String::new(),
            span: None,
        }
    }
    pub(super) fn paragraph(runs: Vec<Run>) -> Self {
        Self {
            runs: normalize(runs),
            ..Self::new(NodeKind::Paragraph, vec![])
        }
    }
    pub(super) fn from_block(
        document: &crate::model::Document,
        block: &crate::model::Block,
    ) -> StructureResult<Self> {
        if block.parsed().is_editable() {
            let anynote_core::protocol::rich::Content::Markdown { node, source_base } =
                block.parsed().content()
            else {
                return Err(StructureError::Unsupported);
            };
            Self::from_ast(node, *source_base)
        } else {
            let mut node = Self::new(NodeKind::Atom, vec![]);
            node.span = Some(block.span());
            node.raw = document.source()[block.span()].into();
            Ok(node)
        }
    }
    pub(super) fn is_inline(&self) -> bool {
        matches!(
            self.kind,
            NodeKind::Paragraph | NodeKind::Heading(_) | NodeKind::Cell
        )
    }
    pub(super) fn from_ast(ast: &Ast, base: usize) -> StructureResult<Self> {
        let kind = match ast {
            Ast::Paragraph(_) => NodeKind::Paragraph,
            Ast::Heading(n) => NodeKind::Heading(n.depth),
            Ast::Blockquote(_) => NodeKind::Quote,
            Ast::List(n) => NodeKind::List {
                ordered: n.ordered,
                start: n.start.unwrap_or(1),
            },
            Ast::ListItem(n) => NodeKind::Item { checked: n.checked },
            Ast::Code(n) => NodeKind::Code {
                language: n.lang.clone(),
            },
            Ast::ThematicBreak(_) => NodeKind::Rule,
            Ast::Table(_) => NodeKind::Table,
            Ast::TableRow(_) => NodeKind::Row,
            Ast::TableCell(_) => NodeKind::Cell,
            _ => return Err(StructureError::Unsupported),
        };
        let mut result = Self::new(kind, vec![]);
        result.span = ast
            .position()
            .map(|p| base + p.start.offset..base + p.end.offset);
        if let Ast::Code(n) = ast {
            result.code = n.value.replace("\r\n", "\n").replace('\r', "\n");
        }
        if result.is_inline() {
            for child in ast.children().into_iter().flatten() {
                flatten(child, &Marks::default(), &mut result.runs)?;
            }
            result.runs = normalize(result.runs);
        } else {
            for child in ast.children().into_iter().flatten() {
                result.children.push(Self::from_ast(child, base)?);
            }
        }
        if matches!(result.kind, NodeKind::Item { .. } | NodeKind::Quote)
            && result.children.is_empty()
        {
            let mut empty = Self::paragraph(vec![]);
            empty.span = result.span.as_ref().map(|s| s.end..s.end);
            result.children.push(empty);
        }
        // Rectangularize ragged rows without discarding overflow cell contents.
        if result.kind == NodeKind::Table {
            let columns = result
                .children
                .iter()
                .map(|r| r.children.len())
                .max()
                .unwrap_or(0);
            for row in &mut result.children {
                row.children
                    .resize_with(columns, || Self::new(NodeKind::Cell, vec![]));
            }
        }
        Ok(result)
    }
    pub(super) fn semantic(&self) -> Self {
        Self {
            kind: self.kind.clone(),
            children: self
                .children
                .iter()
                .filter(|n| !(n.kind == NodeKind::Paragraph && n.runs.is_empty()))
                .map(Self::semantic)
                .collect(),
            runs: self.runs.clone(),
            code: self.code.clone(),
            raw: self.raw.clone(),
            span: None,
        }
    }
}

pub(super) struct Caret {
    pub path: Vec<usize>,
    pub offset: usize,
}
#[derive(Default)]
pub(super) struct Rendered {
    pub text: String,
    pub caret: Option<usize>,
}
impl Rendered {
    fn append(&mut self, other: Self) {
        if let Some(caret) = other.caret {
            self.caret = Some(self.text.len() + caret);
        }
        self.text.push_str(&other.text);
    }
    fn prefix(mut self, first: &str, rest: &str, newline: &str) -> Self {
        if let Some(caret) = self.caret {
            self.caret = Some(
                caret + first.len() + self.text[..caret].matches(newline).count() * rest.len(),
            );
        }
        self.text = first.to_owned() + &self.text.replace(newline, &(newline.to_owned() + rest));
        self
    }
}

pub(super) fn render(
    node: &StructureNode,
    newline: &'static str,
    caret: Option<&Caret>,
) -> StructureResult<Rendered> {
    render_at(node, newline, caret, &mut Vec::new(), false)
}
fn render_at(
    node: &StructureNode,
    nl: &'static str,
    caret: Option<&Caret>,
    path: &mut Vec<usize>,
    alternate: bool,
) -> StructureResult<Rendered> {
    let at = caret.filter(|c| c.path == *path).map(|c| c.offset);
    if node.is_inline() {
        let (text, caret) = encode_fragment(&node.runs, node.kind == NodeKind::Cell, nl, at)?;
        let rendered = Rendered { text, caret };
        return Ok(if let NodeKind::Heading(level) = node.kind {
            rendered.prefix(&("#".repeat(level as usize) + " "), "", nl)
        } else {
            rendered
        });
    }
    let mut result = Rendered::default();
    match &node.kind {
        NodeKind::Atom => result.text = node.raw.clone(),
        NodeKind::Code { language } => {
            let longest = node
                .code
                .split(|ch| ch != '~')
                .map(str::len)
                .max()
                .unwrap_or(0);
            let fence = "~".repeat(3.max(longest + 1));
            let header = format!("{fence}{}{nl}", language.as_deref().unwrap_or(""));
            result.caret = at.map(|at| {
                header.len() + at + node.code[..at].matches('\n').count() * (nl.len() - 1)
            });
            result.text = format!("{header}{}{nl}{fence}", node.code.replace('\n', nl));
        }
        NodeKind::Rule => result.text = "***".into(),
        NodeKind::Table => {
            let columns = node.children.first().map_or(0, |r| r.children.len());
            if columns == 0 {
                return Err(StructureError::InvalidTable);
            }
            for (ix, row) in node.children.iter().enumerate() {
                if row.children.len() != columns {
                    return Err(StructureError::InvalidTable);
                }
                if ix > 0 {
                    result.text.push_str(nl);
                }
                path.push(ix);
                result.append(render_at(row, nl, caret, path, false)?);
                path.pop();
                if ix == 0 {
                    result.text.push_str(nl);
                    result
                        .text
                        .push_str(&format!("|{}", " --- |".repeat(columns)));
                }
            }
        }
        NodeKind::Row => {
            result.text.push_str("| ");
            for (ix, cell) in node.children.iter().enumerate() {
                if ix > 0 {
                    result.text.push_str(" | ");
                }
                path.push(ix);
                result.append(render_at(cell, nl, caret, path, false)?);
                path.pop();
            }
            result.text.push_str(" |");
        }
        NodeKind::List { ordered, start } => {
            for (ix, item) in node.children.iter().enumerate() {
                if ix > 0 {
                    result.text.push_str(nl);
                    result.text.push_str(nl);
                }
                let NodeKind::Item { checked } = item.kind else {
                    return Err(StructureError::Unsupported);
                };
                let marker = if *ordered {
                    format!(
                        "{}{} ",
                        u64::from(*start) + ix as u64,
                        if alternate { ")" } else { "." }
                    )
                } else if alternate {
                    "+ ".into()
                } else {
                    "- ".into()
                };
                let task = match checked {
                    Some(true) => "[x] ",
                    Some(false) => "[ ] ",
                    None => "",
                };
                path.push(ix);
                result.append(render_at(item, nl, caret, path, false)?.prefix(
                    &(marker.clone() + task),
                    &" ".repeat(marker.len()),
                    nl,
                ));
                path.pop();
            }
        }
        NodeKind::Root | NodeKind::Item { .. } | NodeKind::Quote => {
            for (ix, child) in node.children.iter().enumerate() {
                if ix > 0 {
                    result.text.push_str(nl);
                    result.text.push_str(nl);
                }
                path.push(ix);
                // Distinct adjacent lists must not merge when an empty exit paragraph has no Markdown node.
                let alternate = node.children[..ix]
                    .iter()
                    .filter(|n| matches!(n.kind, NodeKind::List { .. }))
                    .count()
                    % 2
                    == 1;
                result.append(render_at(child, nl, caret, path, alternate)?);
                path.pop();
            }
            if node.kind == NodeKind::Quote {
                result = result.prefix("> ", "> ", nl);
            }
        }
        _ => return Err(StructureError::Unsupported),
    }
    Ok(result)
}
