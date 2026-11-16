use super::*;
use gpui_kit::assets::IconName;
use gpui_kit::component::tooltip::Tooltip;

impl Workspace {
    pub(super) fn document_inspector(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(snapshot) = &self.snapshot else {
            return div().into_any_element();
        };
        if self.revision.is_some() {
            return self.history_inspector(cx);
        }
        let editor = self.editor.as_ref().map(|editor| editor.read(cx));
        let mut outline = div().flex().flex_col().gap_1();
        if let Some(editor) = editor {
            let active_heading = if self.reading {
                None
            } else {
                editor.active_heading()
            };
            let base_level = editor
                .headings()
                .map(|(_, level, _)| level)
                .min()
                .unwrap_or(1);
            for (key, level, title) in editor.headings() {
                let target = title.to_owned();
                let active = active_heading == Some(key);
                outline = outline.child(
                    Button::new(("outline-heading", key))
                        .small()
                        .ghost()
                        .w_full()
                        .justify_start()
                        .selected(active)
                        .disabled(editor.is_composing() || editor.has_source_editor())
                        .accessibility_label(format!("定位标题：{title}"))
                        .tooltip(title.to_owned())
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .text_left()
                                .text_sm()
                                .font_weight(FontWeight::NORMAL)
                                .text_color(if active {
                                    cx.theme().accent_foreground
                                } else {
                                    cx.theme().muted_foreground
                                })
                                .truncate()
                                .pl(rems(f32::from(level.saturating_sub(base_level)) * 0.75))
                                .child(title.to_owned()),
                        )
                        .on_click(cx.listener(move |this, _, window, cx| {
                            if this.reading {
                                this.follow_link(&format!("#{target}"), window, cx);
                            } else if let Some(editor) = &this.editor {
                                editor
                                    .update(cx, |editor, cx| editor.focus_heading(key, window, cx));
                            }
                        })),
                );
            }
            if editor.headings().next().is_none() {
                outline = outline.child(
                    div()
                        .text_sm()
                        .text_color(cx.theme().muted_foreground)
                        .child("添加标题后，大纲会显示在这里"),
                );
            }
        }
        let body = editor.map_or(snapshot.content().body(), |editor| editor.text());
        let characters = body.chars().filter(|c| !c.is_whitespace()).count();
        let mut properties = div()
            .flex()
            .flex_col()
            .gap_2()
            .p_4()
            .flex_shrink_0()
            .border_t_1()
            .border_color(cx.theme().border)
            .bg(cx.theme().muted)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .text_xs()
                    .font_weight(FontWeight::SEMIBOLD)
                    .mb_1()
                    .child(gpui_kit::component::Icon::new(IconName::ChartColumn).small())
                    .child("文档属性与统计"),
            );
        for (label, value) in [
            ("字数统计", format!("{characters}")),
            (
                "预计阅读",
                format!("{} 分钟", characters.div_ceil(400).max(1)),
            ),
            (
                "标签",
                if snapshot.content().tags().is_empty() {
                    "未添加".into()
                } else {
                    snapshot.content().tags().join(" · ")
                },
            ),
        ] {
            properties = properties.child(
                div()
                    .flex()
                    .items_start()
                    .gap_3()
                    .text_xs()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_color(cx.theme().muted_foreground)
                            .child(label),
                    )
                    .child(div().min_w_0().max_w_32().text_right().child(value)),
            );
        }
        div()
            .id("workspace-inspector")
            .test_support()
            .flex()
            .flex_col()
            .h_full()
            .w(rems(17.5))
            .flex_shrink_0()
            .bg(cx.theme().muted)
            .when(cx.theme().is_dark(), |view| view.bg(cx.theme().sidebar))
            .border_l_1()
            .border_color(cx.theme().border)
            .child(
                div()
                    .id("workspace-outline-header")
                    .test_support()
                    .flex()
                    .items_center()
                    .flex_shrink_0()
                    .h_10()
                    .px_4()
                    .gap_2()
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .bg(cx.theme().background)
                    .child(
                        gpui_kit::component::Icon::new(IconName::ListTree)
                            .small()
                            .text_color(cx.theme().primary),
                    )
                    .child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(cx.theme().muted_foreground)
                            .child("大纲目录与上下文"),
                    ),
            )
            .child(
                div()
                    .id("workspace-outline")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scrollbar()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_2()
                            .m_3()
                            .p_1()
                            .when(!cx.theme().is_dark(), |view| {
                                view.p_3()
                                    .border_1()
                                    .border_color(cx.theme().border)
                                    .rounded(cx.theme().radius_lg)
                                    .bg(cx.theme().background)
                            })
                            .child(
                                div()
                                    .id("workspace-outline-title")
                                    .min_w_0()
                                    .px_2()
                                    .py_2()
                                    .text_sm()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(cx.theme().accent_foreground)
                                    .truncate()
                                    .tooltip({
                                        let title = snapshot.content().title().to_owned();
                                        move |window, cx| {
                                            Tooltip::new(title.clone()).build(window, cx)
                                        }
                                    })
                                    .child(snapshot.content().title().to_owned()),
                            )
                            .child(outline),
                    ),
            )
            .child(properties)
            .into_any_element()
    }

    fn history_inspector(&self, cx: &App) -> AnyElement {
        div()
            .w(rems(17.5))
            .h_full()
            .flex_shrink_0()
            .p_4()
            .border_l_1()
            .border_color(cx.theme().border)
            .bg(cx.theme().sidebar)
            .text_sm()
            .text_color(cx.theme().muted_foreground)
            .child("正在预览历史版本，返回当前版本后可查看大纲与统计")
            .into_any_element()
    }
}
