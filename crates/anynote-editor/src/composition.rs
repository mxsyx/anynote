use crate::{
    selection::{Selection, TextUnit, byte_range},
    transaction::EditError,
};
use std::ops::Range;

/// An ephemeral overlay. Neither preedit text nor its selection is a committed document change.
#[derive(Debug)]
pub struct Composition {
    token: u64,
    generation: u64,
    range: Range<usize>,
    text: String,
    selection: Range<usize>,
    before: Selection,
}
impl Composition {
    pub(crate) fn new(token: u64, generation: u64, range: Range<usize>, before: Selection) -> Self {
        Self {
            token,
            generation,
            range,
            text: String::new(),
            selection: 0..0,
            before,
        }
    }
    pub fn token(&self) -> u64 {
        self.token
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn range(&self) -> Range<usize> {
        self.range.clone()
    }
    pub fn text(&self) -> &str {
        &self.text
    }
    /// Byte range relative to preedit text, not the underlying source.
    pub fn selection(&self) -> Range<usize> {
        self.selection.clone()
    }
    pub fn marked_range(&self) -> Range<usize> {
        self.range.start..self.range.start + self.text.len()
    }
    pub(crate) fn before(&self) -> Selection {
        self.before
    }
    pub(crate) fn update(
        &mut self,
        text: String,
        selection: Range<usize>,
        unit: TextUnit,
    ) -> Result<(), EditError> {
        let selection = byte_range(&text, selection, unit)?;
        self.text = text;
        self.selection = selection;
        Ok(())
    }
}
