use super::forms::FormKind;
use super::*;
use gpui_kit::{
    InteractiveElement, Render, SharedString, StatefulInteractiveElement, TestSupportExt,
    component::{
        ActiveTheme, Disableable, Selectable, button::ButtonVariants, scroll::ScrollableElement,
    },
    div,
};
impl ManagementView {
    fn action_button(
        &mut self,
        id: impl Into<gpui_kit::ElementId>,
        label: impl Into<SharedString>,
        operation: Operation,
        cx: &mut Context<Self>,
    ) -> Button {
        let id = id.into();
        let focus = self.trigger(&format!("{id:?}"), cx);
        Button::new(id)
            .track_focus(&focus)
            .label(label)
            .disabled(self.submitting)
            .on_click(cx.listener(move |this, _, window, cx| {
                focus.focus(window, cx);
                this.activate(operation.clone(), window, cx)
            }))
    }
    fn tasks_view(&self, cx: &mut Context<Self>) -> gpui_kit::Div {
        let mut view = div().flex().flex_col().gap_2().child("任务历史");
        if self.tasks.is_empty() {
            view = view.child("还没有任务。添加备份目标，或运行完整性检查。");
        }
        for task in self.tasks.iter().rev().skip(self.task_page * 10).take(10) {
            let id = task.id();
            let job = self.jobs.iter().find(|j| j.task().id() == id);
            let title = job.map(|j| j.title()).unwrap_or("后台任务");
            let mut row = div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap_2()
                .child(
                    Button::new(SharedString::from(format!("management-task-{id}")))
                        .ghost()
                        .label(format!("{} · {}", title, status_name(task.status())))
                        .selected(self.selected == Some(id))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.selected = Some(id);
                            this.report_page = 0;
                            this.action_page = 0;
                            cx.notify();
                        })),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(cx.theme().muted_foreground)
                        .child(format!("更新于{}", relative_time(task.updated_at_ms()))),
                );
            if task.status() == TaskStatus::Running {
                row = row.child(
                    Button::new(SharedString::from(format!("management-cancel-{id}")))
                        .label(if job.is_some_and(JobDetails::cancel_requested) {
                            "正在取消…"
                        } else {
                            "取消"
                        })
                        .disabled(self.submitting || job.is_some_and(JobDetails::cancel_requested))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.send(Command::CancelTask { task_id: id }, window, cx)
                        })),
                );
            }
            if job.is_some_and(JobDetails::can_retry) {
                row = row.child(
                    Button::new(SharedString::from(format!("management-retry-{id}")))
                        .label("重试")
                        .disabled(self.submitting)
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.send(
                                Command::Management(ManagementCommand::Retry { task: id }),
                                window,
                                cx,
                            )
                        })),
                );
            }
            view = view.child(row);
        }
        view.child(self.pagination(self.tasks.len(), 10, cx))
    }
    fn pagination(&self, count: usize, size: usize, cx: &mut Context<Self>) -> gpui_kit::Div {
        div()
            .flex()
            .gap_2()
            .child(
                Button::new("management-list-prev")
                    .label("上一页")
                    .disabled(self.task_page == 0)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.task_page = this.task_page.saturating_sub(1);
                        cx.notify();
                    })),
            )
            .child(format!(
                "{} / {}",
                self.task_page + 1,
                count.div_ceil(size).max(1)
            ))
            .child(
                Button::new("management-list-next")
                    .label("下一页")
                    .disabled((self.task_page + 1) * size >= count)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.task_page += 1;
                        cx.notify();
                    })),
            )
    }
    fn diagnostics_view(&mut self, cx: &mut Context<Self>) -> gpui_kit::Div {
        let mut view = div()
            .flex()
            .flex_col()
            .gap_3()
            .child("诊断记录只包含运行事件与计数，不记录笔记内容或访问令牌。");
        let level = self.diagnostics.as_ref().map(DiagnosticSnapshot::level);
        let mut levels = div().flex().flex_wrap().gap_2().child("记录级别");
        for (id, label, l) in [
            ("off", "关闭", DiagnosticLevel::Off),
            ("minimal", "最小", DiagnosticLevel::Minimal),
            ("full", "详细", DiagnosticLevel::Full),
        ] {
            levels = levels.child(
                Button::new(SharedString::from(format!("diagnostics-{id}")))
                    .label(label)
                    .selected(level == Some(l))
                    .disabled(self.submitting)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.send(Command::SetDiagnosticLevel { level: l }, window, cx)
                    })),
            );
        }
        view = view.child(levels).child(
            div()
                .flex()
                .gap_2()
                .child(
                    Button::new("diagnostics-export")
                        .label("导出诊断…")
                        .on_click(
                            cx.listener(|this, _, window, cx| this.export_diagnostics(window, cx)),
                        ),
                )
                .child(
                    Button::new("diagnostics-clear")
                        .track_focus(&self.trigger("diagnostics-clear", cx))
                        .label("清空诊断…")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.focus_trigger("diagnostics-clear", window, cx);
                            let owner = cx.weak_entity();
                            window.open_dialog(cx, move |dialog, _, _| {
                                let owner = owner.clone();
                                dialog
                                    .title("清空诊断记录？")
                                    .child("清空后无法恢复。可先导出需要保留的记录。")
                                    .footer(
                                        DialogFooter::new()
                                            .child(DialogClose::new().trigger(|b| b.label("取消")))
                                            .child(
                                                DialogAction::new().child(
                                                    Button::new("diagnostics-clear-confirm")
                                                        .danger()
                                                        .label("清空"),
                                                ),
                                            ),
                                    )
                                    .on_ok(move |_, window, cx| {
                                        let _ = owner.update(cx, |this, cx| {
                                            this.send(Command::ClearDiagnostics, window, cx)
                                        });
                                        true
                                    })
                            });
                        })),
                )
                .child(
                    Button::new("management-integrity")
                        .track_focus(&self.trigger("management-integrity", cx))
                        .label("检查笔记本完整性…")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.form(FormKind::Integrity, window, cx)
                        })),
                ),
        );
        if let Some(d) = &self.diagnostics {
            view = view.child(format!(
                "{} 条记录 · {} 个采样 · {} 条丢弃",
                d.events().len(),
                d.samples(),
                d.dropped()
            ));
            for e in d.events().iter().rev().skip(self.task_page * 15).take(15) {
                view = view.child(format!(
                    "{} · {:?} · {:?} · {} ms · {} 字节",
                    e.timestamp_ms(),
                    e.kind(),
                    e.code(),
                    e.elapsed_ms(),
                    e.bytes()
                ));
            }
            view = view.child(self.pagination(d.events().len(), 15, cx));
        } else {
            view = view.child("正在读取诊断记录…");
        }
        view
    }
    fn targets_view(&mut self, cloud: bool, cx: &mut Context<Self>) -> gpui_kit::Div {
        let mut view = div().flex().flex_col().gap_3();
        let mut tools = div().flex().flex_wrap().gap_2();
        if cloud {
            tools = tools
                .child(
                    Button::new("management-add-connection")
                        .track_focus(&self.trigger("management-add-connection", cx))
                        .label("添加云连接…")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.form(FormKind::Connection, window, cx)
                        })),
                )
                .child(
                    Button::new("management-add-cloud")
                        .track_focus(&self.trigger("management-add-cloud", cx))
                        .label("添加备份目标…")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.form(FormKind::Cloud, window, cx)
                        })),
                )
                .child(
                    Button::new("management-retention")
                        .track_focus(&self.trigger("management-retention", cx))
                        .label("保留策略…")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.form(FormKind::Retention, window, cx)
                        })),
                );
        } else {
            tools = tools
                .child(
                    Button::new("management-add-local")
                        .track_focus(&self.trigger("management-add-local", cx))
                        .label("添加备份目标…")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.form(FormKind::Local, window, cx)
                        })),
                )
                .child(
                    Button::new("management-edit-local")
                        .track_focus(&self.trigger("management-edit-local", cx))
                        .label("修改备份范围…")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.form(FormKind::EditLocal, window, cx)
                        })),
                )
                .child(
                    Button::new("management-cleanup")
                        .track_focus(&self.trigger("management-cleanup", cx))
                        .label("预览本地清理…")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.form(FormKind::Cleanup, window, cx)
                        })),
                );
        }
        view = view.child(tools);
        let choices = self
            .overview
            .choices()
            .iter()
            .filter(|c| {
                if cloud {
                    matches!(c.kind(), ChoiceKind::CloudTarget | ChoiceKind::Connection)
                } else {
                    *c.kind() == ChoiceKind::LocalTarget
                }
            })
            .cloned()
            .collect::<Vec<_>>();
        if choices.is_empty() {
            view = view.child("尚未添加备份目标。添加后可立即手动备份，自动备份默认暂停。");
        }
        for choice in choices.iter().skip(self.task_page * 5).take(5) {
            let target = choice.id().to_owned();
            let mut row = div()
                .flex()
                .flex_col()
                .gap_2()
                .border_b_1()
                .border_color(cx.theme().border)
                .pb_3()
                .child(choice.name().to_owned());
            for (name, value) in self.overview.lines().iter().filter(|(name, _)| {
                name == choice.name() || name == &format!("{} · 调度", choice.name())
            }) {
                row = row.child(div().text_sm().child(format!("{name}：{value}")));
            }
            let operations = match choice.kind() {
                ChoiceKind::LocalTarget => vec![
                    Operation::LocalBackup {
                        target: target.clone(),
                    },
                    Operation::LocalContents {
                        target: target.clone(),
                        offset: 0,
                    },
                    Operation::SetPaused {
                        target: target.clone(),
                        paused: true,
                    },
                    Operation::SetPaused {
                        target,
                        paused: false,
                    },
                ],
                ChoiceKind::Connection => vec![
                    Operation::TestConnection {
                        connection: target.clone(),
                    },
                    Operation::Discover {
                        connection: target.clone(),
                        cursor: None,
                    },
                    Operation::Devices { connection: target },
                ],
                ChoiceKind::CloudTarget => vec![
                    Operation::CloudBackup {
                        target: target.clone(),
                    },
                    Operation::CloudStatus {
                        target: target.clone(),
                    },
                    Operation::WriterPreview {
                        target: target.clone(),
                    },
                    Operation::RetentionPreview {
                        target: target.clone(),
                    },
                    Operation::Maintenance {
                        target: target.clone(),
                    },
                    Operation::PairDevice {
                        target: target.clone(),
                    },
                    Operation::ConsumeCaptures {
                        target: target.clone(),
                    },
                    Operation::SetPaused {
                        target: target.clone(),
                        paused: true,
                    },
                    Operation::SetPaused {
                        target,
                        paused: false,
                    },
                ],
                _ => vec![],
            };
            let mut buttons = div().flex().flex_wrap().gap_2();
            for operation in operations {
                buttons = buttons.child(self.action_button(
                    SharedString::from(format!("management-{}-{}", choice.id(), operation.title())),
                    operation.title(),
                    operation,
                    cx,
                ));
            }
            view = view.child(row.child(buttons));
        }
        view.child(self.pagination(choices.len(), 5, cx))
    }
    fn restore_view(&mut self, cx: &mut Context<Self>) -> gpui_kit::Div {
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child("选择恢复来源，再选择目的地。服务会先校验备份并创建新笔记本，源库保持不变。")
            .child(
                Button::new("management-connect-local")
                    .track_focus(&self.trigger("management-connect-local", cx))
                    .label("连接已有备份磁盘…")
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.form(FormKind::ConnectLocal, window, cx)
                    })),
            )
            .child(
                Button::new("management-restore-archive")
                    .label("从归档恢复…")
                    .on_click(cx.listener(|this, _, window, cx| this.restore_archive(window, cx))),
            )
            .child(
                Button::new("management-restore-local")
                    .label("浏览本地备份")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.page = Page::Local;
                        this.task_page = 0;
                        cx.notify();
                    })),
            )
            .child(
                Button::new("management-restore-cloud")
                    .label("浏览云备份")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.page = Page::Cloud;
                        this.task_page = 0;
                        cx.notify();
                    })),
            )
            .child("没有本地笔记本时，也可以添加云连接并浏览云端版本。")
    }
    fn report_view(&mut self, cx: &mut Context<Self>) -> gpui_kit::Div {
        let mut view = div()
            .flex()
            .flex_col()
            .gap_2()
            .border_t_1()
            .border_color(cx.theme().border)
            .pt_4();
        let Some(job) = self
            .jobs
            .iter()
            .find(|j| Some(j.task().id()) == self.selected)
            .cloned()
        else {
            return view.child("选择任务后可查看结果、重试或继续恢复操作。");
        };
        view = view
            .child(format!(
                "{} · {}",
                job.title(),
                status_name(job.task().status())
            ))
            .child(
                div()
                    .id("management-report-summary")
                    .test_support()
                    .role(gpui_kit::Role::Status)
                    .aria_label(job.report().summary().to_owned())
                    .child(job.report().summary().to_owned()),
            );
        for (label, value) in job
            .report()
            .lines()
            .iter()
            .skip(self.report_page * 15)
            .take(15)
        {
            view = view.child(div().text_sm().child(format!("{label}：{value}")));
        }
        if job.report().lines().len() > 15 {
            view = view.child(
                div()
                    .flex()
                    .gap_2()
                    .child(
                        Button::new("management-report-prev")
                            .label("上一页详情")
                            .disabled(self.report_page == 0)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.report_page = this.report_page.saturating_sub(1);
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("management-report-next")
                            .label("下一页详情")
                            .disabled((self.report_page + 1) * 15 >= job.report().lines().len())
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.report_page += 1;
                                cx.notify();
                            })),
                    ),
            );
        }
        let mut actions = div().flex().flex_wrap().gap_2();
        for action in job
            .report()
            .actions()
            .iter()
            .skip(self.action_page * 8)
            .take(8)
        {
            let identity = serde_json::to_string(action.operation()).unwrap_or_default();
            actions = actions.child(self.action_button(
                SharedString::from(format!("management-result-{identity}")),
                action.label().to_owned(),
                action.operation().clone(),
                cx,
            ));
        }
        view = view.child(actions);
        if job.report().actions().len() > 8 {
            view = view.child(
                div()
                    .flex()
                    .gap_2()
                    .child(
                        Button::new("management-actions-prev")
                            .label("上一页操作")
                            .disabled(self.action_page == 0)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.action_page = this.action_page.saturating_sub(1);
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("management-actions-next")
                            .label("下一页操作")
                            .disabled((self.action_page + 1) * 8 >= job.report().actions().len())
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.action_page += 1;
                                cx.notify();
                            })),
                    ),
            );
        }
        view
    }
}
impl Render for ManagementView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut navigation = div().flex().flex_wrap().gap_2();
        for (id, label, page) in [
            ("tasks", "任务", Page::Tasks),
            ("diagnostics", "诊断", Page::Diagnostics),
            ("local", "本地备份", Page::Local),
            ("cloud", "云备份", Page::Cloud),
            ("restore", "恢复", Page::Restore),
        ] {
            navigation = navigation.child(
                Button::new(SharedString::from(format!("management-page-{id}")))
                    .label(label)
                    .selected(self.page == page)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.page = page;
                        this.task_page = 0;
                        this.refresh(window, cx);
                        cx.notify();
                    })),
            );
        }
        let page = match self.page {
            Page::Tasks => self.tasks_view(cx),
            Page::Diagnostics => self.diagnostics_view(cx),
            Page::Local => self.targets_view(false, cx),
            Page::Cloud => self.targets_view(true, cx),
            Page::Restore => self.restore_view(cx),
        };
        div()
            .id("management-root")
            .track_focus(&self.focus)
            .flex()
            .flex_col()
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .p_4()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap_2()
                            .child(div().text_xl().child("备份与管理"))
                            .child(
                                Button::new("management-refresh")
                                    .label("刷新 / 重新连接")
                                    .disabled(self.submitting)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.reconnect(window, cx)
                                    })),
                            ),
                    )
                    .child(navigation)
                    .child(
                        div()
                            .id("management-status")
                            .role(gpui_kit::Role::Status)
                            .test_support()
                            .aria_label(self.status.clone())
                            .text_sm()
                            .child(self.status.clone()),
                    ),
            )
            .child(
                div()
                    .id("management-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scrollbar()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .p_4()
                            .gap_4()
                            .child(page)
                            .child(self.report_view(cx)),
                    ),
            )
    }
}

fn relative_time(timestamp: u64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let seconds = now.saturating_sub(timestamp) / 1000;
    match seconds {
        0..60 => "刚刚".into(),
        60..3600 => format!("{} 分钟前", seconds / 60),
        3600..86400 => format!("{} 小时前", seconds / 3600),
        _ => format!("{} 天前", seconds / 86400),
    }
}
