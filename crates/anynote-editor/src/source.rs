//! Local source serialization: untouched bytes are copied, never pretty-printed.
use std::ops::Range;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceError {
    Stale,
    InvalidRange,
    InvalidDirective,
    IdExhausted,
}

#[derive(Clone, Debug)]
pub struct SourceEdit<'a> {
    range: Range<usize>,
    expected: &'a str,
    replacement: &'a str,
}
impl<'a> SourceEdit<'a> {
    pub fn new(range: Range<usize>, expected: &'a str, replacement: &'a str) -> Self {
        Self {
            range,
            expected,
            replacement,
        }
    }
    pub fn range(&self) -> Range<usize> {
        self.range.clone()
    }
    pub fn replacement(&self) -> &str {
        self.replacement
    }
    pub(crate) fn validate(&self, source: &str) -> Result<(), SourceError> {
        let current = source
            .get(self.range.clone())
            .ok_or(SourceError::InvalidRange)?;
        if current != self.expected {
            return Err(SourceError::Stale);
        }
        Ok(())
    }
    pub fn serialize(&self, source: &str) -> Result<String, SourceError> {
        self.validate(source)?;
        let mut result =
            String::with_capacity(source.len() - self.range.len() + self.replacement.len());
        result.push_str(&source[..self.range.start]);
        result.push_str(self.replacement);
        result.push_str(&source[self.range.end..]);
        Ok(result)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChangeMap {
    old: Range<usize>,
    new: Range<usize>,
}
impl ChangeMap {
    pub(crate) fn new(old: Range<usize>, length: usize) -> Self {
        let new = old.start..old.start + length;
        Self { old, new }
    }
    pub fn old_range(&self) -> Range<usize> {
        self.old.clone()
    }
    pub fn new_range(&self) -> Range<usize> {
        self.new.clone()
    }
    /// Interior positions collapse to the chosen edge; callers retain their own affinity.
    pub fn map_offset(&self, offset: usize, after: bool) -> usize {
        if offset < self.old.start {
            offset
        } else if offset > self.old.end {
            self.new.end + (offset - self.old.end)
        } else if after {
            self.new.end
        } else {
            self.new.start
        }
    }
    pub(crate) fn unchanged_range(&self, span: Range<usize>) -> Option<Range<usize>> {
        if span.end <= self.old.start {
            Some(span)
        } else if span.start >= self.old.end {
            Some(
                self.new.end + (span.start - self.old.end)
                    ..self.new.end + (span.end - self.old.end),
            )
        } else {
            None
        }
    }
}

/// Prefer the current line ending, then the previous line, then LF. Use only for new text.
pub fn newline_at(source: &str, offset: usize) -> Result<&'static str, SourceError> {
    if !source.is_char_boundary(offset) {
        return Err(SourceError::InvalidRange);
    }
    let bytes = source.as_bytes();
    let next = bytes[offset..]
        .iter()
        .position(|b| matches!(b, b'\r' | b'\n'))
        .map(|ix| offset + ix);
    let previous = bytes[..offset]
        .iter()
        .rposition(|b| matches!(b, b'\r' | b'\n'));
    let at = next.or(previous);
    Ok(match at {
        Some(ix) if bytes[ix] == b'\r' && bytes.get(ix + 1) == Some(&b'\n') => "\r\n",
        Some(ix) if bytes[ix] == b'\n' && ix > 0 && bytes[ix - 1] == b'\r' => "\r\n",
        Some(ix) if bytes[ix] == b'\r' => "\r",
        _ => "\n",
    })
}
