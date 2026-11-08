use crate::source::{ChangeMap, SourceEdit, SourceError};
use anynote_core::protocol::rich::{Content, RichBlock, rich_blocks};
use std::{
    collections::{BTreeMap, BTreeSet},
    ops::Range,
};

/// Session-local identity; never serialized into the Markdown body.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BlockId(u64);

#[derive(Clone, Debug, PartialEq)]
pub struct Block {
    id: BlockId,
    parsed: RichBlock,
}
impl Block {
    pub fn id(&self) -> BlockId {
        self.id
    }
    pub fn parsed(&self) -> &RichBlock {
        &self.parsed
    }
    pub fn span(&self) -> Range<usize> {
        self.parsed.span()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SegmentKind {
    Separator,
    Block(BlockId),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceSegment {
    span: Range<usize>,
    kind: SegmentKind,
}
impl SourceSegment {
    pub fn span(&self) -> Range<usize> {
        self.span.clone()
    }
    pub fn kind(&self) -> &SegmentKind {
        &self.kind
    }
}

/// Owns the authoritative source and its derived, non-persistent semantic projection.
#[derive(Debug)]
pub struct Document {
    source: String,
    blocks: Vec<Block>,
    segments: Vec<SourceSegment>,
    generation: u64,
    next_id: u64,
}
impl Document {
    pub fn new(source: String) -> Self {
        let blocks: Vec<_> = rich_blocks(&source)
            .into_iter()
            .enumerate()
            .map(|(ix, parsed)| Block {
                id: BlockId(ix as u64 + 1),
                parsed,
            })
            .collect();
        let next_id = blocks.len() as u64 + 1;
        let segments = source_segments(source.len(), &blocks);
        Self {
            source,
            blocks,
            segments,
            generation: 0,
            next_id,
        }
    }
    pub fn source(&self) -> &str {
        &self.source
    }
    /// Saving an unmodified document returns the exact original source, including separators.
    pub fn serialize(&self) -> &str {
        &self.source
    }
    pub fn blocks(&self) -> &[Block] {
        &self.blocks
    }
    pub fn segments(&self) -> &[SourceSegment] {
        &self.segments
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn block(&self, id: BlockId) -> Option<&Block> {
        self.blocks.iter().find(|block| block.id == id)
    }
    pub fn source_offset(&self, id: BlockId, local: usize) -> Option<usize> {
        let span = self.block(id)?.span();
        let offset = span.start.checked_add(local)?;
        (offset <= span.end && self.source.is_char_boundary(offset)).then_some(offset)
    }
    /// Returns all owning blocks at a boundary; selection affinity is chosen by RM16.
    pub fn block_positions(&self, offset: usize) -> Vec<(BlockId, usize)> {
        if !self.source.is_char_boundary(offset) {
            return Vec::new();
        }
        self.blocks
            .iter()
            .filter_map(|block| {
                let span = block.span();
                (span.start <= offset && offset <= span.end)
                    .then(|| (block.id, offset - span.start))
            })
            .collect()
    }

    /// Reparse the whole projection so references/fences cannot leave stale distant blocks.
    /// This is the source serializer seam, not a second command/selection/history owner.
    pub fn replace_source(
        &mut self,
        generation: u64,
        edit: SourceEdit<'_>,
    ) -> Result<ChangeMap, SourceError> {
        if generation != self.generation {
            return Err(SourceError::Stale);
        }
        let source = edit.serialize(&self.source)?;
        let change = ChangeMap::new(edit.range(), edit.replacement().len());
        if source == self.source {
            return Ok(ChangeMap::new(0..0, 0));
        }
        let generation = self
            .generation
            .checked_add(1)
            .ok_or(SourceError::IdExhausted)?;
        let mut identities = BTreeMap::new();
        for block in &self.blocks {
            if let Some(span) = change.unchanged_range(block.span()) {
                identities.insert((span.start, span.end), block.id);
            }
            if block.span().start <= change.old_range().start
                && block.span().end >= change.old_range().end
            {
                let span = block.span();
                identities.insert(
                    (
                        span.start,
                        change.new_range().end + (span.end - change.old_range().end),
                    ),
                    block.id,
                );
            }
        }
        let mut next_id = self.next_id;
        let mut blocks = Vec::new();
        let mut used_ids = BTreeSet::new();
        for parsed in rich_blocks(&source) {
            let span = parsed.span();
            let id = if let Some(id) = identities
                .remove(&(span.start, span.end))
                .filter(|id| used_ids.insert(*id))
            {
                id
            } else {
                let id = BlockId(next_id);
                next_id = next_id.checked_add(1).ok_or(SourceError::IdExhausted)?;
                id
            };
            blocks.push(Block { id, parsed });
        }
        let segments = source_segments(source.len(), &blocks);
        self.source = source;
        self.blocks = blocks;
        self.segments = segments;
        self.generation = generation;
        self.next_id = next_id;
        Ok(change)
    }

    /// Update one JSON object field while retaining unknown attributes, values, and source outside the payload.
    pub fn set_directive_field(
        &mut self,
        generation: u64,
        id: BlockId,
        key: &str,
        value: serde_json::Value,
    ) -> Result<ChangeMap, SourceError> {
        if generation != self.generation {
            return Err(SourceError::Stale);
        }
        let block = self.block(id).ok_or(SourceError::Stale)?;
        let Content::Directive(directive) = block.parsed.content() else {
            return Err(SourceError::InvalidDirective);
        };
        let Some(serde_json::Value::Object(object)) = directive.data() else {
            return Err(SourceError::InvalidDirective);
        };
        let span = directive.payload_span();
        if object.get(key) == Some(&value) {
            return Ok(ChangeMap::new(0..0, 0));
        }
        let mut object = object.clone();
        object.insert(key.to_owned(), value);
        let expected = self.source[span.clone()].to_owned();
        let trailing = &expected[expected.trim_end_matches([' ', '\t', '\r', '\n']).len()..];
        let replacement =
            serde_json::to_string(&object).map_err(|_| SourceError::InvalidDirective)? + trailing;
        self.replace_source(generation, SourceEdit::new(span, &expected, &replacement))
    }
}

fn source_segments(length: usize, blocks: &[Block]) -> Vec<SourceSegment> {
    let mut segments = Vec::with_capacity(blocks.len() * 2 + 1);
    let mut end = 0;
    for block in blocks {
        let span = block.span();
        if end < span.start {
            segments.push(SourceSegment {
                span: end..span.start,
                kind: SegmentKind::Separator,
            });
        }
        end = span.end;
        segments.push(SourceSegment {
            span,
            kind: SegmentKind::Block(block.id),
        });
    }
    if end < length {
        segments.push(SourceSegment {
            span: end..length,
            kind: SegmentKind::Separator,
        });
    }
    segments
}
