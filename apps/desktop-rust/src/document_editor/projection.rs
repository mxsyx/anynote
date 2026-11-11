use anynote_core::protocol::rich::{Content, MarkdownNode as Ast};
use anynote_editor::{
    inline::Run,
    model::{BlockId, Document},
    structure::{NodeKind, Structure, StructureNode},
};
use std::ops::Range;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct LeafId {
    pub block: Option<BlockId>,
    pub path: Vec<usize>,
    pub blank: usize,
}

#[derive(Clone)]
pub(super) struct Leaf {
    pub id: LeafId,
    pub kind: NodeKind,
    pub text: String,
    pub runs: Vec<Run>,
    pub span: Range<usize>,
    pub logical: Range<usize>,
    // A decoded scalar may cover an entire entity or a CRLF in the original source.
    pub scalars: Vec<(usize, Range<usize>)>,
    pub indent: usize,
    pub quote: bool,
    pub marker: Option<String>,
    pub task: Option<(Vec<usize>, bool)>,
}
impl Leaf {
    pub fn source_at(&self, byte: usize) -> usize {
        self.scalars
            .iter()
            .find(|(at, _)| *at >= byte)
            .map(|(_, span)| span.start)
            .unwrap_or_else(|| self.scalars.last().map_or(self.span.end, |(_, s)| s.end))
    }
    pub fn byte_at(&self, source: usize) -> usize {
        self.scalars
            .iter()
            .find(|(_, span)| source < span.end)
            .map_or(self.text.len(), |(at, _)| *at)
    }
}

#[derive(Clone)]
pub(super) struct Row {
    pub leaves: Range<usize>,
    pub table: Option<(BlockId, Vec<usize>, usize, usize, usize)>,
}

