use super::*;
use anynote_editor::inline::Mark;

pub(super) const COMMANDS: &[(&str, &str, IconName)] = &[
    ("reading-card", "阅读卡片", IconName::BookOpenText),
    ("callout", "提示块", IconName::MessageSquare),
    ("details", "折叠块", IconName::PanelTopOpen),
    ("paragraph", "正文", IconName::Pilcrow),
    ("h1", "一级标题", IconName::Heading1),
    ("h2", "二级标题", IconName::Heading2),
    ("h3", "三级标题", IconName::Heading3),
    ("h4", "四级标题", IconName::Heading4),
    ("h5", "五级标题", IconName::Heading5),
    ("h6", "六级标题", IconName::Heading6),
    ("bullet", "无序列表", IconName::List),
    ("ordered", "有序列表", IconName::ListOrdered),
    ("task", "任务列表", IconName::ListTodo),
    ("quote", "引用", IconName::Quote),
    ("code", "代码块", IconName::SquareCode),
    ("table", "表格", IconName::Table),
    ("rule", "分隔线", IconName::Minus),
    ("break", "换行", IconName::TextWrap),
    ("image", "图片…", IconName::Image),
    ("board", "白板…", IconName::Presentation),
    ("video", "视频…", IconName::Video),
];

pub(super) const FORMATTING: &[(&str, &str, IconName)] = &[
    ("bold", "加粗", IconName::Bold),
    ("italic", "斜体", IconName::Italic),
    ("strike", "删除线", IconName::Strikethrough),
    ("inlineCode", "行内代码", IconName::Code),
    ("link", "链接…", IconName::Link),
];

pub(super) fn icon_button(
    id: impl Into<ElementId>,
    icon: IconName,
    label: impl Into<SharedString>,
) -> Button {
    let label = label.into();
    Button::new(id)
        .small()
        .ghost()
        .icon(icon)
        .accessibility_label(label.clone())
        .tooltip(label)
}

impl DocumentEditor {
    pub(super) fn format_button(
        &self,
        id: impl Into<ElementId>,
        command: &str,
        label: &str,
        icon: IconName,
    ) -> Button {
        let mark = match command {
            "bold" => Some(Mark::Strong),
            "italic" => Some(Mark::Emphasis),
            "strike" => Some(Mark::Strike),
            "inlineCode" => Some(Mark::Code),
            _ => None,
        };
        let selected = self.source.is_none() && mark.is_some_and(|mark| self.state.marks.has(mark));
        icon_button(id, icon, label.to_owned())
            .tooltip_with_action(
                label.to_owned(),
                &RunCommand::new(command),
                Some("AnyNoteDocument"),
            )
            .selected(selected)
            .when(self.source.is_none() && mark.is_some(), |button| {
                button.toggled(selected)
            })
            .disabled(
                self.is_composing()
                    || (command == "link"
                        && self.source.is_none()
                        && self.state.range().is_empty()),
            )
    }

    pub(super) fn render_toolbar(&self, cx: &mut Context<Self>) -> AnyElement {
        let focus = self.focus.clone();
        let mut toolbar = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap_1()
            .px_4()
            .py_2()
            .border_b_1()
            .border_color(cx.theme().border)
            .child(self.reading_menu(cx))
            .child(
                icon_button("insert-content", IconName::Plus, "插入内容")
                    .disabled(self.is_composing() || self.source.is_some())
                    .dropdown_menu(move |menu, _, _| {
                        COMMANDS.iter().fold(
                            menu.action_context(focus.clone()),
                            |menu, (id, label, icon)| {
                                menu.menu_with_icon(*label, *icon, Box::new(RunCommand::new(*id)))
                            },
                        )
                    }),
            );
        for &(id, label, icon) in FORMATTING {
            toolbar = toolbar.child(self.format_button(id, id, label, icon).on_click(
                cx.listener(move |this, _, window, cx| this.run(&RunCommand::new(id), window, cx)),
            ));
        }
        for (id, label, icon, steps) in [
            (
                "undo",
                "撤销",
                IconName::Undo2,
                self.state.editor.undo_steps(),
            ),
            (
                "redo",
                "重做",
                IconName::Redo2,
                self.state.editor.redo_steps(),
            ),
        ] {
            toolbar = toolbar.child(
                icon_button(id, icon, label)
                    .tooltip_with_action(label, &RunCommand::new(id), Some("AnyNoteDocument"))
                    .disabled(
                        self.is_composing() || (steps == 0 && self.state.pending_task.is_none()),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.run(&RunCommand::new(id), window, cx)
                    })),
            );
        }
        let leaf = &self.state.projection.leaves[self.state.projection.at(self.state.head).0];
        if self.source.is_none() && leaf.marker.is_some() {
            let first_item = leaf.id.path.iter().rev().nth(1) == Some(&0);
            for (id, label, icon) in [
                ("outdent", "减少列表缩进", IconName::ListIndentDecrease),
                ("indent", "增加列表缩进", IconName::ListIndentIncrease),
            ] {
                toolbar = toolbar.child(
                    icon_button(id, icon, label)
                        .disabled(self.is_composing() || (id == "indent" && first_item))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.run(&RunCommand::new(id), window, cx)
                        })),
                );
            }
        }
        if self.source.is_none() && leaf.kind == NodeKind::Cell {
            for (id, label, icon) in [
                ("row", "增加表格行", IconName::TableRowsSplit),
                ("column", "增加表格列", IconName::TableColumnsSplit),
                ("deleteRow", "删除表格行", IconName::Rows2),
                ("deleteColumn", "删除表格列", IconName::Columns2),
            ] {
                toolbar =
                    toolbar.child(
                        icon_button(id, icon, label)
                            .disabled(self.is_composing())
                            .on_click(cx.listener(move |this, _, w, cx| {
                                this.run(&RunCommand::new(id), w, cx)
                            })),
                    );
            }
        }
        toolbar
            .child(
                icon_button("find-text", IconName::Search, "查找正文")
                    .selected(self.show_search)
                    .when(self.source.is_none(), |button| {
                        button.toggled(self.show_search)
                    })
                    .on_click(cx.listener(|this, _, window, cx| {
                        if let Some(source) = &this.source {
                            source.update(cx, |s, cx| s.open_search(true, cx));
                            return;
                        }
                        this.show_search = !this.show_search;
                        if this.show_search {
                            this.search.update(cx, |s, cx| s.focus(window, cx));
                        }
                        cx.notify();
                    })),
            )
            .child(
                icon_button(
                    "source-mode",
                    if self.source.is_some() {
                        IconName::FileText
                    } else {
                        IconName::FileCode
                    },
                    if self.source.is_some() {
                        "返回正文"
                    } else {
                        "编辑 Markdown 原文"
                    },
                )
                .selected(self.source.is_some())
                .toggled(self.source.is_some())
                .disabled(self.is_composing())
                .on_click(cx.listener(|this, _, window, cx| this.toggle_source(window, cx))),
            )
            .into_any_element()
    }
}
