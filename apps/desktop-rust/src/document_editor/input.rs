use super::*;
use anynote_editor::selection::{TextUnit, offset_from_byte};
use std::ops::Range;

fn utf16(text: &str, range: Range<usize>) -> Option<Range<usize>> {
    Some(
        offset_from_byte(text, range.start, TextUnit::Utf16).ok()?
            ..offset_from_byte(text, range.end, TextUnit::Utf16).ok()?,
    )
}
impl DocumentEditor {
    fn composition_replacement(
        &self,
        range: Option<Range<usize>>,
        text: &str,
    ) -> Result<(String, usize)> {
        let Some(composition) = &self.state.composition else {
            return Ok((text.to_owned(), 0));
        };
        let Some(range) = range else {
            return Ok((text.to_owned(), 0));
        };
        let mut preedit = self.state.editor.composition().unwrap().text().to_owned();
        if range.start < composition.range.start
            || range.end > composition.range.start + preedit.len()
        {
            return Err("组合输入的替换范围已越出当前输入区域".into());
        }
        let local = range.start - composition.range.start..range.end - composition.range.start;
        let offset = local.start;
        preedit.replace_range(local, text);
        Ok((preedit, offset))
    }
}
impl EntityInputHandler for DocumentEditor {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        adjusted: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let text = self.state.display_text();
        let bytes = state::native_byte_range(&text, range).ok()?;
        *adjusted = utf16(&text, bytes.clone());
        Some(text[bytes].to_owned())
    }
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: utf16(&self.state.display_text(), self.state.display_selection())?,
            reversed: self.state.anchor > self.state.head,
        })
    }
    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        let c = self.state.composition.as_ref()?;
        utf16(
            &self.state.display_text(),
            c.range.start..c.range.start + self.state.editor.composition()?.text().len(),
        )
    }
    fn unmark_text(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.is_composing() {
            let result = self.state.commit_composition(None);
            self.changed(result, window, cx);
        }
    }
    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let result = if self.is_composing() {
            range
                .map(|r| self.state.utf16_range(r))
                .transpose()
                .and_then(|r| self.composition_replacement(r, text))
                .and_then(|(text, _)| self.state.commit_composition(Some(&text)))
        } else {
            range
                .map(|range| {
                    self.state
                        .utf16_range(range)
                        .and_then(|r| self.state.select(r.start, r.end))
                })
                .unwrap_or(Ok(()))
                .and_then(|_| self.state.replace(text))
        };
        self.changed(result, window, cx);
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        selected: Option<Range<usize>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range.map(|r| self.state.utf16_range(r)).transpose();
        let selection = state::native_byte_range(
            text,
            selected.unwrap_or_else(|| {
                let n = text.encode_utf16().count();
                n..n
            }),
        );
        let result = range.and_then(|range| {
            selection.and_then(|selected| {
                let (text, offset) = self.composition_replacement(range.clone(), text)?;
                self.state.begin_or_update_composition(
                    range,
                    &text,
                    selected.start + offset..selected.end + offset,
                )
            })
        });
        self.changed(result, window, cx);
    }
    fn bounds_for_range(
        &mut self,
        range: Range<usize>,
        _: Bounds<Pixels>,
        window: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let range = self.state.utf16_range(range).ok()?;
        if !self.geometry_valid(window) {
            return None;
        }
        let (ix, byte) = if let Some(c) = &self.state.composition {
            (
                c.leaf,
                c.local.start + range.start.saturating_sub(c.range.start),
            )
        } else {
            self.state.projection.at(range.start)
        };
        let frame = self.geometry.borrow();
        let g = frame.leaves.get(&self.keys[ix])?;
        let start = g.position_for_index(byte);
        let end = g.position_for_index(byte + range.len());
        Some(Bounds::new(
            start,
            size(
                (end.x - start.x).abs().max(px(1. / window.scale_factor())),
                g.line_height(),
            ),
        ))
    }
    fn character_index_for_point(
        &mut self,
        point: Point<Pixels>,
        window: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        let byte = self.hit(point, window)?;
        offset_from_byte(&self.state.display_text(), byte, TextUnit::Utf16).ok()
    }
    fn set_selected_text_range(
        &mut self,
        range: Range<usize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let result = self.state.utf16_range(range).and_then(|r| {
            if let Some(c) = &self.state.composition {
                let text = self.state.editor.composition().unwrap().text().to_owned();
                if r.start < c.range.start || r.end > c.range.start + text.len() {
                    return Err("选区超出组合输入范围".into());
                }
                let selected = r.start - c.range.start..r.end - c.range.start;
                self.state
                    .begin_or_update_composition(None, &text, selected)
            } else {
                self.state.select(r.start, r.end)
            }
        });
        self.changed(result, window, cx);
    }
    fn text_length_utf16(&mut self, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        Some(self.state.display_text().encode_utf16().count())
    }
    fn paste(&mut self, item: ClipboardItem, window: &mut Window, cx: &mut Context<Self>) {
        self.paste_item(item, window, cx);
    }
}
