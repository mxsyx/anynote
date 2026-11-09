use super::{StructureError, StructureResult, prepared};
use crate::{
    model::{BlockId, Document},
    selection::{Affinity, Position, Selection},
    source::{SourceError, newline_at},
    transaction::{EditKind, Patch, Transaction},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockSide {
    Before,
    After,
}

/// Whole-block selections can include opaque/directive atoms without opening their payloads.
pub fn block_selection(
    document: &Document,
    first: BlockId,
    last: BlockId,
) -> StructureResult<Selection> {
    let first = document.block(first).ok_or(SourceError::Stale)?.span();
    let last = document.block(last).ok_or(SourceError::Stale)?.span();
    let (anchor, head) = if first.start <= last.start {
        (
            Position::new(first.start, Affinity::Before),
            Position::new(last.end, Affinity::After),
        )
    } else {
        (
            Position::new(first.end, Affinity::After),
            Position::new(last.start, Affinity::Before),
        )
    };
    Ok(Selection::new(document.generation(), anchor, head))
}
pub fn atom_position(
    document: &Document,
    block: BlockId,
    side: BlockSide,
) -> StructureResult<Position> {
    let block = document.block(block).ok_or(SourceError::Stale)?;
    if block.parsed().is_editable()
        && !matches!(block.parsed().content(), anynote_core::protocol::rich::Content::Markdown { node, .. } if matches!(node.as_ref(), anynote_core::protocol::rich::MarkdownNode::ThematicBreak(_)))
    {
        return Err(StructureError::Unsupported);
    }
    Ok(match side {
        BlockSide::Before => Position::new(block.span().start, Affinity::Before),
        BlockSide::After => Position::new(block.span().end, Affinity::After),
    })
}

/// Paste complete Markdown blocks at a block boundary or replace a whole-block selection.
/// Preserved directives/opaque blocks are copied byte-for-byte, without executing or reading resources.
pub fn paste_blocks(
    document: &Document,
    selection: Selection,
    markdown: &str,
    millis: u64,
) -> StructureResult<Transaction> {
    selection.validate(document)?;
    let range = selection.range();
    for block in document.blocks() {
        let span = block.span();
        if (span.start < range.start && range.start < span.end)
            || (span.start < range.end && range.end < span.end)
        {
            return Err(StructureError::InvalidPath);
        }
    }
    let newline = newline_at(document.source(), range.start)?;
    let mut text = String::new();
    if range.start > 0 {
        text.push_str(newline);
        text.push_str(newline);
    }
    text.push_str(markdown);
    let caret = text.len();
    if range.end < document.source().len() {
        text.push_str(newline);
        text.push_str(newline);
    }
    prepared(document, range, text, Some(caret), EditKind::Paste, millis)
}

/// Move a contiguous run before/after another block. Raw payloads keep their bytes;
/// separators gain blank lines if needed so a moved list/quote cannot absorb its neighbor.
pub fn move_blocks(
    document: &Document,
    first: BlockId,
    last: BlockId,
    target: BlockId,
    side: BlockSide,
    millis: u64,
) -> StructureResult<Transaction> {
    let blocks = document.blocks();
    let locate = |id| {
        blocks
            .iter()
            .position(|b| b.id() == id)
            .ok_or(SourceError::Stale)
    };
    let a = locate(first)?;
    let b = locate(last)?;
    let start = a.min(b);
    let end = a.max(b) + 1;
    let target = locate(target)?;
    let destination = target + usize::from(side == BlockSide::After);
    if (start..=end).contains(&destination) {
        return Ok(Transaction::new(
            document.generation(),
            vec![],
            EditKind::Format,
            millis,
        ));
    }
    let low = destination.min(start);
    let high = destination.max(end);
    let range = blocks[low].span().start..blocks[high - 1].span().end;
    let mut order: Vec<usize> = (low..high).collect();
    if destination < start {
        order.rotate_right(end - start);
    } else {
        order.rotate_left(end - start);
    }
    let newline = newline_at(document.source(), range.start)?;
    let mut text = String::new();
    let mut spans = Vec::new();
    let mut caret = 0;
    for (slot, &ix) in order.iter().enumerate() {
        if slot > 0 {
            text.push_str(
                &document.source()
                    [blocks[low + slot - 1].span().end..blocks[low + slot].span().start],
            );
            let trailing = &text[text.trim_end_matches(char::is_whitespace).len()..];
            let breaks = super::line_breaks(trailing);
            if breaks < 2 {
                text.push_str(&newline.repeat(2 - breaks));
            }
        }
        if ix == start {
            caret = text.len();
        }
        let begin = text.len();
        text.push_str(&document.source()[blocks[ix].span()]);
        spans.push(begin..text.len());
    }
    let check = Document::new(text.clone());
    if check.blocks().len() != order.len()
        || check
            .blocks()
            .iter()
            .zip(order.iter().zip(spans))
            .any(|(block, (&ix, span))| {
                block.span().start != span.start
                    || block.parsed().reason() != blocks[ix].parsed().reason()
                    || check.source()[block.span()].trim_end()
                        != document.source()[blocks[ix].span()].trim_end()
            })
    {
        return Err(StructureError::SemanticMismatch);
    }
    prepared(document, range, text, Some(caret), EditKind::Format, millis)
}

/// Delete whole blocks through the same atomic history, including opaque blocks selected explicitly.
pub fn delete_blocks(
    document: &Document,
    first: BlockId,
    last: BlockId,
    millis: u64,
) -> StructureResult<Transaction> {
    let range = block_selection(document, first, last)?.range();
    Ok(Transaction::new(
        document.generation(),
        vec![Patch::new(
            range.clone(),
            &document.source()[range.clone()],
            "",
        )],
        EditKind::Format,
        millis,
    )
    .with_selection(Selection::caret(document.generation(), range.start)))
}
