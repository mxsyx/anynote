//! The sole mutation/history owner for a text editing session; no platform or persistence effects.
use crate::{
    composition::Composition,
    history::{Entry, History, HistoryBudget},
    model::{BlockId, Document},
    selection::{Selection, TextRange, TextUnit, byte_range},
    source::{ChangeMap, SourceEdit, SourceError},
};
use std::{borrow::Cow, ops::Range};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EditError {
    Source(SourceError),
    CompositionActive,
    NoComposition,
    StaleComposition,
    UnsupportedInline,
    InvalidLink,
}
impl From<SourceError> for EditError {
    fn from(error: SourceError) -> Self {
        Self::Source(error)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EditKind {
    Typing,
    /// Literal rich input may rewrite adjacent Markdown delimiters/entities.
    RichTyping,
    BackwardDelete,
    ForwardDelete,
    Paste,
    Format,
    Source,
    Composition,
}

/// Only changed bytes are retained. The inverse swaps removed/inserted in the resulting coordinates.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Patch {
    range: Range<usize>,
    removed: String,
    inserted: String,
}
impl Patch {
    pub fn new(
        range: Range<usize>,
        expected: impl Into<String>,
        replacement: impl Into<String>,
    ) -> Self {
        Self {
            range,
            removed: expected.into(),
            inserted: replacement.into(),
        }
    }
    pub fn range(&self) -> Range<usize> {
        self.range.clone()
    }
    pub fn removed(&self) -> &str {
        &self.removed
    }
    pub fn inserted(&self) -> &str {
        &self.inserted
    }
    pub fn inverse(&self, start: usize) -> Self {
        Self::new(
            start..start + self.inserted.len(),
            self.inserted.clone(),
            self.removed.clone(),
        )
    }
    pub(crate) fn bytes(&self) -> usize {
        std::mem::size_of::<Self>() + self.removed.capacity() + self.inserted.capacity()
    }
    fn edit(&self) -> SourceEdit<'_> {
        SourceEdit::new(self.range(), &self.removed, &self.inserted)
    }
}

pub struct Transaction {
    generation: u64,
    patches: Vec<Patch>,
    after: Option<Selection>,
    kind: EditKind,
    millis: u64,
}
impl Transaction {
    /// Preview the resulting source to resolve a logical selection before commit.
    /// This does not mutate the document or publish a history entry.
    pub fn source_after(&self, document: &Document) -> Result<String, EditError> {
        if self.generation != document.generation() {
            return Err(SourceError::Stale.into());
        }
        validate_patches(document.source(), &self.patches)?;
        let mut source = document.source().to_owned();
        replay(&mut source, &self.patches)?;
        Ok(source)
    }

    /// Combine prepared edits against the same snapshot into one history entry.
    /// The caller owns the final selection; child selections are not composed.
    /// Patch conflicts are validated atomically by `Editor::apply`.
    pub fn combine(
        generation: u64,
        transactions: impl IntoIterator<Item = Self>,
        kind: EditKind,
        millis: u64,
    ) -> Result<Self, EditError> {
        let mut patches = Vec::new();
        for transaction in transactions {
            if transaction.generation != generation {
                return Err(SourceError::Stale.into());
            }
            patches.extend(transaction.patches);
        }
        patches.sort_by_key(|patch| patch.range.start);
        Ok(Self::new(generation, patches, kind, millis))
    }

    pub fn new(generation: u64, patches: Vec<Patch>, kind: EditKind, millis: u64) -> Self {
        Self {
            generation,
            patches,
            after: None,
            kind,
            millis,
        }
    }
    /// Explicit selection uses resulting source coordinates and the transaction's base generation.
    pub fn with_selection(mut self, selection: Selection) -> Self {
        self.after = Some(selection);
        self
    }
    pub fn with_kind(mut self, kind: EditKind) -> Self {
        self.kind = kind;
        self
    }
}

#[derive(Debug)]
pub struct Applied {
    generation: u64,
    changes: Vec<ChangeMap>,
    affected: Vec<BlockId>,
}
impl Applied {
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn changes(&self) -> &[ChangeMap] {
        &self.changes
    }
    pub fn affected_blocks(&self) -> &[BlockId] {
        &self.affected
    }
    pub fn is_changed(&self) -> bool {
        !self.changes.is_empty()
    }
}

