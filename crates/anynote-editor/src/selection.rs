//! Source coordinates are versioned; block-local positions are resolved against that version.
use crate::{
    model::{BlockId, Document},
    source::{ChangeMap, SourceError},
};
use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextUnit {
    Utf8,
    Utf16,
    Grapheme,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Affinity {
    Before,
    After,
}

pub fn byte_offset(text: &str, offset: usize, unit: TextUnit) -> Result<usize, SourceError> {
    match unit {
        TextUnit::Utf8 => text.is_char_boundary(offset).then_some(offset),
        TextUnit::Utf16 => {
            let mut count = 0;
            for (byte, ch) in text.char_indices() {
                if count == offset {
                    return Ok(byte);
                }
                count += ch.len_utf16();
            }
            (count == offset).then_some(text.len())
        }
        TextUnit::Grapheme => text
            .grapheme_indices(true)
            .map(|(byte, _)| byte)
            .chain(std::iter::once(text.len()))
            .nth(offset),
    }
    .ok_or(SourceError::InvalidRange)
}

pub fn offset_from_byte(text: &str, byte: usize, unit: TextUnit) -> Result<usize, SourceError> {
    let prefix = text.get(..byte).ok_or(SourceError::InvalidRange)?;
    match unit {
        TextUnit::Utf8 => Ok(byte),
        TextUnit::Utf16 => Ok(prefix.encode_utf16().count()),
        TextUnit::Grapheme => text
            .grapheme_indices(true)
            .map(|(at, _)| at)
            .chain(std::iter::once(text.len()))
            .position(|at| at == byte)
            .ok_or(SourceError::InvalidRange),
    }
}

pub fn byte_range(
    text: &str,
    range: Range<usize>,
    unit: TextUnit,
) -> Result<Range<usize>, SourceError> {
    if range.start > range.end {
        return Err(SourceError::InvalidRange);
    }
    Ok(byte_offset(text, range.start, unit)?..byte_offset(text, range.end, unit)?)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Position {
    offset: usize,
    affinity: Affinity,
}
impl Position {
    pub fn new(offset: usize, affinity: Affinity) -> Self {
        Self { offset, affinity }
    }
    pub fn offset(self) -> usize {
        self.offset
    }
    pub fn affinity(self) -> Affinity {
        self.affinity
    }
    pub fn from_block(
        doc: &Document,
        id: BlockId,
        local: usize,
        affinity: Affinity,
    ) -> Result<Self, SourceError> {
        Ok(Self::new(
            doc.source_offset(id, local)
                .ok_or(SourceError::InvalidRange)?,
            affinity,
        ))
    }
    pub fn block_position(self, doc: &Document) -> Option<(BlockId, usize)> {
        let positions = doc.block_positions(self.offset);
        match self.affinity {
            Affinity::Before => positions.first(),
            Affinity::After => positions.last(),
        }
        .copied()
    }
    fn map(self, change: &ChangeMap) -> Self {
        Self::new(
            change.map_offset(self.offset, self.affinity == Affinity::After),
            self.affinity,
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Selection {
    generation: u64,
    anchor: Position,
    head: Position,
}
impl Selection {
    pub fn new(generation: u64, anchor: Position, head: Position) -> Self {
        Self {
            generation,
            anchor,
            head,
        }
    }
    pub fn caret(generation: u64, offset: usize) -> Self {
        let position = Position::new(offset, Affinity::After);
        Self::new(generation, position, position)
    }
    pub fn generation(self) -> u64 {
        self.generation
    }
    pub fn anchor(self) -> Position {
        self.anchor
    }
    pub fn head(self) -> Position {
        self.head
    }
    pub fn range(self) -> Range<usize> {
        self.anchor.offset.min(self.head.offset)..self.anchor.offset.max(self.head.offset)
    }
    pub fn is_empty(self) -> bool {
        self.anchor.offset == self.head.offset
    }
    pub fn validate(self, doc: &Document) -> Result<(), SourceError> {
        if self.generation != doc.generation() {
            return Err(SourceError::Stale);
        }
        self.validate_source(doc.source())
    }
    pub(crate) fn validate_source(self, source: &str) -> Result<(), SourceError> {
        if !source.is_char_boundary(self.anchor.offset)
            || !source.is_char_boundary(self.head.offset)
        {
            return Err(SourceError::InvalidRange);
        }
        Ok(())
    }
    pub(crate) fn at_generation(self, generation: u64) -> Self {
        Self { generation, ..self }
    }
    pub fn mapped(self, generation: u64, changes: &[ChangeMap]) -> Self {
        let mut result = self.at_generation(generation);
        for change in changes {
            result.anchor = result.anchor.map(change);
            result.head = result.head.map(change);
        }
        result
    }
}

/// Returns one entire extended grapheme adjacent to the caret; rejects a caret inside a cluster.
pub fn deletion_range(
    text: &str,
    caret: usize,
    backward: bool,
) -> Result<Range<usize>, SourceError> {
    let ix = offset_from_byte(text, caret, TextUnit::Grapheme)?;
    if backward {
        Ok(byte_offset(text, ix.saturating_sub(1), TextUnit::Grapheme)?..caret)
    } else {
        let end = if caret == text.len() {
            caret
        } else {
            byte_offset(text, ix + 1, TextUnit::Grapheme)?
        };
        Ok(caret..end)
    }
}

/// A range belongs to one document generation and one explicit coordinate unit.
#[derive(Clone, Debug)]
pub struct TextRange {
    generation: u64,
    range: Range<usize>,
    unit: TextUnit,
}
impl TextRange {
    pub fn new(generation: u64, range: Range<usize>, unit: TextUnit) -> Self {
        Self {
            generation,
            range,
            unit,
        }
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn resolve(&self, document: &Document) -> Result<Range<usize>, SourceError> {
        if self.generation != document.generation() {
            return Err(SourceError::Stale);
        }
        byte_range(document.source(), self.range.clone(), self.unit)
    }
}
