use super::*;
use gpui_kit::{
    Render, SharedString,
    component::{
        ActiveTheme, Disableable,
        checkbox::Checkbox,
        input::{Input, InputState},
        scroll::ScrollableElement,
    },
    div,
};
#[derive(Clone, Copy)]
pub(super) enum FormKind {
    EditLocal,
    Local,
    ConnectLocal,
    Connection,
    Cloud,
    Integrity,
    Cleanup,
    Retention,
}
impl FormKind {
    pub(super) fn trigger(self) -> &'static str {
        match self {
            Self::EditLocal => "management-edit-local",
            Self::Local => "management-add-local",
            Self::ConnectLocal => "management-connect-local",
            Self::Connection => "management-add-connection",
            Self::Cloud => "management-add-cloud",
            Self::Integrity => "management-integrity",
            Self::Cleanup => "management-cleanup",
            Self::Retention => "management-retention",
        }
    }
    fn title(self) -> &'static str {
        match self {
            Self::EditLocal => "修改本地备份范围",
            Self::Local => "添加本地备份目标",
            Self::ConnectLocal => "连接已有备份磁盘",
            Self::Connection => "添加云连接",
            Self::Cloud => "添加云备份目标",
            Self::Integrity => "检查笔记本完整性",
            Self::Cleanup => "预览本地清理",
            Self::Retention => "云端保留策略",
        }
    }
    fn fields(self) -> Vec<(&'static str, &'static str)> {
        match self {
            Self::EditLocal => vec![("间隔（分钟）", "60")],
            Self::Local => vec![("目标名称", "本地备份"), ("间隔（分钟）", "60")],
            Self::ConnectLocal => vec![("目标名称", "恢复磁盘")],
            Self::Connection => vec![
                ("连接名称", ""),
                ("服务地址（HTTPS）", ""),
                ("访问令牌", ""),
            ],
            Self::Cloud => vec![("间隔（分钟）", "60")],
            Self::Cleanup => vec![("至少保留快照数", "10"), ("保留最近天数", "30")],
            Self::Retention => vec![
                ("至少保留版本数", "30"),
                ("每日版本保留天数", "0"),
                ("每周版本保留周数", "0"),
                ("每月版本保留月数", "0"),
            ],
            Self::Integrity => vec![],
        }
    }
}
struct Form {
    kind: FormKind,
    fields: Vec<(&'static str, Entity<InputState>)>,
    choices: Vec<Choice>,
    selected: std::collections::BTreeSet<String>,
    directory: Option<std::path::PathBuf>,
    picking: bool,
    error: String,
    choice_page: usize,
}
impl ManagementView {
    pub(super) fn form(&mut self, kind: FormKind, window: &mut Window, cx: &mut Context<Self>) {
        self.focus_trigger(kind.trigger(), window, cx);
        let choices = self
            .overview
            .choices()
            .iter()
            .filter(|c| match kind {
                FormKind::EditLocal => {
                    matches!(c.kind(), ChoiceKind::Notebook | ChoiceKind::LocalTarget)
                }
                FormKind::Local | FormKind::Integrity | FormKind::Cleanup => {
                    *c.kind() == ChoiceKind::Notebook
                }
                FormKind::Cloud => {
                    matches!(c.kind(), ChoiceKind::Notebook | ChoiceKind::Connection)
                }
                FormKind::Retention => *c.kind() == ChoiceKind::CloudTarget,
                _ => false,
            })
            .cloned()
            .collect();
        let form = cx.new(|cx| Form {
            kind,
            fields: kind
                .fields()
                .into_iter()
                .enumerate()
                .map(|(ix, (label, value))| {
                    (
                        label,
                        cx.new(|cx| {
                            let mut input = InputState::new(window, cx);
                            input.set_value(value, window, cx);
                            if matches!(kind, FormKind::Connection) && ix == 2 {
                                input.set_masked(true, window, cx);
                            }
                            input
                        }),
                    )
                })
                .collect(),
            choices,
            selected: Default::default(),
            directory: None,
            picking: false,
            error: String::new(),
            choice_page: 0,
        });
        let owner = cx.weak_entity();
        window.open_dialog(cx, move |dialog, _, _| {
            let form = form.clone();
            let submit = form.clone();
            let owner = owner.clone();
            dialog
                .title(kind.title())
                .child(form)
                .footer(
                    DialogFooter::new()
                        .child(DialogClose::new().trigger(|b| b.label("取消")))
                        .child(
                            DialogAction::new().child(
                                Button::new("management-form-submit")
                                    .primary()
                                    .label(match kind {
                                        FormKind::Integrity => "检查",
                                        FormKind::Cleanup => "预览",
                                        _ => "保存",
                                    }),
                            ),
                        ),
                )
                .on_ok(move |_, window, cx| {
                    let result = submit.update(cx, |form, cx| {
                        let result = form.operation(cx);
                        if let Err(error) = &result {
                            form.error = error.clone();
                            cx.notify();
                        }
                        result
                    });
                    if let Ok(operation) = result {
                        let _ =
                            owner.update(cx, |this, cx| this.start(operation, false, window, cx));
                        true
                    } else {
                        false
                    }
                })
        });
    }
    pub(super) fn restore_archive(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let prompt = cx.prompt_for_paths(gpui_kit::PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("选择 Anynote 归档".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let selected = prompt.await;
            let _ = this.update_in(cx, |this, window, cx| {
                match selected {
                    Ok(Ok(Some(paths))) if !paths.is_empty() => this.pick_restore(
                        Operation::ArchiveRestore {
                            archive: paths[0].clone(),
                            destination: Default::default(),
                        },
                        window,
                        cx,
                    ),
                    Ok(Ok(None)) => this.status = "已取消选择归档".into(),
                    _ => this.status = "无法读取归档位置，请检查权限。".into(),
                }
                cx.notify();
            });
        })
        .detach();
    }
    pub(super) fn export_diagnostics(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        let prompt =
            cx.prompt_for_new_path(std::path::Path::new("."), Some("anynote-diagnostics.json"));
        cx.spawn_in(window, async move |this, cx| {
            let result = async {
                let Some(path) = prompt
                    .await
                    .map_err(|_| "文件选择器关闭")?
                    .map_err(|_| "无法选择导出位置")?
                else {
                    return Ok("已取消导出");
                };
                let Reply::Resource { token, length } =
                    request(&client, Command::ExportDiagnostics)
                        .await
                        .map_err(|_| "无法获取诊断数据")?
                else {
                    return Err("诊断响应无效");
                };
                let read = async {
                    if length > 2 * 1024 * 1024 {
                        return Err("诊断数据超出导出预算");
                    }
                    let mut bytes = Vec::with_capacity(length as usize);
                    while (bytes.len() as u64) < length {
                        let offset = bytes.len() as u64;
                        let count = (length - offset).min(MAX_CHUNK_BYTES as u64) as u32;
                        let response = client
                            .submit(
                                Command::ReadResource {
                                    token,
                                    offset,
                                    length: count,
                                },
                                Duration::from_secs(15),
                            )
                            .map_err(|_| "诊断读取失败")?
                            .receive()
                            .await
                            .map_err(|_| "诊断读取失败")?;
                        let Response::Chunk(_, chunk) = response else {
                            return Err("诊断数据响应无效");
                        };
                        if chunk.is_empty() {
                            return Err("诊断数据不完整");
                        }
                        bytes.extend(chunk);
                    }
                    cx.background_spawn(async move {
                        use std::io::Write;
                        let parent = path.parent().ok_or("导出路径无效")?;
                        let tmp = parent.join(format!(".anynote-diagnostics-{}", Uuid::new_v4()));
                        let result = (|| {
                            let mut file = std::fs::OpenOptions::new()
                                .write(true)
                                .create_new(true)
                                .open(&tmp)
                                .map_err(|_| "无法创建导出文件，请检查权限")?;
                            file.write_all(&bytes).map_err(|_| "诊断写入失败")?;
                            file.sync_all().map_err(|_| "诊断写入失败")?;
                            // No-clobber publication keeps an existing report intact on failure.
                            std::fs::hard_link(&tmp, &path)
                                .map_err(|_| "目标已存在或无法写入，请选择新文件名")?;
                            Ok("诊断已导出")
                        })();
                        let _ = std::fs::remove_file(tmp);
                        result
                    })
                    .await
                }
                .await;
                let _ = request(&client, Command::ReleaseResource { token }).await;
                read
            }
            .await;
            let _ = this.update(cx, |this, cx| {
                this.status = result.unwrap_or_else(|e| e).into();
                cx.notify();
            });
        })
        .detach();
    }
}
impl Form {
    fn operation(&self, cx: &App) -> Result<Operation, String> {
        let values = self
            .fields
            .iter()
            .map(|(_, v)| v.read(cx).value().to_string())
            .collect::<Vec<_>>();
        let number = |ix: usize, maximum: u32| {
            values[ix]
                .parse::<u32>()
                .ok()
                .filter(|n| *n <= maximum)
                .ok_or_else(|| format!("{}请输入 0–{maximum} 的整数", self.fields[ix].0))
        };
        let selected = |kind| {
            self.choices
                .iter()
                .find(|c| *c.kind() == kind && self.selected.contains(c.id()))
                .map(|c| c.id().to_owned())
                .ok_or_else(|| "请选择笔记本或连接".to_owned())
        };
        let directory = || {
            self.directory
                .clone()
                .ok_or_else(|| "请选择备份磁盘中的目录".to_owned())
        };
        let interval = |ix| {
            number(ix, 43_200).and_then(|n| {
                if n > 0 {
                    Ok(n)
                } else {
                    Err("备份间隔至少 1 分钟".into())
                }
            })
        };
        Ok(match self.kind {
            FormKind::EditLocal => Operation::UpdateLocal {
                target: selected(ChoiceKind::LocalTarget)?,
                notebooks: self
                    .choices
                    .iter()
                    .filter(|c| *c.kind() == ChoiceKind::Notebook && self.selected.contains(c.id()))
                    .map(|c| c.id().to_owned())
                    .collect(),
                interval_minutes: interval(0)?,
            },
            FormKind::Local => {
                if values[0].trim().is_empty() || self.selected.is_empty() {
                    return Err("请输入目标名称并选择至少一个笔记本".into());
                }
                Operation::AddLocal {
                    directory: directory()?,
                    name: values[0].clone(),
                    notebooks: self.selected.iter().cloned().collect(),
                    interval_minutes: interval(1)?,
                }
            }
            FormKind::ConnectLocal => Operation::ConnectLocal {
                directory: directory()?,
                name: values[0].clone(),
            },
            FormKind::Connection => {
                if values.iter().any(|v| v.trim().is_empty()) || !values[1].starts_with("https://")
                {
                    return Err("请填写名称、HTTPS 服务地址和访问令牌".into());
                }
                Operation::SaveConnection {
                    name: values[0].clone(),
                    endpoint: values[1].clone(),
                    token: values[2].clone(),
                }
            }
            FormKind::Cloud => Operation::AddCloud {
                connection: selected(ChoiceKind::Connection)?,
                notebook: selected(ChoiceKind::Notebook)?,
                interval_minutes: interval(0)?,
            },
            FormKind::Integrity => Operation::Integrity {
                notebook: selected(ChoiceKind::Notebook)?,
            },
            FormKind::Cleanup => {
                let keep = number(0, 1000)?;
                if keep == 0 {
                    return Err("至少保留 1 份快照".into());
                }
                Operation::CleanupPreview {
                    notebook: selected(ChoiceKind::Notebook)?,
                    keep: keep as usize,
                    days: number(1, 3650)?,
                }
            }
            FormKind::Retention => {
                let keep = number(0, 1000)?;
                if keep == 0 {
                    return Err("至少保留 1 个云端版本".into());
                }
                Operation::RetentionSave {
                    target: selected(ChoiceKind::CloudTarget)?,
                    keep: keep as u16,
                    days: number(1, 365)? as u16,
                    weeks: number(2, 104)? as u16,
                    months: number(3, 120)? as u16,
                }
            }
        })
    }
    fn pick(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.picking {
            return;
        }
        self.picking = true;
        cx.notify();
        let prompt = cx.prompt_for_paths(gpui_kit::PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("选择备份目标的上级目录".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = prompt.await;
            let _ = this.update(cx, |this, cx| {
                this.picking = false;
                match result {
                    Ok(Ok(Some(paths))) => this.directory = paths.into_iter().next(),
                    Ok(Ok(None)) => (),
                    _ => this.error = "无法选择目录，请检查权限。".into(),
                }
                cx.notify();
            });
        })
        .detach();
    }
}
impl Render for Form {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut view = div().flex().flex_col().gap_3();
        for (ix, (label, state)) in self.fields.iter().enumerate() {
            view = view.child(
                div().flex().flex_col().gap_1().child(*label).child(
                    Input::new(state)
                        .id(SharedString::from(format!("management-field-{ix}")))
                        .aria_label(*label),
                ),
            );
        }
        if matches!(self.kind, FormKind::Local | FormKind::ConnectLocal) {
            view = view
                .child(
                    Button::new("management-pick-directory")
                        .label("选择目录…")
                        .disabled(self.picking)
                        .on_click(cx.listener(|this, _, window, cx| this.pick(window, cx))),
                )
                .child(
                    self.directory
                        .as_ref()
                        .map(|p| p.display().to_string())
                        .unwrap_or_else(|| "尚未选择目录。选择 AnynoteBackup 的上级目录。".into()),
                );
        }
        if !matches!(self.kind, FormKind::Connection | FormKind::ConnectLocal) {
            view = view.child("选择范围");
            if self.choices.is_empty() {
                view = view.child("暂无可选项。关闭此窗口，刷新管理页或先添加连接。");
            }
            for choice in self.choices.iter().skip(self.choice_page * 8).take(8) {
                let id = choice.id().to_owned();
                let kind = choice.kind().clone();
                view = view.child(
                    Checkbox::new(SharedString::from(format!("management-choice-{id}")))
                        .label(choice.name().to_owned())
                        .checked(self.selected.contains(&id))
                        .on_click(cx.listener(move |this, checked, _, cx| {
                            if *checked {
                                if !(matches!(this.kind, FormKind::Local | FormKind::EditLocal)
                                    && kind == ChoiceKind::Notebook)
                                {
                                    for c in &this.choices {
                                        if c.kind() == &kind {
                                            this.selected.remove(c.id());
                                        }
                                    }
                                }
                                this.selected.insert(id.clone());
                            } else {
                                this.selected.remove(&id);
                            }
                            cx.notify();
                        })),
                );
            }
            if self.choices.len() > 8 {
                view = view.child(
                    div()
                        .flex()
                        .gap_2()
                        .child(
                            Button::new("management-choices-prev")
                                .label("上一页")
                                .disabled(self.choice_page == 0)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.choice_page = this.choice_page.saturating_sub(1);
                                    cx.notify();
                                })),
                        )
                        .child(
                            Button::new("management-choices-next")
                                .label("下一页")
                                .disabled((self.choice_page + 1) * 8 >= self.choices.len())
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.choice_page += 1;
                                    cx.notify();
                                })),
                        ),
                );
            }
        }
        view.child(
            div()
                .text_color(cx.theme().danger)
                .child(self.error.clone()),
        )
        .max_h_96()
        .overflow_y_scrollbar()
    }
}
