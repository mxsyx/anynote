use super::markdown::{Directive, parse_blocks};
use markdown::{
    ParseOptions,
    mdast::{AlignKind, Node},
};
use regex::Regex;
use std::{ops::Range, sync::LazyLock};

pub use markdown::mdast::Node as MarkdownNode;
pub const MAX_RICH_UTF16: usize = 500_000;
pub const MAX_BLOCK_NODES: usize = 5_000;
static ESCAPED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\[[:punct:]]").unwrap());
static FOOTNOTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[\^[^\]]+\]").unwrap());

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpaqueReason {
    Extension,
    Oversize,
    Footnote,
    Escape,
    Html,
    Reference,
    AlignedTable,
    CodeMeta,
    Budget,
    Unsupported,
}
impl OpaqueReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Extension => "extension",
            Self::Oversize => "oversize",
            Self::Footnote => "footnote",
            Self::Escape => "escape",
            Self::Html => "html",
            Self::Reference => "reference",
            Self::AlignedTable => "aligned-table",
            Self::CodeMeta => "code-meta",
            Self::Budget => "budget",
            Self::Unsupported => "unsupported",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Content {
    /// Node positions are relative to `source_base`, in UTF-8 bytes.
    Markdown {
        node: Box<MarkdownNode>,
        source_base: usize,
    },
    Directive(Directive),
    Opaque,
}
#[derive(Clone, Debug, PartialEq)]
pub struct RichBlock {
    span: Range<usize>,
    content: Content,
    reason: Option<OpaqueReason>,
}
impl RichBlock {
    pub fn span(&self) -> Range<usize> {
        self.span.clone()
    }
    pub fn content(&self) -> &Content {
        &self.content
    }
    pub fn reason(&self) -> Option<OpaqueReason> {
        self.reason
    }
    pub fn is_editable(&self) -> bool {
        self.reason.is_none()
    }
}

/// Preserve the existing CommonMark + GFM rich-edit safety boundary.
pub fn rich_blocks(source: &str) -> Vec<RichBlock> {
    if source.encode_utf16().count() > MAX_RICH_UTF16 {
        return vec![RichBlock {
            span: 0..source.len(),
            content: Content::Opaque,
            reason: Some(OpaqueReason::Oversize),
        }];
    }
    let mut result = Vec::new();
    for segment in parse_blocks(source) {
        let span = segment.span();
        if let Some(directive) = segment.directive() {
            result.push(RichBlock {
                span,
                content: Content::Directive(directive.clone()),
                reason: Some(OpaqueReason::Extension),
            });
            continue;
        }
        let text = &source[span.clone()];
        let Ok(Node::Root(root)) = markdown::to_mdast(text, &ParseOptions::gfm()) else {
            result.push(RichBlock {
                span,
                content: Content::Opaque,
                reason: Some(OpaqueReason::Unsupported),
            });
            continue;
        };
        for node in root.children {
            let position = node
                .position()
                .expect("Markdown nodes have source positions");
            let mut range = span.start + position.start.offset..span.start + position.end.offset;
            // remark excludes paragraph indentation; keep it in the source separator too.
            if matches!(node, Node::Paragraph(_)) {
                let raw = &source[range.clone()];
                range.start += raw.len() - raw.trim_start_matches([' ', '\t']).len();
            }
            let reason = inspect(&node, text).or_else(|| {
                FOOTNOTE
                    .is_match(&source[range.clone()])
                    .then_some(OpaqueReason::Footnote)
            });
            result.push(RichBlock {
                span: range,
                content: Content::Markdown {
                    node: Box::new(node),
                    source_base: span.start,
                },
                reason,
            });
        }
    }
    result
}

fn inspect(root: &Node, source: &str) -> Option<OpaqueReason> {
    let mut stack = vec![root];
    let mut count = 0;
    while let Some(node) = stack.pop() {
        count += 1;
        if count > MAX_BLOCK_NODES {
            return Some(OpaqueReason::Budget);
        }
        match node {
            Node::Table(table) if table.align.iter().any(|a| *a != AlignKind::None) => {
                return Some(OpaqueReason::AlignedTable);
            }
            Node::Code(code) if code.meta.as_ref().is_some_and(|s| !s.is_empty()) => {
                return Some(OpaqueReason::CodeMeta);
            }
            Node::Html(_) => return Some(OpaqueReason::Html),
            Node::Definition(_) | Node::LinkReference(_) | Node::ImageReference(_) => {
                return Some(OpaqueReason::Reference);
            }
            Node::FootnoteDefinition(_) | Node::FootnoteReference(_) => {
                return Some(OpaqueReason::Footnote);
            }
            Node::Text(text) => {
                if let Some(p) = &text.position
                    && ESCAPED.is_match(&source[p.start.offset..p.end.offset])
                {
                    return Some(OpaqueReason::Escape);
                }
            }
            Node::Paragraph(_)
            | Node::Heading(_)
            | Node::Emphasis(_)
            | Node::Strong(_)
            | Node::InlineCode(_)
            | Node::Link(_)
            | Node::Break(_)
            | Node::Blockquote(_)
            | Node::List(_)
            | Node::ListItem(_)
            | Node::Code(_)
            | Node::ThematicBreak(_)
            | Node::Delete(_)
            | Node::Table(_)
            | Node::TableRow(_)
            | Node::TableCell(_) => {}
            _ => return Some(OpaqueReason::Unsupported),
        }
        if let Some(children) = node.children() {
            stack.extend(children);
        }
    }
    None
}
