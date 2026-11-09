use super::*;
use anynote_core::pdf::*;
use gpui_kit::component::{
    WindowExt,
    dialog::{DialogAction, DialogClose, DialogFooter},
};
impl PdfView {
    pub(super) fn reading_toolbar(&self, cx: &mut Context<Self>) -> Div {
        let disabled = self.closed || self.count == 0;
        let selection = self.reading.selection.is_none() || self.loading || self.reading.working;
        div()
            .flex()
            .flex_col()
            .gap_1()
            .px_2()
            .pb_2()
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_2()
                    .child("查找")
                    .child(
                        Input::new(&self.reading.query)
                            .id("pdf-search-input")
                            .aria_label("查找 PDF 文字")
                            .w_48(),
                    )
                    .child(
                        Button::new("pdf-search")
                            .small()
                            .label("搜索")
                            .disabled(disabled)
                            .on_click(cx.listener(|this, _, w, cx| this.search(w, cx))),
                    )
                    .child(
                        Button::new("pdf-hit-next")
                            .small()
                            .label("下一处")
                            .disabled(self.reading.hits.is_empty())
                            .on_click(cx.listener(|this, _, w, cx| {
                                this.reading.hit = (this.reading.hit + 1) % this.reading.hits.len();
                                this.show_hit(w, cx);
                            })),
                    )
                    .child(div().text_sm().child(self.reading.search_status.clone()))
                    .child(
                        Button::new("pdf-index")
                            .small()
                            .label("建立文本索引")
                            .disabled(disabled || !self.reading.current || self.is_indexing())
                            .on_click(cx.listener(|this, _, w, cx| this.start_index(w, cx))),
                    )
                    .when(
                        self.is_indexing() || self.reading.search_job.is_some(),
                        |row| {
                            row.child(
                                Button::new("pdf-cancel-text")
                                    .small()
                                    .label("取消文本任务")
                                    .on_click(
                                        cx.listener(|this, _, _, cx| this.cancel_reading(cx)),
                                    ),
                            )
                        },
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_2()
                    .child("批注")
                    .child(
                        Input::new(&self.reading.comment)
                            .id("pdf-comment")
                            .aria_label("批注内容（可选）")
                            .w_48(),
                    )
                    .child(
                        Button::new("pdf-annotate")
                            .small()
                            .label("保存高亮 / 批注")
                            .disabled(disabled || selection || !self.reading.current)
                            .on_click(cx.listener(|this, _, w, cx| this.annotate(false, w, cx))),
                    )
                    .child(
                        Button::new("pdf-reading-note")
                            .small()
                            .label("创建阅读笔记")
                            .disabled(disabled || selection)
                            .on_click(cx.listener(|this, _, w, cx| this.annotate(true, w, cx))),
                    )
                    .child(
                        Button::new("pdf-copy-page")
                            .small()
                            .label("复制页面回链")
                            .disabled(disabled)
                            .on_click(cx.listener(|this, _, _, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(return_link(
                                    this.scope.document(),
                                    &PdfAnchor::Page(this.page + 1),
                                )))
                            })),
                    ),
            )
            .child(
                div()
                    .id("pdf-reading-status")
                    .test_support()
                    .role(Role::Status)
                    .aria_label(self.reading.status.clone())
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child(self.reading.status.clone()),
            )
    }
    pub(super) fn annotation_panel(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        let count = self.reading.annotations.len();
        let start = (self.reading.annotation_page * 10).min(count.saturating_sub(1) / 10 * 10);
        let stale = self
            .reading
            .annotations
            .iter()
            .filter(|a| a.hash() != self.hash)
            .count();
        div()
            .id("pdf-annotations")
            .w_64()
            .min_w_0()
            .flex_shrink_0()
            .h_full()
            .overflow_y_scroll()
            .border_l_1()
            .border_color(cx.theme().border)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .p_2()
                    .child(format!("批注 · {count}"))
                    .when(
                        !self.reading.current && self.count > 0 && !self.reading.working,
                        |p| p.child("历史修订 · 批注只读"),
                    )
                    .when(count == 0, |p| {
                        p.child(
                            div()
                                .text_sm()
                                .text_color(cx.theme().muted_foreground)
                                .child("拖动选择 PDF 文字，保存高亮或添加批注"),
                        )
                    })
                    .when(stale > 0, |p| {
                        p.child(format!("{stale} 条批注属于历史文件，未叠加到当前页面"))
                            .child(
                                Button::new("pdf-reanchor")
                                    .small()
                                    .label("重锚定历史批注…")
                                    .disabled(!self.reading.current || self.reading.working)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.confirm_reanchor(window, cx)
                                    })),
                            )
                    })
                    .children(
                        self.reading
                            .annotations
                            .iter()
                            .skip(start)
                            .take(10)
                            .map(|a| {
                                let id = a.id();
                                let active = a.hash() == self.hash;
                                let draft = a.draft().clone();
                                div()
                                    .id(SharedString::from(format!("pdf-annotation-{id}")))
                                    .flex()
                                    .flex_col()
                                    .gap_1()
                                    .py_2()
                                    .border_b_1()
                                    .border_color(cx.theme().border)
                                    .child(
                                        Button::new(SharedString::from(format!("pdf-focus-{id}")))
                                            .small()
                                            .label(format!(
                                                "第 {} 页{}",
                                                a.draft().page(),
                                                if active { "" } else { " · 历史文件" }
                                            ))
                                            .selected(self.reading.focused == Some(id))
                                            .on_click(cx.listener(move |this, _, w, cx| {
                                                this.navigate(PdfAnchor::Annotation(id), w, cx)
                                            })),
                                    )
                                    .child(div().text_sm().child(
                                        a.draft().quote().chars().take(160).collect::<String>(),
                                    ))
                                    .child(div().text_sm().child(
                                        a.draft().body().chars().take(240).collect::<String>(),
                                    ))
                                    .child(
                                        div()
                                            .flex()
                                            .flex_wrap()
                                            .gap_1()
                                            .child(
                                                Button::new(SharedString::from(format!(
                                                    "pdf-link-{id}"
                                                )))
                                                .small()
                                                .ghost()
                                                .label("复制回链")
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    cx.write_to_clipboard(
                                                        ClipboardItem::new_string(return_link(
                                                            this.scope.document(),
                                                            &PdfAnchor::Annotation(id),
                                                        )),
                                                    )
                                                })),
                                            )
                                            .child(
                                                Button::new(SharedString::from(format!(
                                                    "pdf-note-{id}"
                                                )))
                                                .small()
                                                .ghost()
                                                .label("阅读笔记")
                                                .disabled(!active || self.reading.working)
                                                .on_click(cx.listener(move |this, _, w, cx| {
                                                    this.mutate(
                                                        PdfCommand::ReadingNote {
                                                            scope: this.scope.clone(),
                                                            hash: this.hash.clone(),
                                                            draft: draft.clone(),
                                                            annotation: Some(id),
                                                        },
                                                        w,
                                                        cx,
                                                    )
                                                })),
                                            )
                                            .child(
                                                Button::new(SharedString::from(format!(
                                                    "pdf-delete-{id}"
                                                )))
                                                .small()
                                                .ghost()
                                                .label("删除")
                                                .disabled(
                                                    !self.reading.current || self.reading.working,
                                                )
                                                .on_click(cx.listener(move |this, _, w, cx| {
                                                    this.mutate(
                                                        PdfCommand::Delete {
                                                            scope: this.scope.clone(),
                                                            hash: this.hash.clone(),
                                                            annotation: id,
                                                        },
                                                        w,
                                                        cx,
                                                    )
                                                })),
                                            ),
                                    )
                            }),
                    )
                    .when(count > 10, |p| {
                        p.child(
                            div()
                                .flex()
                                .gap_2()
                                .child(
                                    Button::new("pdf-annotations-prev")
                                        .small()
                                        .label("上一组")
                                        .disabled(start == 0)
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.reading.annotation_page =
                                                this.reading.annotation_page.saturating_sub(1);
                                            cx.notify();
                                        })),
                                )
                                .child(
                                    Button::new("pdf-annotations-next")
                                        .small()
                                        .label("下一组")
                                        .disabled(start + 10 >= count)
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.reading.annotation_page += 1;
                                            cx.notify();
                                        })),
                                ),
                        )
                    }),
            )
    }
    fn confirm_reanchor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let owner = cx.weak_entity();
        window.open_dialog(cx, move |dialog, _, _| {
            let owner = owner.clone();
            dialog
                .title("将历史批注绑定到当前 PDF？")
                .child("旧页码和坐标会用于当前文件。请先核对页面内容，重锚定不会自动匹配文字。")
                .footer(
                    DialogFooter::new()
                        .child(DialogClose::new().trigger(|b| b.label("取消")))
                        .child(
                            DialogAction::new().child(
                                Button::new("pdf-confirm-reanchor")
                                    .primary()
                                    .label("重锚定"),
                            ),
                        ),
                )
                .on_ok(move |_, window, cx| {
                    let _ = owner.update(cx, |this, cx| {
                        this.mutate(
                            PdfCommand::Reanchor {
                                scope: this.scope.clone(),
                                hash: this.hash.clone(),
                            },
                            window,
                            cx,
                        )
                    });
                    true
                })
        });
    }
}
