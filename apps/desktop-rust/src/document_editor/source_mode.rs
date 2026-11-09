use super::*;
use anynote_editor::selection::{Affinity, Position, Selection};

impl DocumentEditor {
    pub(super) fn sync_source(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(source) = &self.source {
            let text = self.source().to_owned();
            let selection = self.state.editor.selection();
            source.update(cx, |source, cx| {
                let scroll = source.scroll_offset();
                source.set_value(text, window, cx);
                source.set_selected_range_with_direction(
                    selection.range(),
                    selection.anchor().offset() > selection.head().offset(),
                    cx,
                );
                source.set_scroll_offset(scroll, cx);
            });
        }
    }
    fn capture_source_selection(&mut self, cx: &mut Context<Self>) {
        if let Some(source) = &self.source {
            let source = source.read(cx);
            let range = source.selected_range();
            let (anchor, head) = if source.is_selection_reversed() {
                (range.end, range.start)
            } else {
                (range.start, range.end)
            };
            let _ = self.state.editor.set_selection(Selection::new(
                self.state.editor.document().generation(),
                Position::new(anchor, Affinity::Before),
                Position::new(head, Affinity::After),
            ));
            self.state.refresh();
        }
    }
    pub(super) fn toggle_source(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.is_composing() || self.source_composing(window, cx) {
            self.error = Some("请先完成当前输入".into());
            cx.notify();
            return;
        }
        self.state
            .editor
            .set_selection(self.state.editor.selection())
            .ok();
        if let Some(source) = &self.source {
            // Drain queued input once at the handoff before retiring this widget.
            // Subsequent events from its entity are rejected below.
            let text = source.read(cx).value().to_string();
            if let Err(error) = self.state.source_snapshot(&text) {
                self.error = Some(error);
                cx.notify();
                return;
            }
            self.capture_source_selection(cx);
            let source = self.source.take().unwrap();
            let generation = self.state.editor.document().generation();
            self.source_scroll = Some((source.read(cx).scroll_offset(), generation));
            self.source_subscription = None;
            self.source_blur = None;
            self.changed(Ok(()), window, cx);
            if let Some((scroll, old)) = self.rich_scroll.take()
                && old == generation
            {
                self.layout.scroll_to(scroll);
            }
            self.focus.focus(window, cx);
            cx.notify();
            return;
        }
        self.rich_scroll = Some((
            self.layout.logical_scroll_top(),
            self.state.editor.document().generation(),
        ));
        let text = self.source().to_owned();
        let selection = self.state.editor.selection();
        let scroll = self
            .source_scroll
            .filter(|(_, generation)| *generation == self.state.editor.document().generation());
        let source = cx.new(|cx| {
            let mut input = EditorState::new(window, cx)
                .language("markdown")
                .line_number(true)
                .folding(true);
            input.set_value(text, window, cx);
            input.set_selected_range_with_direction(
                selection.range(),
                selection.anchor().offset() > selection.head().offset(),
                cx,
            );
            if let Some((scroll, _)) = scroll {
                input.set_scroll_offset(scroll, cx);
            }
            input
        });
        self.source_subscription = Some(cx.subscribe_in(
            &source,
            window,
            |this, origin, event: &InputEditsEvent, window, cx| {
                if this
                    .source
                    .as_ref()
                    .is_none_or(|active| active.entity_id() != origin.entity_id())
                {
                    return;
                }
                // A Kit replacement or multicursor command is one history entry. Its
                // immutable final snapshot is independent of later queued input.
                if let Some((_, final_text)) = event.edits().last() {
                    let text = final_text.to_string();
                    let result = this.state.source_snapshot(&text);
                    let failed = result.is_err();
                    this.changed(result, window, cx);
                    if failed {
                        this.sync_source(window, cx);
                    }
                }
            },
        ));
        self.source_blur = Some(cx.subscribe_in(
            &source,
            window,
            |this, _, event: &kit_input::InputEvent, window, cx| {
                if matches!(event, kit_input::InputEvent::Blur) {
                    this.flush(window, cx);
                }
            },
        ));
        source.update(cx, |input, cx| input.focus(window, cx));
        self.source = Some(source);
        self.slash = None;
        self.show_search = false;
        cx.notify();
    }
    pub(super) fn source_format(
        &mut self,
        name: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.source_composing(window, cx) {
            self.error = Some("请先完成当前输入".into());
            cx.notify();
            return;
        }
        self.capture_source_selection(cx);
        let selection = self.state.editor.selection().range();
        let selected = &self.source()[selection.clone()];
        let (before, after) = match name {
            "bold" => ("**", "**"),
            "italic" => ("*", "*"),
            "strike" => ("~~", "~~"),
            "inlineCode" => ("`", "`"),
            "link" => ("[", "](https://)"),
            _ => {
                self.error = Some("该操作需在正文模式使用".into());
                cx.notify();
                return;
            }
        };
        let value = format!("{before}{selected}{after}");
        let result = self.state.source_edit(selection, &value);
        self.changed(result, window, cx);
        self.sync_source(window, cx);
        if let Some(source) = &self.source {
            source.update(cx, |s, cx| s.focus(window, cx));
        }
    }
}
