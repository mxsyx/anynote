use super::projection::{Leaf, LeafId, Projection};
use anynote_editor::{
    history::HistoryBudget,
    inline::{Format, InlineContent, Mark, Marks},
    model::Document,
    selection::{Affinity, Position, Selection, TextRange, TextUnit, deletion_range},
    structure::{self, CellAddress, ListStyle, NodeKind, Structure},
    transaction::{EditKind, Editor, Patch, Transaction},
};
use std::{borrow::Cow, ops::Range, time::Instant};
use unicode_segmentation::UnicodeSegmentation;

pub(super) type Result<T> = std::result::Result<T, String>;
pub(super) fn error(value: impl std::fmt::Debug) -> String {
    format!("无法完成编辑：{value:?}")
}

pub(super) struct Composition {
    pub token: u64,
    pub range: Range<usize>,
    pub leaf: usize,
    pub last_leaf: usize,
    pub local_start: usize,
    pub local_end: usize,
}

pub(super) struct DocumentSession {
    pub save: Option<super::session::SaveController>,
    pub editor: Editor,
    pub projection: Projection,
    pub anchor: usize,
    pub head: usize,
    pub marks: Marks,
    pub composition: Option<Composition>,
    pub pending_task: Option<bool>,
    pending_after: Option<LeafId>,
    started: Instant,
}
impl DocumentSession {
    pub fn new(source: String) -> Self {
        let editor = Editor::new(Document::new(source), HistoryBudget::default());
        let projection = Projection::new(editor.document(), 0);
        Self {
            save: None,
            editor,
            projection,
            anchor: 0,
            head: 0,
            marks: Marks::default(),
            composition: None,
            pending_task: None,
            pending_after: None,
            started: Instant::now(),
        }
    }
    pub fn millis(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
    pub fn range(&self) -> Range<usize> {
        self.anchor.min(self.head)..self.anchor.max(self.head)
    }
    pub fn select(&mut self, anchor: usize, head: usize) -> Result<()> {
        let text = &self.projection.text;
        if !text.is_char_boundary(anchor) || !text.is_char_boundary(head) {
            return Err("无效文本位置".into());
        }
        self.editor
            .set_selection(Selection::new(
                self.editor.document().generation(),
                Position::new(self.projection.source_at(anchor), Affinity::Before),
                Position::new(self.projection.source_at(head), Affinity::After),
            ))
            .map_err(error)?;
        let cancel_pending =
            self.pending_task.is_some() && (anchor != self.anchor || head != self.head);
        self.anchor = anchor;
        self.head = head;
        if cancel_pending {
            self.pending_task = None;
            self.pending_after = None;
            self.refresh();
        }
        let (ix, at) = self.projection.at(self.head);
        let mut offset = 0;
        self.marks = self.projection.leaves[ix]
            .runs
            .iter()
            .find_map(|r| {
                offset += r.text().len();
                (at <= offset).then(|| r.marks().clone())
            })
            .unwrap_or_default();
        Ok(())
    }
    pub fn refresh(&mut self) {
        self.projection = Projection::new(
            self.editor.document(),
            self.editor.selection().head().offset(),
        );
        self.anchor = self
            .projection
            .logical_at(self.editor.selection().anchor().offset());
        self.head = self
            .projection
            .logical_at(self.editor.selection().head().offset());
    }
    pub fn apply(&mut self, transaction: Transaction) -> Result<()> {
        self.editor.apply(transaction).map_err(error)?;
        self.refresh();
        Ok(())
    }
    fn structure<'a>(&'a self, leaf: &Leaf) -> Result<Structure<'a>> {
        match leaf.id.block {
            Some(id) => Structure::for_block(self.editor.document(), id),
            None => Structure::at_caret(
                self.editor.document(),
                Selection::caret(self.editor.document().generation(), leaf.span.start),
            ),
        }
        .map_err(error)
    }
    fn prepare_replace(&self, ix: usize, range: Range<usize>, text: &str) -> Result<Transaction> {
        let leaf = &self.projection.leaves[ix];
        if let Some(checked) = self.pending_task {
            return if let Some(after) = &self.pending_after {
                Structure::for_block(self.editor.document(), after.block.ok_or("没有任务块")?)
                    .map_err(error)?
                    .insert_task_after(
                        &after.path[..after.path.len() - 1],
                        text,
                        self.marks.clone(),
                        checked,
                        self.millis(),
                    )
            } else {
                self.structure(leaf)?.insert_task_text(
                    &leaf.id.path,
                    text,
                    self.marks.clone(),
                    checked,
                    self.millis(),
                )
            }
            .map_err(error);
        }
        if matches!(leaf.kind, NodeKind::Atom | NodeKind::Rule) {
            if range == (0..leaf.text.len()) && text.is_empty() {
                let source = self.editor.document().source();
                return Ok(Transaction::new(
                    self.editor.document().generation(),
                    vec![Patch::new(
                        leaf.span.clone(),
                        &source[leaf.span.clone()],
                        "",
                    )],
                    EditKind::Format,
                    self.millis(),
                )
                .with_selection(Selection::caret(
                    self.editor.document().generation(),
                    leaf.span.start,
                )));
            }
            return Err("请在块前后输入，或通过原文编辑此块".into());
        }
        if matches!(leaf.kind, NodeKind::Code { .. }) {
            return self
                .structure(leaf)?
                .replace_code(&leaf.id.path, range, text, self.millis())
                .map_err(error);
        }
        if let Some(id) = leaf.id.block
            && let Ok(contents) = InlineContent::for_block(self.editor.document(), id)
            && let Some(content) = contents.into_iter().find(|c| {
                let s = c.span();
                leaf.span.start <= s.start && s.end <= leaf.span.end
            })
        {
            return content
                .replace(
                    range,
                    TextUnit::Utf8,
                    text,
                    self.marks.clone(),
                    self.millis(),
                )
                .map_err(error);
        }
        self.structure(leaf)?
            .replace_text(
                &leaf.id.path,
                range,
                TextUnit::Utf8,
                text,
                self.marks.clone(),
                self.millis(),
            )
            .map_err(error)
    }
    pub fn replace(&mut self, text: &str) -> Result<()> {
        if self.pending_task.is_some() {
            if !text.is_empty() {
                let (ix, at) = self.projection.at(self.head);
                let tx = self.prepare_replace(ix, at..at, text)?;
                self.editor.apply(tx).map_err(error)?;
            }
            self.pending_task = None;
            self.pending_after = None;
            self.refresh();
            return Ok(());
        }
        let range = self.range();
        let (first, start) = self.projection.at(range.start);
        let (last, end) = self.projection.at(range.end);
        if first != last {
            let transaction = self.prepare_replace_across(first, start, last, end, text)?;
            return self.apply(transaction);
        }
        let leaf = &self.projection.leaves[first];
        if text == " "
            && range.is_empty()
            && end == leaf.text.len()
            && leaf.kind == NodeKind::Paragraph
        {
            let prefix = format!("{} ", leaf.text);
            if matches!(
                prefix.as_str(),
                "# " | "## "
                    | "### "
                    | "#### "
                    | "##### "
                    | "###### "
                    | "> "
                    | "- "
                    | "* "
                    | "1. "
                    | "[] "
                    | "[ ] "
            ) {
                if matches!(prefix.as_str(), "[] " | "[ ] ") {
                    let tx = self.prepare_replace(first, 0..end, "")?;
                    self.apply(tx)?;
                    self.pending_task = Some(false);
                    return Ok(());
                }
                let tx = self
                    .structure(leaf)?
                    .input_rule(&leaf.id.path, &prefix, self.millis())
                    .map_err(error)?;
                return self.apply(tx);
            }
        }
        let transaction = self.prepare_replace(first, start..end, text)?;
        self.apply(transaction.with_kind(EditKind::RichTyping))
    }
    fn prepare_replace_across(
        &self,
        first: usize,
        start: usize,
        last: usize,
        end: usize,
        text: &str,
    ) -> Result<Transaction> {
        let a = &self.projection.leaves[first];
        let b = &self.projection.leaves[last];
        // A whole-document plain replacement has no surviving structural container.
        let doc = self.editor.document();
        if a.logical.start + start == 0 && b.logical.start + end == self.projection.text.len() {
            let blank = Document::new(String::new());
            let mut temporary = Editor::new(blank, HistoryBudget::default());
            let transaction = Structure::at_caret(temporary.document(), temporary.selection())
                .map_err(error)?
                .paste_plain(&[0], 0..0, TextUnit::Utf8, text, self.millis())
                .map_err(error)?;
            temporary.apply(transaction).map_err(error)?;
            let source = temporary.document().source().to_owned();
            let tx = Transaction::new(
                doc.generation(),
                vec![Patch::new(
                    0..doc.source().len(),
                    doc.source(),
                    source.clone(),
                )],
                EditKind::Paste,
                self.millis(),
            )
            .with_selection(Selection::caret(doc.generation(), source.len()));
            return Ok(tx);
        }
        if a.id.path == [0]
            && b.id.path == [0]
            && matches!(a.kind, NodeKind::Paragraph | NodeKind::Heading(_))
            && matches!(b.kind, NodeKind::Paragraph | NodeKind::Heading(_))
            && let (Some(first), Some(last)) = (a.id.block, b.id.block)
        {
            let tx = Structure::for_blocks(doc, first, last)
                .map_err(error)?
                .replace_between_blocks(start, end, text, self.marks.clone(), self.millis())
                .map_err(error)?;
            return Ok(tx);
        }
        let first = a.id.block.ok_or("没有起始块")?;
        let last = b.id.block.ok_or("没有结束块")?;
        let blocks = doc.blocks();
        let first_ix = blocks.iter().position(|block| block.id() == first).unwrap();
        let last_ix = blocks.iter().position(|block| block.id() == last).unwrap();
        let mut end_path = b.id.path.clone();
        end_path[0] = last_ix - first_ix;
        let tx = Structure::for_blocks(doc, first, last)
            .map_err(error)?
            .replace_between(
                (&a.id.path, start),
                (&end_path, end),
                text,
                self.marks.clone(),
                self.millis(),
            )
            .map_err(error)?;
        Ok(tx)
    }
    pub fn paste(&mut self, text: &str, markdown: bool) -> Result<()> {
        if self.pending_task.is_some() {
            return self.replace(text);
        }
        let range = self.range();
        let (ix, start) = self.projection.at(range.start);
        let (last, end) = self.projection.at(range.end);
        if ix != last {
            return self.replace(text);
        }
        let leaf = &self.projection.leaves[ix];
        if leaf.kind == NodeKind::Cell && text.contains(['\t', '\n']) {
            let path = &leaf.id.path[..leaf.id.path.len() - 2];
            let cell = CellAddress::new(
                leaf.id.path[leaf.id.path.len() - 2],
                *leaf.id.path.last().unwrap(),
            );
            let cells = text
                .replace("\r\n", "\n")
                .trim_end_matches('\n')
                .split('\n')
                .map(|r| r.split('\t').map(str::to_owned).collect())
                .collect::<Vec<_>>();
            let tx = self
                .structure(leaf)?
                .paste_cells(path, cell, &cells, self.millis())
                .map_err(error)?;
            return self.apply(tx);
        }
        if matches!(leaf.kind, NodeKind::Code { .. } | NodeKind::Cell) {
            return self.replace(text);
        }
        let structure = self.structure(leaf)?;
        let tx = if markdown {
            structure.paste(
                &leaf.id.path,
                start..end,
                TextUnit::Utf8,
                text,
                self.millis(),
            )
        } else {
            structure.paste_plain(
                &leaf.id.path,
                start..end,
                TextUnit::Utf8,
                text,
                self.millis(),
            )
        }
        .map_err(error)?;
        self.apply(tx)
    }
    pub fn delete(&mut self, backward: bool) -> Result<()> {
        if !self.range().is_empty() {
            return self.replace("");
        }
        let (ix, at) = self.projection.at(self.head);
        let leaf = &self.projection.leaves[ix];
        if backward && at == 0 && ix > 0 {
            let previous = &self.projection.leaves[ix - 1];
            if leaf.id.block == previous.id.block && leaf.id.path.len() > 1 {
                let path = if leaf.id.path.last() == Some(&0) {
                    &leaf.id.path[..leaf.id.path.len() - 1]
                } else {
                    &leaf.id.path
                };
                let tx = self
                    .structure(leaf)?
                    .join(path, self.millis())
                    .map_err(error)?;
                return self.apply(tx);
            }
            let range = previous.logical.end..leaf.logical.start;
            self.select(range.start, range.end)?;
            return self.replace("");
        }
        let range = deletion_range(&self.projection.text, self.head, backward).map_err(error)?;
        self.select(range.start, range.end)?;
        self.replace("")
    }
    pub fn enter(&mut self) -> Result<()> {
        if self.pending_task.take().is_some() {
            if let Some(after) = self.pending_after.take() {
                let offset = self
                    .editor
                    .document()
                    .block(after.block.unwrap())
                    .ok_or("块已变化")?
                    .span()
                    .end;
                let generation = self.editor.document().generation();
                return self.apply(
                    Transaction::new(
                        generation,
                        vec![Patch::new(offset..offset, "", "\n\n")],
                        EditKind::Format,
                        self.millis(),
                    )
                    .with_selection(Selection::caret(generation, offset + 2)),
                );
            }
            return Ok(());
        }
        if !self.range().is_empty() {
            self.replace("")?;
        }
        let (ix, at) = self.projection.at(self.head);
        let leaf = &self.projection.leaves[ix];
        if matches!(leaf.kind, NodeKind::Code { .. } | NodeKind::Cell) {
            return self.replace("\n");
        }
        if leaf.task.is_some() && at == leaf.text.len() {
            self.pending_after = Some(leaf.id.clone());
            self.pending_task = Some(false);
            let offset = leaf.span.end;
            self.editor
                .set_selection(Selection::caret(
                    self.editor.document().generation(),
                    offset,
                ))
                .map_err(error)?;
            let next = self.projection.insert_blank_after(ix);
            self.anchor = next;
            self.head = next;
            return Ok(());
        }
        if matches!(leaf.kind, NodeKind::Atom | NodeKind::Rule) {
            let offset = if at == 0 {
                leaf.span.start
            } else {
                leaf.span.end
            };
            let tx = Transaction::new(
                self.editor.document().generation(),
                vec![Patch::new(offset..offset, "", "\n\n")],
                EditKind::Typing,
                self.millis(),
            )
            .with_selection(Selection::caret(
                self.editor.document().generation(),
                if at == 0 { offset } else { offset + 2 },
            ));
            return self.apply(tx);
        }
        let tx = self
            .structure(leaf)?
            .split(&leaf.id.path, at, TextUnit::Utf8, self.millis())
            .map_err(error)?;
        self.apply(tx)
    }
    pub fn tab(&mut self, backward: bool) -> Result<()> {
        let (ix, _) = self.projection.at(self.head);
        let leaf = &self.projection.leaves[ix];
        let structure = self.structure(leaf)?;
        if leaf.kind == NodeKind::Cell {
            let path = &leaf.id.path[..leaf.id.path.len() - 2];
            let row = leaf.id.path[leaf.id.path.len() - 2];
            let col = *leaf.id.path.last().unwrap();
            if backward && row == 0 && col == 0 {
                if ix > 0 {
                    let at = self.projection.leaves[ix - 1].logical.end;
                    return self.select(at, at);
                }
                return Ok(());
            }
            let cell = CellAddress::new(row, col);
            let tx = structure
                .tab(path, cell, backward, self.millis())
                .map_err(error)?;
            self.apply(tx)?;
            // Empty ragged cells can share a source span. Preserve the logical cell
            // address for navigation even before an edit materializes that cell.
            let next = if backward {
                ix.saturating_sub(1)
            } else {
                ix + 1
            };
            if let Some(leaf) = self.projection.leaves.get(next) {
                let at = leaf.logical.start;
                self.select(at, at)?;
            }
            return Ok(());
        }
        if leaf.id.path.len() >= 3 {
            let item = &leaf.id.path[..leaf.id.path.len() - 1];
            let tx = if backward {
                structure.outdent(item, self.millis())
            } else {
                structure.indent(item, self.millis())
            }
            .map_err(error)?;
            self.apply(tx)
        } else {
            self.replace("\t")
        }
    }
    pub fn command(&mut self, name: &str) -> Result<()> {
        if self.composition.is_some() {
            return Err("请先完成当前输入".into());
        }
        if matches!(name, "undo" | "redo") && self.pending_task.take().is_some() {
            self.pending_after = None;
            self.refresh();
            return Ok(());
        }
        match name {
            "undo" => {
                self.editor.undo().map_err(error)?;
                self.refresh();
                return Ok(());
            }
            "redo" => {
                self.editor.redo().map_err(error)?;
                self.refresh();
                return Ok(());
            }
            "bold" | "italic" | "strike" | "inlineCode" => {
                let mark = match name {
                    "bold" => Mark::Strong,
                    "italic" => Mark::Emphasis,
                    "strike" => Mark::Strike,
                    _ => Mark::Code,
                };
                let enabled = !self.marks.has(mark);
                if self.range().is_empty() {
                    self.editor
                        .set_selection(self.editor.selection())
                        .map_err(error)?;
                } else {
                    self.format(Format::Mark(mark, enabled))?;
                }
                self.marks = self.marks.clone().with_mark(mark, enabled);
                return Ok(());
            }
            "break" => return self.replace("\n"),
            _ => {}
        }
        let (ix, start) = self.projection.at(self.range().start);
        let (last, end) = self.projection.at(self.range().end);
        if ix != last {
            return Err("请选择一个段落或单元格".into());
        }
        let leaf = &self.projection.leaves[ix];
        if name == "task" && leaf.kind == NodeKind::Paragraph && leaf.text.is_empty() {
            self.pending_task = Some(false);
            return Ok(());
        }
        let structure = self.structure(leaf)?;
        let path = &leaf.id.path;
        let tx = match name {
            "paragraph" => structure.set_text_kind(path, NodeKind::Paragraph, self.millis()),
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => structure.set_text_kind(
                path,
                NodeKind::Heading(name.as_bytes()[1] - b'0'),
                self.millis(),
            ),
            "code" => {
                structure.set_text_kind(path, NodeKind::Code { language: None }, self.millis())
            }
            "bullet" => structure.set_list(path, ListStyle::Bullet, self.millis()),
            "ordered" => structure.set_list(path, ListStyle::Ordered, self.millis()),
            "task" => structure.set_list(path, ListStyle::Task, self.millis()),
            "quote" => {
                let quote_path = if leaf.quote {
                    (1..path.len())
                        .rev()
                        .find(|length| {
                            structure
                                .root()
                                .node(&path[..*length])
                                .is_some_and(|node| node.kind() == &NodeKind::Quote)
                        })
                        .map(|length| &path[..length])
                        .ok_or("没有引用块")?
                } else {
                    path
                };
                structure.set_quote(quote_path, !leaf.quote, self.millis())
            }
            "table" => {
                structure.insert_table(path, start..end, TextUnit::Utf8, (3, 2), self.millis())
            }
            "row" | "column" | "deleteRow" | "deleteColumn" => {
                if leaf.kind != NodeKind::Cell {
                    return Err("请先选择表格单元格".into());
                }
                let table = &path[..path.len() - 2];
                let row = path[path.len() - 2];
                let col = path[path.len() - 1];
                match name {
                    "row" => structure.insert_row(table, row + 1, self.millis()),
                    "column" => structure.insert_column(table, col + 1, self.millis()),
                    "deleteRow" => structure.delete_row(table, row, self.millis()),
                    _ => structure.delete_column(table, col, self.millis()),
                }
            }
            "rule" => structure.paste(
                path,
                start..end,
                TextUnit::Utf8,
                "\n\n---\n\n",
                self.millis(),
            ),
            _ => return Err("未知编辑命令".into()),
        }
        .map_err(error)?;
        self.apply(tx)?;
        if name == "table"
            && let Some(leaf) = self
                .projection
                .leaves
                .iter()
                .rev()
                .find(|l| l.kind == NodeKind::Cell && l.logical.start <= self.head)
        {
            let block = leaf.id.block;
            let at = self
                .projection
                .leaves
                .iter()
                .find(|l| l.id.block == block && l.kind == NodeKind::Cell)
                .unwrap()
                .logical
                .start;
            self.select(at, at)?;
        }
        Ok(())
    }

    pub fn format(&mut self, format: Format) -> Result<()> {
        let range = self.range();
        let mut transactions = Vec::new();
        let mut block = None;
        let mut contents = Vec::new();
        for leaf in &self.projection.leaves {
            let start = range.start.max(leaf.logical.start);
            let end = range.end.min(leaf.logical.end);
            if start >= end
                || !matches!(
                    leaf.kind,
                    NodeKind::Paragraph | NodeKind::Heading(_) | NodeKind::Cell
                )
            {
                continue;
            }
            let Some(id) = leaf.id.block else { continue };
            if block != Some(id) {
                contents = InlineContent::for_block(self.editor.document(), id).map_err(error)?;
                block = Some(id);
            }
            let content = contents
                .iter()
                .find(|c| c.span().start >= leaf.span.start && c.span().end <= leaf.span.end)
                .ok_or("请选择可编辑文字")?;
            transactions.push(
                content
                    .format(
                        start - leaf.logical.start..end - leaf.logical.start,
                        TextUnit::Utf8,
                        format.clone(),
                        self.millis(),
                    )
                    .map_err(error)?,
            );
        }
        if transactions.is_empty() {
            return Err("请选择可编辑文字".into());
        }
        let (anchor, head) = (self.anchor, self.head);
        let tx = Transaction::combine(
            self.editor.document().generation(),
            transactions,
            EditKind::Format,
            self.millis(),
        )
        .map_err(error)?;
        let preview = Document::new(tx.source_after(self.editor.document()).map_err(error)?);
        let projection = Projection::new(&preview, 0);
        self.apply(tx.with_selection(Selection::new(
            self.editor.document().generation(),
            Position::new(projection.source_at(anchor), Affinity::Before),
            Position::new(projection.source_at(head), Affinity::After),
        )))
    }
    pub fn toggle_task(&mut self, ix: usize, checked: bool) -> Result<()> {
        let leaf = &self.projection.leaves[ix];
        let (path, _) = leaf.task.as_ref().ok_or("没有任务项")?;
        let tx = self
            .structure(leaf)?
            .set_checked(path, checked, self.millis())
            .map_err(error)?;
        self.apply(tx)
    }
    pub fn move_block(&mut self, from: usize, to: usize) -> Result<()> {
        let first = self
            .projection
            .leaves
            .get(from)
            .and_then(|l| l.id.block)
            .ok_or("没有可移动块")?;
        let target = self
            .projection
            .leaves
            .get(to)
            .and_then(|l| l.id.block)
            .ok_or("没有目标块")?;
        let tx = structure::move_blocks(
            self.editor.document(),
            first,
            first,
            target,
            structure::BlockSide::Before,
            self.millis(),
        )
        .map_err(error)?;
        self.apply(tx)
    }
    pub fn move_horizontal(&mut self, backward: bool, extend: bool, word: bool) -> Result<()> {
        let text = &self.projection.text;
        let next = if !extend && !self.range().is_empty() {
            if backward {
                self.range().start
            } else {
                self.range().end
            }
        } else if word {
            let positions = text
                .unicode_word_indices()
                .flat_map(|(ix, w)| [ix, ix + w.len()])
                .collect::<Vec<_>>();
            if backward {
                positions
                    .into_iter()
                    .filter(|p| *p < self.head)
                    .max()
                    .unwrap_or(0)
            } else {
                positions
                    .into_iter()
                    .find(|p| *p > self.head)
                    .unwrap_or(text.len())
            }
        } else {
            let r = deletion_range(text, self.head, backward).map_err(error)?;
            if backward { r.start } else { r.end }
        };
        self.select(if extend { self.anchor } else { next }, next)
    }
    pub fn begin_or_update_composition(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        selected: Range<usize>,
    ) -> Result<()> {
        anynote_editor::selection::byte_range(text, selected.clone(), TextUnit::Utf8)
            .map_err(error)?;
        if self.composition.is_none() {
            let range = range.unwrap_or_else(|| self.range());
            anynote_editor::selection::byte_range(
                &self.projection.text,
                range.clone(),
                TextUnit::Utf8,
            )
            .map_err(error)?;
            let (ix, start) = self.projection.at(range.start);
            let (last, end) = self.projection.at(range.end);
            if [ix, last].into_iter().any(|ix| {
                matches!(
                    self.projection.leaves[ix].kind,
                    NodeKind::Atom | NodeKind::Rule
                )
            }) {
                return Err("请在文字范围内开始组合输入".into());
            }
            if ix != last {
                self.prepare_replace_across(ix, start, last, end, text)?;
            }
            if range != self.range() {
                self.select(range.start, range.end)?;
            }
            let token = self
                .editor
                .begin_composition(
                    self.editor.document().generation(),
                    self.editor.selection().range(),
                    TextUnit::Utf8,
                )
                .map_err(error)?;
            self.composition = Some(Composition {
                token,
                range,
                leaf: ix,
                last_leaf: last,
                local_start: start,
                local_end: end,
            });
        }
        let composition = self.composition.as_ref().unwrap();
        self.editor
            .update_composition(composition.token, text.into(), selected, TextUnit::Utf8)
            .map_err(error)
    }
    pub fn commit_composition(&mut self, text: Option<&str>) -> Result<()> {
        let c = self.composition.as_ref().ok_or("没有组合输入")?;
        let text = text.unwrap_or_else(|| self.editor.composition().unwrap().text());
        let tx = if c.leaf == c.last_leaf {
            self.prepare_replace(c.leaf, c.local_start..c.local_end, text)?
        } else {
            self.prepare_replace_across(c.leaf, c.local_start, c.last_leaf, c.local_end, text)?
        };
        self.editor
            .commit_composition_transaction(c.token, tx)
            .map_err(error)?;
        self.composition = None;
        self.pending_task = None;
        self.pending_after = None;
        self.refresh();
        Ok(())
    }
    pub fn cancel_composition(&mut self) -> Result<()> {
        if let Some(c) = &self.composition {
            self.editor.cancel_composition(c.token).map_err(error)?;
        }
        self.composition = None;
        Ok(())
    }
    pub fn display_text(&self) -> String {
        if self.composition.is_none() {
            return self.projection.text.clone();
        }
        let mut text = String::new();
        for ix in 0..self.projection.leaves.len() {
            if ix > 0 {
                text.push('\n');
            }
            text.push_str(&self.display_leaf_text(ix));
        }
        text
    }
    pub fn composing_leaf(&self, ix: usize) -> bool {
        self.composition
            .as_ref()
            .is_some_and(|c| (c.leaf..=c.last_leaf).contains(&ix))
    }
    pub fn display_leaf_text(&self, ix: usize) -> Cow<'_, str> {
        let text = &self.projection.leaves[ix].text;
        let Some(c) = self
            .composition
            .as_ref()
            .filter(|_| self.composing_leaf(ix))
        else {
            return Cow::Borrowed(text);
        };
        if ix == c.leaf {
            let mut text = text[..c.local_start].to_owned();
            text.push_str(self.editor.composition().unwrap().text());
            if ix == c.last_leaf {
                text.push_str(&self.projection.leaves[ix].text[c.local_end..]);
            }
            Cow::Owned(text)
        } else if ix == c.last_leaf {
            Cow::Borrowed(&text[c.local_end..])
        } else {
            Cow::Borrowed("")
        }
    }
    pub fn display_leaf_start(&self, ix: usize) -> usize {
        let start = self.projection.leaves[ix].logical.start;
        let Some(c) = self.composition.as_ref().filter(|c| ix > c.leaf) else {
            return start;
        };
        let inserted = self.editor.composition().unwrap().text().len();
        // Keep the frozen containers (including table cells) until commit. Their
        // separators belong to surrounding text, never to the IME marked range.
        if ix <= c.last_leaf {
            c.range.start + inserted + ix - c.leaf
        } else {
            start - c.range.len() + c.last_leaf - c.leaf + inserted
        }
    }
    pub fn display_at(&self, offset: usize) -> (usize, usize) {
        if self.composition.is_none() {
            return self.projection.at(offset);
        }
        for ix in 0..self.projection.leaves.len() {
            let start = self.display_leaf_start(ix);
            let length = self.display_leaf_text(ix).len();
            if offset <= start + length || ix + 1 == self.projection.leaves.len() {
                return (ix, offset.saturating_sub(start).min(length));
            }
        }
        unreachable!("projection always contains a leaf")
    }
    pub fn display_selection(&self) -> Range<usize> {
        if let Some(c) = &self.composition {
            let selection = self.editor.composition().unwrap().selection();
            c.range.start + selection.start..c.range.start + selection.end
        } else {
            self.range()
        }
    }
    pub fn display_head(&self) -> usize {
        if self.composition.is_some() {
            self.display_selection().end
        } else {
            self.head
        }
    }
    pub fn selected_markdown(&self) -> Option<String> {
        let range = self.range();
        if range == (0..self.projection.text.len()) {
            return Some(self.editor.document().source().into());
        }
        let (ix, start) = self.projection.at(range.start);
        let (last, end) = self.projection.at(range.end);
        if ix != last {
            return None;
        }
        let leaf = &self.projection.leaves[ix];
        let id = leaf.id.block?;
        if matches!(leaf.kind, NodeKind::Atom | NodeKind::Rule)
            && start == 0
            && end == leaf.text.len()
        {
            return Some(self.editor.document().source()[leaf.span.clone()].into());
        }
        InlineContent::for_block(self.editor.document(), id)
            .ok()?
            .into_iter()
            .find(|c| c.span().start >= leaf.span.start && c.span().end <= leaf.span.end)?
            .copy_markdown(start..end, TextUnit::Utf8)
            .ok()
    }
    pub fn source_snapshot(&mut self, next: &str) -> Result<()> {
        let old = self.editor.document().source();
        if old == next {
            return Ok(());
        }
        let mut prefix = old
            .bytes()
            .zip(next.bytes())
            .take_while(|(a, b)| a == b)
            .count();
        while !old.is_char_boundary(prefix) || !next.is_char_boundary(prefix) {
            prefix -= 1;
        }
        let mut suffix = old[prefix..]
            .bytes()
            .rev()
            .zip(next[prefix..].bytes().rev())
            .take_while(|(a, b)| a == b)
            .count();
        while !old.is_char_boundary(old.len() - suffix)
            || !next.is_char_boundary(next.len() - suffix)
        {
            suffix -= 1;
        }
        self.source_edit(
            prefix..old.len() - suffix,
            &next[prefix..next.len() - suffix],
        )
    }
    pub fn source_edit(&mut self, range: Range<usize>, replacement: &str) -> Result<()> {
        self.pending_task = None;
        self.pending_after = None;
        self.editor
            .replace(
                TextRange::new(self.editor.document().generation(), range, TextUnit::Utf8),
                replacement,
                EditKind::Source,
                self.millis(),
            )
            .map_err(error)?;
        self.refresh();
        Ok(())
    }
    pub fn utf16_range(&self, range: Range<usize>) -> Result<Range<usize>> {
        native_byte_range(&self.display_text(), range)
    }
}

// Native platforms may request a UTF-16 range through the middle of a surrogate
// pair. Round nonempty ranges outward; keep a caret at the preceding scalar.
pub(super) fn native_byte_range(text: &str, range: Range<usize>) -> Result<Range<usize>> {
    if range.start > range.end {
        return Err("无效输入范围".into());
    }
    let mut units = 0;
    let mut start = 0;
    let mut end = 0;
    for (byte, ch) in text.char_indices() {
        if units <= range.start {
            start = byte;
        }
        if units < range.end {
            end = byte + ch.len_utf8();
        }
        units += ch.len_utf16();
    }
    if range.start >= units {
        start = text.len();
    }
    Ok(if range.is_empty() {
        start..start
    } else {
        start..end
    })
}
