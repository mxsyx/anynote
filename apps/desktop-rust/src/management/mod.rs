//! GPUI management views consume the backend's task history and typed reports.
mod forms;
mod render;
use crate::{
    backend_client::{BackendClient, Response},
    backend_session::BackendSession,
};
use anynote_core::{backend::*, management::*};
use gpui_kit::{
    App, AppContext, Context, Entity, FocusHandle, IntoElement, ParentElement, Styled, Window,
    actions,
    component::{
        WindowExt,
        button::{Button, ButtonVariants},
        dialog::{DialogAction, DialogClose, DialogFooter},
    },
};
use std::time::Duration;
use uuid::Uuid;
actions!(management, [OpenManagement]);
pub fn install_actions(cx: &mut App) {
    cx.bind_keys([gpui_kit::KeyBinding::new(
        if cfg!(target_os = "macos") {
            "cmd-shift-b"
        } else {
            "ctrl-shift-b"
        },
        OpenManagement,
        None,
    )]);
    cx.on_action(|_: &OpenManagement, cx| {
        let _ = open(cx);
    });
}
pub fn open(cx: &mut App) -> gpui_kit::Result<()> {
    let (window, _) = gpui_kit::open_window(
        gpui_kit::WindowOptions {
            // Physical native window bounds; all content uses rem layout.
            window_bounds: Some(gpui_kit::WindowBounds::Windowed(
                gpui_kit::Bounds::centered(
                    None,
                    gpui_kit::size(gpui_kit::px(1000.), gpui_kit::px(760.)),
                    cx,
                ),
            )),
            window_min_size: Some(gpui_kit::size(gpui_kit::px(640.), gpui_kit::px(480.))),
            titlebar: Some(gpui_kit::TitlebarOptions {
                title: Some("Anynote · 备份与管理".into()),
                ..Default::default()
            }),
            ..Default::default()
        },
        cx,
        |window, cx| cx.new(|cx| ManagementView::new(window, cx)),
    )?;
    window.update(cx, |_, window, cx| {
        window.activate_window();
        cx.activate(true);
    })?;
    Ok(())
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Page {
    Tasks,
    Diagnostics,
    Local,
    Cloud,
    Restore,
}
pub struct ManagementView {
    client: Option<BackendClient>,
    focus: FocusHandle,
    triggers: std::collections::HashMap<String, FocusHandle>,
    page: Page,
    jobs: Vec<JobDetails>,
    tasks: Vec<TaskRecord>,
    overview: Report,
    selected: Option<Uuid>,
    diagnostics: Option<DiagnosticSnapshot>,
    status: String,
    submitting: bool,
    polling: bool,
    task_page: usize,
    report_page: usize,
    action_page: usize,
    _poll: gpui_kit::Task<()>,
}
impl ManagementView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let client = cx
            .try_global::<BackendSession>()
            .map(|s| s.client().clone());
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        let poll = cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(600))
                    .await;
                if this
                    .update_in(cx, |this, window, cx| this.refresh(window, cx))
                    .is_err()
                {
                    break;
                }
            }
        });
        let mut view = Self {
            client,
            focus,
            triggers: Default::default(),
            page: Page::Tasks,
            jobs: vec![],
            tasks: vec![],
            overview: Report::default(),
            selected: None,
            diagnostics: None,
            status: "正在读取任务历史…".into(),
            submitting: false,
            polling: false,
            task_page: 0,
            report_page: 0,
            action_page: 0,
            _poll: poll,
        };
        view.start(Operation::Overview, false, window, cx);
        view
    }
    fn trigger(&mut self, id: &str, cx: &mut Context<Self>) -> FocusHandle {
        self.triggers
            .entry(id.to_owned())
            .or_insert_with(|| cx.focus_handle().tab_stop(true))
            .clone()
    }
    fn focus_trigger(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.trigger(id, cx).focus(window, cx);
    }
    fn refresh(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.polling {
            return;
        }
        if let Some(session) = cx.try_global::<BackendSession>() {
            self.client = Some(session.client().clone());
        }
        let Some(client) = self.client.clone() else {
            self.status = "后端尚未连接。连接后点击刷新。".into();
            return;
        };
        self.polling = true;
        let diagnostics = self.page == Page::Diagnostics;
        cx.spawn_in(window, async move |this, cx| {
            let jobs = request(&client, Command::Management(ManagementCommand::Jobs)).await;
            let tasks = request(&client, Command::ListTasks).await;
            let diag = if diagnostics {
                Some(request(&client, Command::GetDiagnostics).await)
            } else {
                None
            };
            let _ = this.update(cx, |this, cx| {
                this.polling = false;
                match jobs {
                    Ok(Reply::Management(ManagementReply::Jobs(jobs))) => {
                        if let Some(job) = jobs.iter().rev().find(|j| {
                            matches!(j.operation(), Some(Operation::Overview))
                                && j.task().status() == TaskStatus::Completed
                        }) {
                            this.overview = job.report().clone();
                        }
                        let refresh_overview = jobs.iter().any(|job| {
                            !job.task().status().is_active()
                                && this
                                    .jobs
                                    .iter()
                                    .find(|old| old.task().id() == job.task().id())
                                    .is_none_or(|old| old.task().status().is_active())
                                && (job.title() == "保存云连接"
                                    || matches!(
                                        job.operation(),
                                        Some(
                                            Operation::AddLocal { .. }
                                                | Operation::ConnectLocal { .. }
                                                | Operation::AddCloud { .. }
                                                | Operation::SetPaused { .. }
                                                | Operation::UpdateLocal { .. }
                                                | Operation::LocalRestore { .. }
                                                | Operation::CloudRestore { .. }
                                                | Operation::ArchiveRestore { .. }
                                        )
                                    ))
                        });
                        if let Some(job) = jobs.iter().find(|job| {
                            Some(job.task().id()) == this.selected
                                && !job.task().status().is_active()
                        }) && this
                            .jobs
                            .iter()
                            .find(|old| old.task().id() == job.task().id())
                            .is_none_or(|old| old.task().status().is_active())
                        {
                            this.status =
                                format!("{}：{}", job.title(), status_name(job.task().status()));
                        }
                        this.jobs = jobs;
                        if refresh_overview && let Some(client) = this.client.clone() {
                            cx.spawn(async move |_, _| {
                                let _ = request(
                                    &client,
                                    Command::Management(ManagementCommand::Start {
                                        operation: Operation::Overview,
                                        confirmed: false,
                                    }),
                                )
                                .await;
                            })
                            .detach();
                        }
                    }
                    Err(e) => this.status = message(&e).into(),
                    _ => (),
                }
                if let Ok(Reply::Tasks(tasks)) = tasks {
                    this.tasks = tasks;
                }
                if let Some(Ok(Reply::Diagnostics(diag))) = diag {
                    this.diagnostics = Some(diag);
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn start(
        &mut self,
        operation: Operation,
        confirmed: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.submitting {
            return;
        }
        self.send(
            Command::Management(ManagementCommand::Start {
                operation,
                confirmed,
            }),
            window,
            cx,
        );
    }
    fn send(&mut self, command: Command, window: &mut Window, cx: &mut Context<Self>) {
        if self.submitting {
            return;
        }
        let Some(client) = self.client.clone() else {
            self.status = "后端尚未连接，请稍后刷新。".into();
            cx.notify();
            return;
        };
        self.submitting = true;
        self.status = "正在提交…".into();
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = request(&client, command).await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.submitting = false;
                match result {
                    Ok(Reply::Management(ManagementReply::Started(task))) => {
                        this.selected = Some(task.id());
                        this.report_page = 0;
                        this.action_page = 0;
                        this.status = "任务已启动，可在任务页查看进度或取消。".into();
                    }
                    Ok(Reply::Task(task)) if task.status().is_active() => {
                        this.status = "已请求取消，等待服务返回最终结果。".into()
                    }
                    Ok(_) => this.status = "操作已完成".into(),
                    Err(e) => this.status = message(&e).into(),
                }
                this.refresh(window, cx);
                cx.notify();
            });
        })
        .detach();
    }
    fn activate(&mut self, mut operation: Operation, window: &mut Window, cx: &mut Context<Self>) {
        if let Operation::CloudRestore { destination, .. }
        | Operation::LocalRestore { destination, .. } = &mut operation
            && destination.as_os_str().is_empty()
        {
            self.pick_restore(operation, window, cx);
            return;
        }
        if let Some(description) = operation.confirmation() {
            let title = operation.title();
            let owner = cx.weak_entity();
            window.open_dialog(cx, move |dialog, _, _| {
                let owner = owner.clone();
                let operation = operation.clone();
                dialog
                    .title(title)
                    .child(description.clone())
                    .footer(
                        DialogFooter::new()
                            .child(DialogClose::new().trigger(|button| button.label("取消")))
                            .child(
                                DialogAction::new().child(
                                    Button::new("management-confirm").primary().label(title),
                                ),
                            ),
                    )
                    .on_ok(move |_, window, cx| {
                        let _ = owner.update(cx, |this, cx| {
                            this.start(operation.clone(), true, window, cx)
                        });
                        true
                    })
            });
        } else {
            self.start(operation, false, window, cx);
        }
    }
    fn pick_restore(&mut self, operation: Operation, window: &mut Window, cx: &mut Context<Self>) {
        let prompt = cx.prompt_for_paths(gpui_kit::PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("选择恢复目的地".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let selected = prompt.await;
            let _ = this.update_in(cx, |this, window, cx| {
                match selected {
                    Ok(Ok(Some(paths))) if !paths.is_empty() => {
                        let mut operation = operation;
                        match &mut operation {
                            Operation::LocalRestore { destination, .. }
                            | Operation::ArchiveRestore { destination, .. }
                            | Operation::CloudRestore { destination, .. } => {
                                *destination = paths[0].clone()
                            }
                            _ => return,
                        }
                        this.activate(operation, window, cx);
                    }
                    Ok(Ok(None)) => this.status = "已取消选择恢复目录".into(),
                    _ => this.status = "无法选择恢复目录，请检查目录权限后重试。".into(),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn reconnect(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(session) = cx.try_global::<BackendSession>()
            && session.client().is_connected()
        {
            self.client = Some(session.client().clone());
            self.start(Operation::Overview, false, window, cx);
            return;
        }
        let Some(client) = self.client.clone() else {
            return;
        };
        if !BackendSession::begin_reconnect(cx) {
            return;
        }
        let reconnect = client.reconnect();
        cx.spawn_in(window, async move |this, cx| {
            let result = reconnect.recv().await;
            let _ = this.update_in(cx, |this, window, cx| {
                match result {
                    Ok(Ok(client)) => {
                        BackendSession::end_reconnect(Some(client.clone()), cx);
                        this.client = Some(client);
                        this.start(Operation::Overview, false, window, cx);
                    }
                    _ => {
                        BackendSession::end_reconnect(None, cx);
                        this.status = "后端重连失败，请关闭并重新启动应用。".into();
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }
}
async fn request(client: &BackendClient, command: Command) -> ServiceResult<Reply> {
    match client
        .submit(command, Duration::from_secs(15))?
        .receive()
        .await?
    {
        Response::Reply(reply) => Ok(reply),
        _ => Err(ServiceError::new(ErrorCode::InvalidRequest)),
    }
}
fn message(error: &ServiceError) -> &'static str {
    match error.code() {
        ErrorCode::Busy => "另一项管理任务正在执行。可在任务页取消或等待完成后重试。",
        ErrorCode::Disconnected | ErrorCode::StaleSession => "后端已断开。重新连接后核对任务历史。",
        ErrorCode::InvalidRequest => "输入无效或尚未确认，请检查表单。",
        ErrorCode::Conflict => "任务状态已变化，请刷新后重试。",
        _ => "操作未完成。请检查权限、连接和任务状态后重试。",
    }
}
fn status_name(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Running => "执行中",
        TaskStatus::Committing => "正在提交",
        TaskStatus::Completed => "已完成",
        TaskStatus::Cancelled => "已取消",
        TaskStatus::Failed => "失败",
        TaskStatus::Interrupted => "已中断，需核对",
    }
}
