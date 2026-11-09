//! The rehearsal UI launches an isolated native worker; filesystem work never
//! runs on GPUI and the production backend never receives a second catalog.
use gpui_kit::{
    Context, IntoElement, ParentElement, Render, SharedString, Styled, Task, Window,
    component::{ActiveTheme, Disableable, button::Button},
    div,
};
use std::path::Path;

pub fn prepare_clone(path: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let mut session = anynote_services::migration::Rehearsal::open(path)?;
    session.prepare(&mut |_| Ok(()))?;
    Ok(format!(
        "已保全并校验 {} 个笔记本。副本保留在所选目录中；正式接管尚未开放。",
        session.notebook_count()
    ))
}

pub struct MigrationView {
    status: SharedString,
    busy: bool,
    task: Option<Task<()>>,
}
impl MigrationView {
    pub fn new() -> Self {
        Self {
            status: "选择已准备的隔离演练目录。目录必须包含演练标记、userData 和登记的外部库副本。"
                .into(),
            busy: false,
            task: None,
        }
    }
    fn choose_clone(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.status = "等待选择演练目录".into();
        cx.notify();
        let selection = cx.prompt_for_paths(gpui_kit::PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("选择演练目录".into()),
        });
        self.task = Some(cx.spawn_in(window, async move |this, cx| {
            let result = match selection.await {
                Ok(Ok(Some(paths))) if paths.len() == 1 => {
                    let path = paths[0].clone();
                    let _ = this.update(cx, |this, cx| {
                        this.status = "正在检查占用、保全文件并校验副本。完成前请保持原目录关闭。".into();
                        cx.notify();
                    });
                    cx.background_executor().spawn(async move {
                        let result = std::env::current_exe().and_then(|exe| std::process::Command::new(exe).arg("--migration-rehearsal").arg(path).output());
                        match result {
                            Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout).trim().to_owned(),
                            Ok(_) => "未完成保全。请确认目录含演练标记、旧程序已关闭、外部库均在副本内且磁盘空间足够。原文件和已有副本均保留，可修复后重试。".into(),
                            Err(_) => "无法启动检查进程，请重试。".into(),
                        }
                    }).await
                }
                Ok(Ok(None)) => "已取消选择，尚未开始保全。".into(),
                _ => "无法选择目录，请重试。".into(),
            };
            let _ = this.update(cx, |this, cx| { this.busy = false; this.status = result.into(); cx.notify(); });
        }));
    }
}
impl Default for MigrationView {
    fn default() -> Self {
        Self::new()
    }
}
impl Render for MigrationView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(div().text_lg().child("数据接管演练"))
            .child(
                div()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child("当前仅支持隔离副本。编辑、媒体和平台验收完成后才开放日常资料接管。"),
            )
            .child(
                Button::new("migration-choose-clone")
                    .label("选择副本并校验…")
                    .disabled(self.busy)
                    .on_click(cx.listener(|this, _, window, cx| this.choose_clone(window, cx))),
            )
            .child(div().text_sm().child(self.status.clone()))
            .child(
                Button::new("migration-production-activate")
                    .label("接管日常资料")
                    .disabled(true),
            )
    }
}