pub struct Editor {
    document: Document,
    selection: Selection,
    history: History,
    composition: Option<Composition>,
    next_composition: u64,
}
impl Editor {
    pub fn new(document: Document, budget: HistoryBudget) -> Self {
        let selection = Selection::caret(document.generation(), 0);
        Self {
            document,
            selection,
            history: History::new(budget),
            composition: None,
            next_composition: 1,
        }
    }
    pub fn document(&self) -> &Document {
        &self.document
    }
    pub fn selection(&self) -> Selection {
        self.selection
    }
    pub fn composition(&self) -> Option<&Composition> {
        self.composition.as_ref()
    }
    pub fn history_bytes(&self) -> usize {
        self.history.bytes()
    }
    pub fn undo_steps(&self) -> usize {
        self.history.undo.len()
    }
    pub fn redo_steps(&self) -> usize {
        self.history.redo.len()
    }
    pub fn set_selection(&mut self, selection: Selection) -> Result<(), EditError> {
        self.require_idle()?;
        selection.validate(&self.document)?;
        self.selection = selection;
        self.history.break_merge();
        Ok(())
    }
    fn require_idle(&self) -> Result<(), EditError> {
        if self.composition.is_some() {
            Err(EditError::CompositionActive)
        } else {
            Ok(())
        }
    }
    pub fn replace(
        &mut self,
        target: TextRange,
        text: &str,
        kind: EditKind,
        millis: u64,
    ) -> Result<Applied, EditError> {
        let generation = target.generation();
        let range = target.resolve(&self.document)?;
        let after = Selection::caret(generation, range.start + text.len());
        let patch = Patch::new(range.clone(), &self.document.source()[range], text);
        self.apply(Transaction::new(generation, vec![patch], kind, millis).with_selection(after))
    }
    pub fn apply(&mut self, transaction: Transaction) -> Result<Applied, EditError> {
        self.require_idle()?;
        self.apply_inner(transaction)
    }
    fn apply_inner(&mut self, transaction: Transaction) -> Result<Applied, EditError> {
        let Transaction {
            generation,
            mut patches,
            after,
            kind,
            millis,
        } = transaction;
        if generation != self.document.generation() {
            return Err(SourceError::Stale.into());
        }
        let source = self.document.source();
        validate_patches(source, &patches)?;
        patches.retain(|patch| patch.removed != patch.inserted);
        let before = self.selection;
        let mut next_source = source.to_owned();
        replay(&mut next_source, &patches)?;
        let maps: Vec<_> = patches
            .iter()
            .rev()
            .map(|p| ChangeMap::new(p.range(), p.inserted.len()))
            .collect();
        let selected = if let Some(after) = after {
            if after.generation() != generation {
                return Err(SourceError::Stale.into());
            }
            after
        } else {
            before.mapped(generation, &maps)
        };
        selected.validate_source(&next_source)?;
        drop(next_source);
        let affected: Vec<_> = self
            .document
            .blocks()
            .iter()
            .filter(|block| {
                patches
                    .iter()
                    .any(|p| p.range.start <= block.span().end && p.range.end >= block.span().start)
            })
            .map(|b| b.id())
            .collect();
        let block = if affected.len() == 1 {
            Some(affected[0])
        } else {
            None
        };
        let changes = self.document.replace_sources(
            generation,
            &patches.iter().map(Patch::edit).collect::<Vec<_>>(),
        )?;
        self.selection = selected.at_generation(self.document.generation());
        if !changes.is_empty() {
            // A split or join must not merge ordinary input across a new block boundary.
            let block = block
                .or_else(|| {
                    (kind == EditKind::RichTyping && affected.is_empty())
                        .then(|| {
                            self.selection
                                .head()
                                .block_position(&self.document)
                                .map(|(id, _)| id)
                        })
                        .flatten()
                })
                .filter(|id| {
                    self.document.block(*id).is_some_and(|b| {
                        let span = b.span();
                        span.start <= self.selection.head().offset()
                            && self.selection.head().offset() <= span.end
                    })
                });
            self.history.push(Entry {
                batches: vec![patches],
                before,
                after: self.selection,
                kind,
                block,
                millis,
            });
        } else if selected != before
            || !matches!(
                kind,
                EditKind::Typing | EditKind::BackwardDelete | EditKind::ForwardDelete
            )
        {
            self.history.break_merge();
        }
        Ok(Applied {
            generation: self.document.generation(),
            changes,
            affected,
        })
    }
    pub fn undo(&mut self) -> Result<bool, EditError> {
        self.replay_history(false)
    }
    pub fn redo(&mut self) -> Result<bool, EditError> {
        self.replay_history(true)
    }
    fn replay_history(&mut self, redo: bool) -> Result<bool, EditError> {
        self.require_idle()?;
        let entry = if redo {
            self.history.redo.last()
        } else {
            self.history.undo.back()
        };
        let Some(entry) = entry else {
            return Ok(false);
        };
        let mut source = self.document.source().to_owned();
        if redo {
            for batch in &entry.batches {
                replay(&mut source, batch)?;
            }
        } else {
            for batch in entry.batches.iter().rev() {
                replay(&mut source, &inverse_batch(batch))?;
            }
        }
        let selection = if redo { entry.after } else { entry.before };
        selection.validate_source(&source)?;
        // Replay is prepared off-state, then published once, even for a merged typing group.
        let patch = difference(self.document.source(), &source);
        self.document
            .replace_source(self.document.generation(), patch.edit())?;
        self.selection = selection.at_generation(self.document.generation());
        if redo {
            self.history
                .undo
                .push_back(self.history.redo.pop().unwrap());
        } else {
            self.history
                .redo
                .push(self.history.undo.pop_back().unwrap());
        }
        self.history.break_merge();
        Ok(true)
    }
    pub fn begin_composition(
        &mut self,
        generation: u64,
        range: Range<usize>,
        unit: TextUnit,
    ) -> Result<u64, EditError> {
        self.require_idle()?;
        if generation != self.document.generation() {
            return Err(SourceError::Stale.into());
        }
        let range = byte_range(self.document.source(), range, unit)?;
        let token = self.next_composition;
        self.next_composition = token.checked_add(1).ok_or(SourceError::IdExhausted)?;
        self.composition = Some(Composition::new(token, generation, range, self.selection));
        self.history.break_merge();
        Ok(token)
    }
    fn check_composition(&self, token: u64) -> Result<&Composition, EditError> {
        let composition = self.composition.as_ref().ok_or(EditError::NoComposition)?;
        if token != composition.token() {
            return Err(EditError::StaleComposition);
        }
        Ok(composition)
    }
    pub fn update_composition(
        &mut self,
        token: u64,
        text: String,
        selection: Range<usize>,
        unit: TextUnit,
    ) -> Result<(), EditError> {
        self.check_composition(token)?;
        self.composition
            .as_mut()
            .unwrap()
            .update(text, selection, unit)
    }
    pub fn cancel_composition(&mut self, token: u64) -> Result<(), EditError> {
        self.selection = self.check_composition(token)?.before();
        self.composition = None;
        self.history.break_merge();
        Ok(())
    }
    pub fn commit_composition(
        &mut self,
        token: u64,
        final_text: Option<&str>,
        millis: u64,
    ) -> Result<Applied, EditError> {
        let composition = self.check_composition(token)?;
        let text = final_text.unwrap_or(composition.text());
        let range = composition.range();
        let patch = Patch::new(range.clone(), &self.document.source()[range.clone()], text);
        let generation = composition.generation();
        let after = Selection::caret(generation, range.start + text.len());
        self.commit_composition_transaction(
            token,
            Transaction::new(generation, vec![patch], EditKind::Composition, millis)
                .with_selection(after),
        )
    }
    /// Rich adapters may commit a validated inline transaction prepared from the frozen projection.
    /// Formatting normalization stays in the core and the entire commit remains one undo unit.
    pub fn commit_composition_transaction(
        &mut self,
        token: u64,
        mut transaction: Transaction,
    ) -> Result<Applied, EditError> {
        let composition = self.check_composition(token)?;
        if transaction.generation != composition.generation() {
            return Err(SourceError::Stale.into());
        }
        transaction.kind = EditKind::Composition;
        let applied = self.apply_inner(transaction)?;
        self.composition = None;
        self.history.break_merge();
        Ok(applied)
    }
    /// Display-only; save integrations must use document().serialize() and defer flush while composing.
    pub fn display_source(&self) -> Cow<'_, str> {
        match &self.composition {
            None => Cow::Borrowed(self.document.source()),
            Some(composition) => {
                let mut text = self.document.source().to_owned();
                text.replace_range(composition.range(), composition.text());
                Cow::Owned(text)
            }
        }
    }
}

