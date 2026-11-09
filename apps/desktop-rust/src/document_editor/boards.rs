use super::*;
use crate::board::{BoardEvent, BoardSession};
use anynote_editor::model::BlockId;

impl DocumentEditor {
    pub(super) fn insert_board(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.state.save.is_none() || self.is_composing() || self.source_composing(window, cx) {
            self.error = Some("请先打开笔记并完成当前输入".into());
            cx.notify();
            return;
        }
        let id = uuid::Uuid::new_v4();
        let source = anynote_core::board::empty(id);
        let leaf = &self.state.projection.leaves[self.state.projection.at(self.state.head).0];
        let at = leaf
            .id
            .block
            .and_then(|id| self.state.editor.document().block(id))
            .map_or(leaf.span.end, |b| b.span().end);
        let range = if let Some(start) = self.slash_start.take() {
            self.state.projection.source_at(start)..self.state.projection.source_at(self.state.head)
        } else {
            at..at
        };
        self.slash = None;
        let result = self.state.source_edit(range, &format!("\n\n{source}\n"));
        self.changed(result, window, cx);
        self.sync_source(window, cx);
        if let Some(block) = self
            .state
            .editor
            .document()
            .blocks()
            .iter()
            .find(|b| {
                anynote_core::board::parse(&self.source()[b.span()])
                    .is_some_and(|b| b.id() == id.to_string())
            })
            .map(|b| b.id())
        {
            self.queue_board(block, window, cx);
        }
    }
    pub(super) fn queue_board(
        &mut self,
        block: BlockId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.state.save.is_none()
            || self.board.is_some()
            || self.builtin_running
            || self.builtin_request.is_some()
        {
            return;
        }
        self.board_pending = Some(block);
        self.flush(window, cx);
    }
    pub(super) fn start_board(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(block) = self.board_pending.take() else {
            return;
        };
        let Some(save) = &self.state.save else { return };
        let Some(block) = self
            .state
            .editor
            .document()
            .block(block)
            .and_then(|b| anynote_core::board::parse(&self.source()[b.span()]))
        else {
            self.error = Some("白板块已变化，请重新打开".into());
            cx.notify();
            return;
        };
        let (base, epoch, generation) = (
            save.base().clone(),
            save.epoch(),
            self.state.editor.document().generation(),
        );
        let board = cx.new(|cx| BoardSession::new(base.clone(), block, window, cx));
        self.board_subscription =
            Some(
                cx.subscribe_in(&board, window, move |this, _, event, window, cx| {
                    let BoardEvent::Closed(snapshot) = event;
                    this.board = None;
                    this.board_subscription = None;
                    if let Some(snapshot) = snapshot {
                        let current = this.state.save.as_ref().is_some_and(|s| {
                            s.epoch() == epoch
                                && s.base().id() == base.id()
                                && s.base().head() == base.head()
                        }) && this.state.editor.document().generation() == generation;
                        if current {
                            let result = this
                                .state
                                .source_edit(0..this.source().len(), snapshot.content().body());
                            if result.is_ok() {
                                this.state.save.as_mut().unwrap().accept_builtin(
                                    snapshot.clone(),
                                    this.state.editor.document().generation(),
                                );
                            }
                            this.changed(result, window, cx);
                            this.sync_source(window, cx);
                        } else {
                            this.error = Some("白板已保存；当前正文已变化，草稿已保留".into());
                            if let Some(save) = &mut this.state.save {
                                save.remote = Some(snapshot.clone());
                                save.status = session::SaveStatus::Conflict;
                            }
                        }
                    }
                    this.focus.focus(window, cx);
                    this.flush(window, cx);
                }),
            );
        self.board = Some(board);
        cx.notify();
    }
    pub(super) fn render_board_block(
        &mut self,
        first: usize,
        key: u64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let leaf = &self.state.projection.leaves[first];
        let id = leaf.id.block?;
        let block = self.state.editor.document().block(id)?;
        let board = anynote_core::board::parse(&self.source()[block.span()])?;
        let preview = board
            .preview()
            .and_then(|resource| {
                self.render_resource_preview(resource, "白板预览".into(), None, window, cx)
            })
            .map(|(view, _)| view);
        Some(
            div()
                .px_6()
                .py_3()
                .flex()
                .flex_col()
                .gap_3()
                .when_some(preview, |view, preview| view.child(preview))
                .child(div().flex_1().child(if board.resource().is_some() {
                    "白板"
                } else {
                    "空白白板"
                }))
                .child(
                    Button::new(("edit-board", key))
                        .label("编辑白板…")
                        .disabled(self.saving || self.board_pending.is_some())
                        .on_click(cx.listener(move |this, _, w, cx| this.queue_board(id, w, cx))),
                )
                .into_any_element(),
        )
    }
}