pub(super) struct Projection {
    pub leaves: Vec<Leaf>,
    pub rows: Vec<Row>,
    pub text: String,
}
impl Projection {
    pub fn insert_blank_after(&mut self, ix: usize) -> usize {
        let mut leaf = self.leaves[ix].clone();
        let at = leaf.span.end;
        leaf.id = LeafId {
            block: None,
            path: vec![0],
            blank: at,
        };
        leaf.kind = NodeKind::Paragraph;
        leaf.span = at..at;
        leaf.text.clear();
        leaf.runs.clear();
        leaf.scalars.clear();
        leaf.task = None;
        leaf.marker = None;
        let row_ix = self.row_for(ix) + 1;
        self.leaves.insert(ix + 1, leaf);
        for row in self.rows.iter_mut().skip(row_ix) {
            row.leaves.start += 1;
            row.leaves.end += 1;
        }
        self.rows.insert(
            row_ix,
            Row {
                leaves: ix + 1..ix + 2,
                table: None,
            },
        );
        self.text.clear();
        for (ix, leaf) in self.leaves.iter_mut().enumerate() {
            if ix > 0 {
                self.text.push('\n');
            }
            leaf.logical = self.text.len()..self.text.len() + leaf.text.len();
            self.text.push_str(&leaf.text);
        }
        self.leaves[ix + 1].logical.start
    }
    pub fn new(document: &Document, anchor: usize, head: usize) -> Self {
        let mut result = Self {
            leaves: vec![],
            rows: vec![],
            text: String::new(),
        };
        // Build supported blocks together: resolving each block separately scans
        // the document for every paragraph. Preserve per-block fallback when an
        // unsupported Markdown node prevents a shared structure.
        let structure = document
            .blocks()
            .first()
            .zip(document.blocks().last())
            .and_then(|(first, last)| Structure::for_blocks(document, first.id(), last.id()).ok());
        for (ix, block) in document.blocks().iter().enumerate() {
            let fallback = structure
                .is_none()
                .then(|| Structure::for_block(document, block.id()).ok())
                .flatten();
            let projected = structure
                .as_ref()
                .and_then(|structure| structure.root().children().get(ix))
                .or_else(|| fallback.as_ref()?.root().children().first())
                .filter(|_| block.parsed().is_editable());
            if let (Some(projected), Content::Markdown { node, source_base }) =
                (projected, block.parsed().content())
            {
                result.walk(
                    projected,
                    Some(node),
                    block.id(),
                    vec![0],
                    *source_base,
                    document.source(),
                    0,
                    false,
                    None,
                    None,
                    block.span().end,
                );
            } else {
                let start = result.leaves.len();
                result.leaves.push(Leaf {
                    id: LeafId {
                        block: Some(block.id()),
                        path: vec![0],
                        blank: 0,
                    },
                    kind: NodeKind::Atom,
                    text: "\u{fffc}".into(),
                    runs: vec![],
                    span: block.span(),
                    logical: 0..0,
                    scalars: vec![(0, block.span())],
                    indent: 0,
                    quote: false,
                    marker: None,
                    task: None,
                });
                result.rows.push(Row {
                    leaves: start..start + 1,
                    table: None,
                });
            }
        }
        // Markdown has no node for a new empty paragraph. Keep its source caret as
        // a view-only leaf, including the landing place following the final atom.
        for caret in [head, anchor] {
            let needs_blank = result.leaves.is_empty()
                || !result
                    .leaves
                    .iter()
                    .any(|l| l.span.start <= caret && caret <= l.span.end);
            if needs_blank
                && !document
                    .blocks()
                    .iter()
                    .any(|b| b.span().start < caret && caret < b.span().end)
            {
                let row_ix = result
                    .rows
                    .iter()
                    .position(|r| result.leaves[r.leaves.start].span.start >= caret)
                    .unwrap_or(result.rows.len());
                let leaf_ix = result
                    .rows
                    .get(row_ix)
                    .map_or(result.leaves.len(), |r| r.leaves.start);
                result.leaves.insert(
                    leaf_ix,
                    Leaf {
                        id: LeafId {
                            block: None,
                            path: vec![0],
                            blank: caret,
                        },
                        kind: NodeKind::Paragraph,
                        text: String::new(),
                        runs: vec![],
                        span: caret..caret,
                        logical: 0..0,
                        scalars: vec![],
                        indent: 0,
                        quote: false,
                        marker: None,
                        task: None,
                    },
                );
                for row in result.rows.iter_mut().skip(row_ix) {
                    row.leaves.start += 1;
                    row.leaves.end += 1;
                }
                result.rows.insert(
                    row_ix,
                    Row {
                        leaves: leaf_ix..leaf_ix + 1,
                        table: None,
                    },
                );
            }
        }
        for (ix, leaf) in result.leaves.iter_mut().enumerate() {
            if ix > 0 {
                result.text.push('\n');
            }
            leaf.logical = result.text.len()..result.text.len() + leaf.text.len();
            result.text.push_str(&leaf.text);
        }
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn walk(
        &mut self,
        node: &StructureNode,
        ast: Option<&Ast>,
        block: BlockId,
        path: Vec<usize>,
        base: usize,
        source: &str,
        indent: usize,
        quote: bool,
        marker: Option<String>,
        task: Option<(Vec<usize>, bool)>,
        fallback: usize,
    ) {
        match node.kind() {
            NodeKind::Paragraph | NodeKind::Heading(_) | NodeKind::Cell | NodeKind::Code { .. } => {
                let text = node.text();
                let span = node.span().unwrap_or(fallback..fallback);
                let mut scalars = vec![];
                if let Some(ast) = ast {
                    map_ast(ast, base, source, &mut 0, &mut scalars);
                }
                let ix = self.leaves.len();
                self.leaves.push(Leaf {
                    id: LeafId {
                        block: Some(block),
                        path,
                        blank: 0,
                    },
                    kind: node.kind().clone(),
                    text,
                    runs: node.runs().to_vec(),
                    span,
                    logical: 0..0,
                    scalars,
                    indent,
                    quote,
                    marker,
                    task,
                });
                if node.kind() != &NodeKind::Cell {
                    self.rows.push(Row {
                        leaves: ix..ix + 1,
                        table: None,
                    });
                }
            }
            NodeKind::Table => {
                let columns = node.children().first().map_or(0, |r| r.children().len());
                for (row_ix, row) in node.children().iter().enumerate() {
                    let start = self.leaves.len();
                    let row_ast = ast.and_then(Ast::children).and_then(|v| v.get(row_ix));
                    for (col, cell) in row.children().iter().enumerate() {
                        self.walk(
                            cell,
                            row_ast.and_then(Ast::children).and_then(|v| v.get(col)),
                            block,
                            [path.clone(), vec![row_ix, col]].concat(),
                            base,
                            source,
                            indent,
                            quote,
                            None,
                            None,
                            row.span().map_or(fallback, |s| s.end),
                        );
                    }
                    self.rows.push(Row {
                        leaves: start..self.leaves.len(),
                        table: Some((block, path.clone(), row_ix, node.children().len(), columns)),
                    });
                }
            }
            NodeKind::Rule => {
                let ix = self.leaves.len();
                let span = node.span().unwrap_or(fallback..fallback);
                self.leaves.push(Leaf {
                    id: LeafId {
                        block: Some(block),
                        path,
                        blank: 0,
                    },
                    kind: NodeKind::Rule,
                    text: "\u{fffc}".into(),
                    runs: vec![],
                    scalars: vec![(0, span.clone())],
                    span,
                    logical: 0..0,
                    indent,
                    quote,
                    marker,
                    task,
                });
                self.rows.push(Row {
                    leaves: ix..ix + 1,
                    table: None,
                });
            }
            _ => {
                for (ix, child) in node.children().iter().enumerate() {
                    let child_path = [path.clone(), vec![ix]].concat();
                    let marker = match node.kind() {
                        NodeKind::List { ordered, start } => Some(if *ordered {
                            format!("{}.", *start as usize + ix)
                        } else {
                            "•".into()
                        }),
                        _ if ix == 0 => marker.clone(),
                        _ => None,
                    };
                    let task = match node.kind() {
                        NodeKind::Item {
                            checked: Some(checked),
                        } if ix == 0 => Some((path.clone(), *checked)),
                        _ => task.clone(),
                    };
                    self.walk(
                        child,
                        ast.and_then(Ast::children).and_then(|v| v.get(ix)),
                        block,
                        child_path,
                        base,
                        source,
                        indent + usize::from(matches!(node.kind(), NodeKind::List { .. })),
                        quote || node.kind() == &NodeKind::Quote,
                        marker,
                        task,
                        node.span().map_or(fallback, |s| s.end),
                    );
                }
            }
        }
    }
    pub fn at(&self, offset: usize) -> (usize, usize) {
        let ix = self
            .leaves
            .iter()
            .position(|l| offset <= l.logical.end)
            .unwrap_or(self.leaves.len() - 1);
        (
            ix,
            offset
                .saturating_sub(self.leaves[ix].logical.start)
                .min(self.leaves[ix].text.len()),
        )
    }
    pub fn source_at(&self, offset: usize) -> usize {
        let (ix, byte) = self.at(offset);
        self.leaves[ix].source_at(byte)
    }
    pub fn logical_at(&self, source: usize) -> usize {
        let leaf = self
            .leaves
            .iter()
            .filter(|l| l.span.start <= source && source <= l.span.end)
            .min_by_key(|l| l.span.len())
            .or_else(|| self.leaves.iter().find(|l| l.span.start >= source))
            .unwrap_or_else(|| self.leaves.last().unwrap());
        leaf.logical.start + leaf.byte_at(source)
    }
    pub fn row_for(&self, leaf: usize) -> usize {
        self.rows
            .iter()
            .position(|r| r.leaves.contains(&leaf))
            .unwrap_or(0)
    }
}

fn map_ast(
    node: &Ast,
    base: usize,
    source: &str,
    logical: &mut usize,
    out: &mut Vec<(usize, Range<usize>)>,
) {
    let Some(position) = node.position() else {
        return;
    };
    let span = base + position.start.offset..base + position.end.offset;
    match node {
        Ast::Text(text) => map_text(
            &source[span.clone()],
            span.start,
            &text.value,
            logical,
            out,
            false,
        ),
        Ast::InlineCode(code) => {
            let raw = &source[span.clone()];
            let ticks = raw.bytes().take_while(|c| *c == b'`').count();
            let mut content = &raw[ticks..raw.len().saturating_sub(ticks)];
            let mut start = span.start + ticks;
            if content.starts_with(' ')
                && content.ends_with(' ')
                && !content.chars().all(|c| c == ' ')
            {
                content = &content[1..content.len() - 1];
                start += 1;
            }
            map_text(content, start, &code.value, logical, out, true);
        }
        Ast::Code(code) => {
            let raw = &source[span.clone()];
            let prefix = if raw.starts_with("```") || raw.starts_with("~~~") {
                raw.find('\n').map_or(raw.len(), |p| p + 1)
            } else {
                0
            };
            map_text(
                &raw[prefix..],
                span.start + prefix,
                &code.value.replace("\r\n", "\n"),
                logical,
                out,
                true,
            );
        }
        Ast::Break(_) => {
            out.push((*logical, span));
            *logical += 1;
        }
        _ => {
            for child in node.children().into_iter().flatten() {
                map_ast(child, base, source, logical, out);
            }
        }
    }
}
fn map_text(
    raw: &str,
    base: usize,
    decoded: &str,
    logical: &mut usize,
    out: &mut Vec<(usize, Range<usize>)>,
    literal: bool,
) {
    let mut source_ix = 0;
    let mut decoded_ix = 0;
    while decoded_ix < decoded.len() && source_ix < raw.len() {
        let tail = &raw[source_ix..];
        if !literal
            && tail.starts_with('&')
            && let Some(end) = tail.find(';').filter(|end| *end <= 34)
        {
            let entity = &tail[1..end];
            let value = if let Some(hex) = entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
            {
                Some(markdown::decode_numeric(hex, 16))
            } else if let Some(decimal) = entity.strip_prefix('#') {
                Some(markdown::decode_numeric(decimal, 10))
            } else {
                markdown::decode_named(entity, true)
            };
            if let Some(value) = value
                && decoded[decoded_ix..].starts_with(&value)
            {
                for (at, _) in value.char_indices() {
                    out.push((*logical + at, base + source_ix..base + source_ix + end + 1));
                }
                source_ix += end + 1;
                decoded_ix += value.len();
                *logical += value.len();
                continue;
            }
        }
        let actual = decoded[decoded_ix..].chars().next().unwrap();
        let ch = tail.chars().next().unwrap();
        let length = if tail.starts_with("\r\n") {
            2
        } else {
            ch.len_utf8()
        };
        if ch == actual || (matches!(ch, '\r' | '\n') && matches!(actual, '\n' | ' ')) {
            out.push((*logical, base + source_ix..base + source_ix + length));
            decoded_ix += actual.len_utf8();
            *logical += actual.len_utf8();
        }
        source_ix += length;
    }
}
