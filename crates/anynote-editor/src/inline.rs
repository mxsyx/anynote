//! Rich inline commands normalize only the selected paragraph/heading/cell's inline content.
//! Ranges address decoded text, so Markdown delimiters and encoded entities are not cursor characters.
use crate::{
    model::{BlockId, Document},
    selection::{Affinity, Position, Selection, TextUnit, byte_range},
    transaction::{EditError, EditKind, Patch, Transaction},
};
use anynote_core::protocol::rich::{Content, MarkdownNode as Node};
use std::ops::Range;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mark {
    Strong,
    Emphasis,
    Strike,
    Code,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Link {
    url: String,
    title: Option<String>,
}
impl Link {
    pub fn new(url: String, title: Option<String>) -> Result<Self, EditError> {
        if url.is_empty() || url.chars().any(char::is_control) || url.trim() != url {
            return Err(EditError::InvalidLink);
        }
        if let Some((scheme, _)) = url.split_once(':')
            && !scheme.contains(['/', '?', '#'])
            && !matches!(
                scheme.to_ascii_lowercase().as_str(),
                "https" | "http" | "mailto" | "tel" | "anynote" | "anynote-resource"
            )
        {
            return Err(EditError::InvalidLink);
        }
        Ok(Self { url, title })
    }
    pub fn url(&self) -> &str {
        &self.url
    }
    pub fn title(&self) -> Option<&str> {
        self.title.as_deref()
    }
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Marks {
    strong: bool,
    emphasis: bool,
    strike: bool,
    code: bool,
    link: Option<Link>,
}
impl Marks {
    pub fn with_mark(mut self, mark: Mark, enabled: bool) -> Self {
        self.set(mark, enabled);
        self
    }
    pub fn with_link(mut self, link: Option<Link>) -> Self {
        self.link = link;
        self
    }
    pub fn has(&self, mark: Mark) -> bool {
        match mark {
            Mark::Strong => self.strong,
            Mark::Emphasis => self.emphasis,
            Mark::Strike => self.strike,
            Mark::Code => self.code,
        }
    }
    pub fn link(&self) -> Option<&Link> {
        self.link.as_ref()
    }
    fn set(&mut self, mark: Mark, value: bool) {
        match mark {
            Mark::Strong => self.strong = value,
            Mark::Emphasis => self.emphasis = value,
            Mark::Strike => self.strike = value,
            Mark::Code => self.code = value,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Run {
    text: String,
    marks: Marks,
    hard_break: bool,
}
impl Run {
    pub(crate) fn literal(text: String, marks: Marks) -> Self {
        Self {
            text,
            marks,
            hard_break: false,
        }
    }
    pub fn text(&self) -> &str {
        &self.text
    }
    pub fn marks(&self) -> &Marks {
        &self.marks
    }
    pub fn is_hard_break(&self) -> bool {
        self.hard_break
    }
}
#[derive(Clone, Debug)]
pub enum Format {
    Mark(Mark, bool),
    Link(Option<Link>),
}

/// A versioned inline projection. Use its logical text coordinates for rich operations.
#[derive(Debug)]
pub struct InlineContent {
    generation: u64,
    block: BlockId,
    span: Range<usize>,
    expected: String,
    runs: Vec<Run>,
    table: bool,
    newline: &'static str,
}
impl InlineContent {
    pub fn for_block(document: &Document, id: BlockId) -> Result<Vec<Self>, EditError> {
        let block = document
            .block(id)
            .ok_or(crate::source::SourceError::Stale)?;
        if !block.parsed().is_editable() {
            return Err(EditError::UnsupportedInline);
        }
        let Content::Markdown { node, source_base } = block.parsed().content() else {
            return Err(EditError::UnsupportedInline);
        };
        let mut contents = Vec::new();
        collect(document, id, node, *source_base, &mut contents)?;
        Ok(contents)
    }
    pub fn block(&self) -> BlockId {
        self.block
    }
    pub fn span(&self) -> Range<usize> {
        self.span.clone()
    }
    pub fn runs(&self) -> &[Run] {
        &self.runs
    }
    pub fn text(&self) -> String {
        self.runs.iter().map(|run| run.text.as_str()).collect()
    }
    pub fn format(
        &self,
        range: Range<usize>,
        unit: TextUnit,
        format: Format,
        millis: u64,
    ) -> Result<Transaction, EditError> {
        let text = self.text();
        let range = byte_range(&text, range, unit)?;
        if range.is_empty() {
            return Err(EditError::UnsupportedInline);
        }
        let mut runs = split_runs(&self.runs, range.start);
        runs = split_runs(&runs, range.end);
        let mut offset = 0;
        for run in &mut runs {
            let selected = offset >= range.start && offset + run.text.len() <= range.end;
            offset += run.text.len();
            if !selected {
                continue;
            }
            match &format {
                Format::Mark(mark, enabled) => {
                    if *mark == Mark::Code
                        && *enabled
                        && (run.hard_break || run.text.contains(['\r', '\n']))
                    {
                        return Err(EditError::UnsupportedInline);
                    }
                    run.marks.set(*mark, *enabled);
                }
                Format::Link(link) => run.marks.link = link.clone(),
            }
        }
        self.transaction(normalize(runs), range, EditKind::Format, millis)
    }
    /// Literal rich text is encoded before entering the same source patch/history path.
    pub fn replace(
        &self,
        range: Range<usize>,
        unit: TextUnit,
        text: &str,
        marks: Marks,
        millis: u64,
    ) -> Result<Transaction, EditError> {
        let original = self.text();
        let range = byte_range(&original, range, unit)?;
        let runs = split_runs(&split_runs(&self.runs, range.start), range.end);
        let mut result = Vec::new();
        let mut offset = 0;
        let mut inserted = false;
        for run in runs {
            if !inserted && offset >= range.start {
                result.push(Run {
                    text: text.to_owned(),
                    marks: marks.clone(),
                    hard_break: false,
                });
                inserted = true;
            }
            let end = offset + run.text.len();
            if end <= range.start || offset >= range.end {
                result.push(run);
            }
            offset = end;
        }
        if !inserted {
            result.push(Run {
                text: text.to_owned(),
                marks,
                hard_break: false,
            });
        }
        let caret = range.start + text.len();
        self.transaction(normalize(result), caret..caret, EditKind::Source, millis)
    }
    fn transaction(
        &self,
        runs: Vec<Run>,
        selection: Range<usize>,
        kind: EditKind,
        millis: u64,
    ) -> Result<Transaction, EditError> {
        if runs == self.runs {
            return Ok(Transaction::new(self.generation, Vec::new(), kind, millis));
        }
        let mut output = Encoded {
            table: self.table,
            newline: self.newline,
            ..Encoded::default()
        };
        encode(&runs, 0, &mut output)?;
        // Reparse generated syntax and compare semantics, including marks and links, before returning a patch.
        let check = Document::new(if self.table {
            format!("| {} |\n| --- |", output.text)
        } else {
            output.text.clone()
        });
        let decoded = check
            .blocks()
            .first()
            .filter(|_| check.blocks().len() == 1)
            .and_then(|block| Self::for_block(&check, block.id()).ok());
        if !runs.is_empty()
            && decoded
                .as_ref()
                .is_none_or(|contents| contents.len() != 1 || contents[0].runs != runs)
        {
            return Err(EditError::UnsupportedInline);
        }
        let start = output.start_offset(selection.start)?;
        let end = output.end_offset(selection.end)?;
        let selected = if selection.is_empty() {
            Selection::caret(self.generation, self.span.start + start)
        } else {
            Selection::new(
                self.generation,
                Position::new(self.span.start + start, Affinity::Before),
                Position::new(self.span.start + end, Affinity::After),
            )
        };
        let local = crate::transaction::difference(&self.expected, &output.text);
        let patch = Patch::new(
            self.span.start + local.range().start..self.span.start + local.range().end,
            local.removed(),
            local.inserted(),
        );
        Ok(Transaction::new(self.generation, vec![patch], kind, millis).with_selection(selected))
    }
}

fn collect(
    document: &Document,
    block: BlockId,
    node: &Node,
    base: usize,
    result: &mut Vec<InlineContent>,
) -> Result<(), EditError> {
    if matches!(
        node,
        Node::Paragraph(_) | Node::Heading(_) | Node::TableCell(_)
    ) {
        let children = node.children().ok_or(EditError::UnsupportedInline)?;
        let (Some(first), Some(last)) = (children.first(), children.last()) else {
            return Ok(());
        };
        let span = base + first.position().unwrap().start.offset
            ..base + last.position().unwrap().end.offset;
        let mut runs = Vec::new();
        for child in children {
            flatten(child, &Marks::default(), &mut runs)?;
        }
        result.push(InlineContent {
            generation: document.generation(),
            block,
            expected: document.source()[span.clone()].to_owned(),
            span,
            runs: normalize(runs),
            table: matches!(node, Node::TableCell(_)),
            newline: crate::source::newline_at(
                document.source(),
                base + first.position().unwrap().start.offset,
            )?,
        });
    } else if let Some(children) = node.children() {
        for child in children {
            collect(document, block, child, base, result)?;
        }
    }
    Ok(())
}
pub(crate) fn flatten(
    node: &Node,
    inherited: &Marks,
    runs: &mut Vec<Run>,
) -> Result<(), EditError> {
    let mut marks = inherited.clone();
    match node {
        Node::Text(text) => {
            runs.push(Run {
                text: text.value.clone(),
                marks,
                hard_break: false,
            });
            return Ok(());
        }
        Node::InlineCode(code) => {
            marks.code = true;
            runs.push(Run {
                text: code.value.clone(),
                marks,
                hard_break: false,
            });
            return Ok(());
        }
        Node::Break(_) => {
            runs.push(Run {
                text: "\n".into(),
                marks,
                hard_break: true,
            });
            return Ok(());
        }
        Node::Strong(_) => marks.strong = true,
        Node::Emphasis(_) => marks.emphasis = true,
        Node::Delete(_) => marks.strike = true,
        Node::Link(link) => {
            marks.link = Some(Link {
                url: link.url.clone(),
                title: link.title.clone(),
            })
        }
        _ => return Err(EditError::UnsupportedInline),
    }
    for child in node.children().ok_or(EditError::UnsupportedInline)? {
        flatten(child, &marks, runs)?;
    }
    Ok(())
}
pub(crate) fn normalize(runs: Vec<Run>) -> Vec<Run> {
    let mut result: Vec<Run> = Vec::new();
    for run in runs.into_iter().filter(|run| !run.text.is_empty()) {
        if let Some(last) = result.last_mut()
            && !last.hard_break
            && !run.hard_break
            && last.marks == run.marks
        {
            last.text.push_str(&run.text);
        } else {
            result.push(run);
        }
    }
    result
}
pub(crate) fn split_runs(runs: &[Run], at: usize) -> Vec<Run> {
    let mut result = Vec::new();
    let mut offset = 0;
    for run in runs {
        let end = offset + run.text.len();
        if offset < at && at < end {
            let mut first = run.clone();
            first.text = run.text[..at - offset].to_owned();
            result.push(first);
            let mut last = run.clone();
            last.text = run.text[at - offset..].to_owned();
            result.push(last);
        } else {
            result.push(run.clone());
        }
        offset = end;
    }
    result
}

#[derive(Default)]
struct Encoded {
    text: String,
    positions: Vec<(usize, usize, usize)>,
    logical: usize,
    table: bool,
    newline: &'static str,
}

/// Shared by structural serialization; the offset addresses decoded UTF-8 text.
pub(crate) fn encode_fragment(
    runs: &[Run],
    table: bool,
    newline: &'static str,
    caret: Option<usize>,
) -> Result<(String, Option<usize>), EditError> {
    let mut output = Encoded {
        table,
        newline,
        ..Encoded::default()
    };
    encode(runs, 0, &mut output)?;
    let caret = caret.map(|at| output.start_offset(at)).transpose()?;
    Ok((output.text, caret))
}
impl Encoded {
    fn start_offset(&self, at: usize) -> Result<usize, EditError> {
        if at == self.logical {
            return self.end_offset(at);
        }
        self.positions
            .iter()
            .find(|(offset, _, _)| *offset == at)
            .map(|(_, start, _)| *start)
            .ok_or(crate::source::SourceError::InvalidRange.into())
    }
    fn end_offset(&self, at: usize) -> Result<usize, EditError> {
        if at == 0 {
            return Ok(self.positions.first().map_or(0, |(_, start, _)| *start));
        }
        self.positions
            .iter()
            .rev()
            .find(|(offset, _, _)| *offset < at)
            .map(|(_, _, end)| *end)
            .ok_or(crate::source::SourceError::InvalidRange.into())
    }
    // Entity boundaries keep adjacent emphasis/strong runs unambiguous without inserting visible text.
    // They also avoid the existing rich parser's backslash-escape safety fallback.
    fn character(&mut self, ch: char, literal: bool, boundary: bool) {
        let start = self.text.len();
        if !literal && (boundary || ch.is_ascii_punctuation() || ch.is_whitespace()) {
            self.text.push_str(&format!("&#{};", ch as u32));
        } else {
            if literal && self.table && ch == '|' {
                self.text.push('\\');
            }
            self.text.push(ch);
        }
        self.positions.push((self.logical, start, self.text.len()));
        self.logical += ch.len_utf8();
    }
}
fn same_layer(a: &Marks, b: &Marks, layer: usize) -> bool {
    match layer {
        0 => a.link == b.link,
        1 => a.strong == b.strong,
        2 => a.emphasis == b.emphasis,
        3 => a.strike == b.strike,
        _ => a.code == b.code,
    }
}
fn encode(runs: &[Run], layer: usize, output: &mut Encoded) -> Result<(), EditError> {
    let mut start = 0;
    while start < runs.len() {
        let mut end = start + 1;
        while end < runs.len() && same_layer(&runs[start].marks, &runs[end].marks, layer) {
            end += 1;
        }
        let group = &runs[start..end];
        let marks = &runs[start].marks;
        let delimiter = match layer {
            1 if marks.strong => "**",
            2 if marks.emphasis => "_",
            3 if marks.strike => "~~",
            _ => "",
        };
        if layer == 0 && marks.link.is_some() {
            output.text.push('[');
        }
        output.text.push_str(delimiter);
        if layer < 4 {
            encode(group, layer + 1, output)?;
        } else if marks.code {
            let text: String = group.iter().map(|run| run.text.as_str()).collect();
            if text.contains(['\r', '\n']) {
                return Err(EditError::UnsupportedInline);
            }
            let longest = text.split(|ch| ch != '`').map(str::len).max().unwrap_or(0);
            let fence = "`".repeat(longest + 1);
            let pad = text.starts_with('`')
                || text.ends_with('`')
                || (text.starts_with(' ')
                    && text.ends_with(' ')
                    && !text.chars().all(|ch| ch == ' '));
            output.text.push_str(&fence);
            if pad {
                output.text.push(' ');
            }
            for ch in text.chars() {
                output.character(ch, true, false);
            }
            if pad {
                output.text.push(' ');
            }
            output.text.push_str(&fence);
        } else {
            for run in group {
                if run.hard_break {
                    let start = output.text.len();
                    output.text.push('\\');
                    output.text.push_str(output.newline);
                    output
                        .positions
                        .push((output.logical, start, output.text.len()));
                    output.logical += 1;
                } else {
                    for (ix, ch) in run.text.char_indices() {
                        output.character(
                            ch,
                            false,
                            ix == 0 || ix + ch.len_utf8() == run.text.len(),
                        );
                    }
                }
            }
        }
        output.text.push_str(delimiter);
        if layer == 0
            && let Some(link) = &marks.link
        {
            output.text.push_str("](<");
            output.text.push_str(&attribute(&link.url));
            output.text.push('>');
            if let Some(title) = &link.title {
                output.text.push_str(" \"");
                output.text.push_str(&attribute(title));
                output.text.push('"');
            }
            output.text.push(')');
        }
        start = end;
    }
    Ok(())
}
fn attribute(text: &str) -> String {
    text.chars()
        .map(|ch| {
            if matches!(ch, '&' | '<' | '>' | '"' | '\\' | '|') || ch.is_control() {
                format!("&#{};", ch as u32)
            } else {
                ch.to_string()
            }
        })
        .collect()
}