fn validate_patches(source: &str, patches: &[Patch]) -> Result<(), SourceError> {
    for (ix, patch) in patches.iter().enumerate() {
        patch.edit().validate(source)?;
        if ix > 0 && patches[ix - 1].range.end >= patch.range.start {
            return Err(SourceError::InvalidRange);
        }
    }
    Ok(())
}
fn replay(source: &mut String, patches: &[Patch]) -> Result<(), SourceError> {
    validate_patches(source, patches)?;
    for patch in patches.iter().rev() {
        source.replace_range(patch.range(), &patch.inserted);
    }
    Ok(())
}
fn inverse_batch(batch: &[Patch]) -> Vec<Patch> {
    let mut old_end = 0;
    let mut new_end = 0;
    batch
        .iter()
        .map(|patch| {
            let start = new_end + (patch.range.start - old_end);
            old_end = patch.range.end;
            new_end = start + patch.inserted.len();
            patch.inverse(start)
        })
        .collect()
}
pub(crate) fn difference(before: &str, after: &str) -> Patch {
    let mut start = before
        .bytes()
        .zip(after.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    while !before.is_char_boundary(start) || !after.is_char_boundary(start) {
        start -= 1;
    }
    let mut tail = before[start..]
        .bytes()
        .rev()
        .zip(after[start..].bytes().rev())
        .take_while(|(a, b)| a == b)
        .count();
    while !before.is_char_boundary(before.len() - tail)
        || !after.is_char_boundary(after.len() - tail)
    {
        tail -= 1;
    }
    Patch::new(
        start..before.len() - tail,
        &before[start..before.len() - tail],
        &after[start..after.len() - tail],
    )
}
