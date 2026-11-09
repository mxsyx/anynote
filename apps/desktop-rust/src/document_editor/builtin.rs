use super::*;
use crate::backend_session::BackendSession;
use anynote_core::{backend::*, builtin::*};
use anynote_editor::{
    builtin::{BuiltinBlock, Presentation},
    model::BlockId,
};
use gpui_kit::component::{
    collapsible::Collapsible,
    input::{Textarea, TextareaState},
};
use uuid::Uuid;

const READING: &[(&str, &str)] = &[
    ("reading-create", "创建阅读记录…"),
    ("reading-template", "追加阅读模板"),
    ("reading-count", "追加字数统计"),
    ("reading-related", "追加相关阅读索引"),
    ("reading-async", "追加异步相关阅读索引"),
    ("reading-goal", "追加阅读目标"),
    ("reading-session", "记录一次整理"),
    ("reading-public", "追加公开文本…"),
    ("reading-preferences", "笔记本偏好…"),
];

impl DocumentEditor {
    pub(super) fn reading_menu(&self, cx: &mut Context<Self>) -> AnyElement {
        let focus = self.focus.clone();
        if self.builtin_request.is_some() && !self.builtin_running {
            return Button::new("reading-retry")
                .small()
                .label("重试阅读命令")
                .on_click(cx.listener(|this, _, window, cx| this.start_reading(window, cx)))
                .into_any_element();
        }
        Button::new("reading-menu")
            .small()
            .label(if self.builtin_running {
                "正在处理阅读命令"
            } else {
                "阅读"
            })
            .disabled(
                self.state.save.is_none() || self.builtin_running || self.builtin_pending.is_some(),
            )
            .dropdown_menu(move |menu, _, _| {
                READING
                    .iter()
                    .fold(menu.action_context(focus.clone()), |menu, (id, label)| {
                        menu.menu(*label, Box::new(RunCommand::new(*id)))
                    })
            })
            .into_any_element()
    }
    pub(super) fn run_builtin(
        &mut self,
        name: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let kind = match name {
            "reading-card" => Some("garden.reading.card"),
            "callout" => Some("core.callout"),
            "details" => Some("core.details"),
            _ => None,
        };
        if let Some(kind) = kind {
            let source =
                anynote_editor::builtin::insert(kind, &Uuid::new_v4().to_string()).unwrap();
            let result = if self.is_composing() || self.source_composing(window, cx) {
                Err("请先完成当前输入".into())
            } else {
                let range = if let Some(start) = self.slash_start.take() {
                    self.state.projection.source_at(start)
                        ..self.state.projection.source_at(self.state.head)
                } else {
                    let leaf =
                        &self.state.projection.leaves[self.state.projection.at(self.state.head).0];
                    let end = leaf
                        .id
                        .block
                        .and_then(|id| self.state.editor.document().block(id))
                        .map_or(leaf.span.end, |b| b.span().end);
                    end..end
                };
                self.slash = None;
                self.state.source_edit(range, &format!("\n\n{source}\n"))
            };
            self.changed(result, window, cx);
            self.sync_source(window, cx);
            return true;
        }
        if name == "reading-preferences" {
            self.load_preferences(window, cx);
            return true;
        }
        if name == "reading-public" {
            self.public_text_dialog(window, cx);
            return true;
        }
        let command = match name {
            "reading-create" => ReadingCommand::CreateRecord,
            "reading-template" => ReadingCommand::AppendTemplate,
            "reading-count" => ReadingCommand::Count,
            "reading-related" => ReadingCommand::Related,
            "reading-async" => ReadingCommand::AsyncRelated,
            "reading-goal" => ReadingCommand::AppendGoal,
            "reading-session" => ReadingCommand::RecordSession,
            _ => return false,
        };
        self.queue_reading(command, window, cx);
        true
    }
    fn queue_reading(
        &mut self,
        command: ReadingCommand,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.builtin_running || self.builtin_request.is_some() || self.builtin_pending.is_some()
        {
            return;
        }
        if self.state.save.is_none() {
            self.error = Some("请先打开持久笔记".into());
            cx.notify();
            return;
        }
        self.builtin_pending = Some(command);
        self.flush(window, cx);
    }
    pub(super) fn start_reading(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.builtin_running {
            return;
        }
        let Some(client) = cx
            .try_global::<BackendSession>()
            .map(|s| s.client().clone())
        else {
            return;
        };
        if self.builtin_request.is_none() {
            let Some(save) = &self.state.save else {
                return;
            };
            let Some(command) = self.builtin_pending.take() else {
                return;
            };
            self.builtin_request = Some((
                ReadingRequest::new(Uuid::new_v4(), save.base().clone(), command),
                self.state.editor.document().generation(),
                save.epoch(),
            ));
        }
        let (request, generation, epoch) = self.builtin_request.clone().unwrap();
        self.builtin_running = true;
        self.error = None;
        self.builtin_task = Some(cx.spawn_in(window, async move |this, cx| {
            let result = saving::request(&client, Command::RunReading(request.clone())).await;
            let remote = if result
                .as_ref()
                .is_err_and(|e| e.code() == ErrorCode::Conflict)
            {
                saving::request(
                    &client,
                    Command::OpenDocument {
                        id: request.base().id().clone(),
                    },
                )
                .await
                .ok()
            } else {
                None
            };
            let _ = this.update_in(cx, |this, window, cx| {
                this.builtin_running = false;
                if this
                    .state
                    .save
                    .as_ref()
                    .is_none_or(|s| s.epoch() != epoch || s.base().id() != request.base().id())
                {
                    this.builtin_request = None;
                    cx.notify();
                    return;
                }
                match result {
                    Ok(Reply::Reading(snapshot)) => {
                        this.builtin_request = None;
                        if matches!(request.command(), ReadingCommand::CreateRecord) {
                            if open_document(snapshot, cx).is_err() {
                                this.error = Some("阅读记录已创建，窗口打开失败".into());
                            }
                            this.flush(window, cx);
                        } else if this.state.editor.document().generation() != generation
                            || this.is_composing()
                            || this.source_composing(window, cx)
                        {
                            let save = this.state.save.as_mut().unwrap();
                            save.remote = Some(snapshot);
                            save.status = session::SaveStatus::Conflict;
                            this.error =
                                Some("阅读命令已保存；期间的新编辑已保留，请核对两个版本".into());
                        } else {
                            let end = this.source().len();
                            let result = this.state.source_edit(0..end, snapshot.content().body());
                            if result.is_ok() {
                                this.state.save.as_mut().unwrap().accept_builtin(
                                    snapshot,
                                    this.state.editor.document().generation(),
                                );
                            }
                            this.changed(result, window, cx);
                            this.sync_source(window, cx);
                            this.flush(window, cx);
                        }
                    }
                    Err(error)
                        if matches!(error.code(), ErrorCode::Timeout | ErrorCode::Disconnected) =>
                    {
                        this.error = Some("阅读命令尚未确认；重试会核对同一回执".into());
                    }
                    _ => {
                        this.builtin_request = None;
                        if let Some(Reply::Document(snapshot)) = remote {
                            let save = this.state.save.as_mut().unwrap();
                            save.remote = Some(snapshot);
                            save.status = session::SaveStatus::Conflict;
                        }
                        this.error = Some(
                            "阅读命令未完成，当前草稿已保留；请核对笔记或公开文本地址后重试".into(),
                        );
                        this.closing = false;
                    }
                }
                cx.notify();
            });
        }));
        cx.notify();
    }
    fn public_text_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let url = cx.new(|cx| InputState::new(window, cx).placeholder("https://"));
        let owner = cx.weak_entity();
        window.open_dialog(cx, move |dialog, _, _| {
            let url = url.clone();
            let owner = owner.clone();
            dialog
                .title("追加公开文本")
                .child(div().child("公开文本地址"))
                .child(Input::new(&url).aria_label("公开文本地址"))
                .footer(
                    DialogFooter::new()
                        .child(DialogClose::new().trigger(|b| b.label("取消")))
                        .child(
                            DialogAction::new()
                                .child(Button::new("append-public").primary().label("下载并追加")),
                        ),
                )
                .on_ok(move |_, window, cx| {
                    let value = url.read(cx).value().to_string();
                    owner
                        .update(cx, |this, cx| {
                            this.queue_reading(
                                ReadingCommand::PublicText { url: value },
                                window,
                                cx,
                            )
                        })
                        .is_ok()
                })
        });
    }
    pub(super) fn render_builtin(
        &mut self,
        leaf: usize,
        key: u64,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let id = self.state.projection.leaves[leaf].id.block?;
        let Some(block) = BuiltinBlock::read(self.state.editor.document(), id) else {
            let card = self.capture_cards.get(&id)?;
            return Some(
                div()
                    .border_1()
                    .border_color(cx.theme().border)
                    .p_3()
                    .child(render_capture(card))
                    .into_any_element(),
            );
        };
        let mut fields = div().flex().flex_col().gap_2();
        for field in block.fields() {
            fields = fields.child(
                div()
                    .child(
                        div()
                            .text_sm()
                            .text_color(cx.theme().muted_foreground)
                            .child(field.label()),
                    )
                    .child(div().child(field.value().to_owned())),
            );
        }
        let open = self.expanded_blocks.contains(&id);
        let content = if block.presentation() == Presentation::Details {
            Collapsible::new()
                .open(open)
                .child(
                    Button::new(("toggle-details", key))
                        .ghost()
                        .label(if open {
                            "收起折叠块"
                        } else {
                            "展开折叠块"
                        })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if !this.expanded_blocks.remove(&id) {
                                this.expanded_blocks.insert(id);
                            }
                            this.layout.reset(this.state.projection.rows.len());
                            cx.notify();
                        })),
                )
                .content(fields)
                .into_any_element()
        } else {
            fields.into_any_element()
        };
        Some(
            div()
                .flex()
                .flex_col()
                .gap_2()
                .p_3()
                .border_1()
                .border_color(cx.theme().border)
                .child(block.title())
                .child(content)
                .child(
                    Button::new(("edit-fields", key))
                        .small()
                        .ghost()
                        .label("编辑字段…")
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.edit_builtin(id, window, cx)
                        })),
                )
                .into_any_element(),
        )
    }
    fn edit_builtin(&mut self, id: BlockId, window: &mut Window, cx: &mut Context<Self>) {
        if self.is_composing() {
            return;
        }
        let Some(block) = BuiltinBlock::read(self.state.editor.document(), id) else {
            return;
        };
        let generation = self.state.editor.document().generation();
        let fields: Vec<_> = block
            .fields()
            .iter()
            .map(|f| {
                let input = cx.new(|cx| {
                    let mut input = TextareaState::new(window, cx);
                    input.set_value(f.value(), window, cx);
                    input
                });
                (f.key(), f.label(), input)
            })
            .collect();
        let owner = cx.weak_entity();
        let feedback = Rc::new(RefCell::new(None::<String>));
        window.open_dialog(cx, move |dialog, _, _| {
            let fields = fields.clone();
            let owner = owner.clone();
            let feedback = feedback.clone();
            let mut dialog = dialog.title(format!("编辑{}", block.title()));
            for (_, label, input) in &fields {
                dialog = dialog
                    .child(div().child(*label))
                    .child(Textarea::new(input).h(rems(5.)).aria_label(*label));
            }
            if let Some(error) = feedback.borrow().clone() { dialog = dialog.child(div().child(error)); }
            dialog
                .footer(
                    DialogFooter::new()
                        .child(DialogClose::new().trigger(|b| b.label("取消")))
                        .child(
                            DialogAction::new()
                                .child(Button::new("apply-fields").primary().label("应用")),
                        ),
                )
                .on_ok(move |_, window, cx| {
                    let values: Vec<_> = fields
                        .iter()
                        .map(|(key, _, input)| (*key, input.read(cx).value().to_string()))
                        .collect();
                    owner
                        .update(cx, |this, cx| {
                            let result = anynote_editor::builtin::edit_fields(
                                this.state.editor.document(),
                                id,
                                generation,
                                &values,
                                this.state.millis(),
                            )
                            .map_err(state::error)
                            .and_then(|tx| this.state.apply(tx));
                            let ok = result.is_ok();
                            *feedback.borrow_mut() = result.as_ref().err().map(|_| "字段未应用：请检查长度（最多 2000 个 UTF-16 单元）；正文变化后请重新打开字段编辑。".into());
                            cx.refresh_windows();
                            this.changed(result, window, cx);
                            this.sync_source(window, cx);
                            ok
                        })
                        .unwrap_or(true)
                })
        });
    }
    pub(super) fn export_block(
        &mut self,
        id: BlockId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(block) = self.state.editor.document().block(id) else {
            return;
        };
        let bytes = self.source()[block.span()].as_bytes().to_vec();
        let prompt = cx.prompt_for_new_path(std::path::Path::new("."), Some("block.md"));
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Ok(Some(path))) = prompt.await {
                let result = cx
                    .background_spawn(async move { std::fs::write(path, bytes) })
                    .await;
                let _ = this.update_in(cx, |this, _, cx| {
                    this.error = Some(
                        if result.is_ok() {
                            "原文已导出"
                        } else {
                            "无法导出原文，请重试"
                        }
                        .into(),
                    );
                    cx.notify();
                });
            }
        })
        .detach();
    }
    fn load_preferences(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(notebook) = self.state.save.as_ref().map(|s| s.base().id().notebook()) else {
            return;
        };
        let Some(client) = cx
            .try_global::<BackendSession>()
            .map(|s| s.client().clone())
        else {
            return;
        };
        self.preferences_task = Some(cx.spawn_in(window, async move |this, cx| {
            let reply =
                saving::request(&client, Command::GetNotebookPreferences { notebook }).await;
            let _ = this.update_in(cx, |this, window, cx| {
                if this
                    .state
                    .save
                    .as_ref()
                    .is_none_or(|s| s.base().id().notebook() != notebook)
                {
                    return;
                }
                match reply {
                    Ok(Reply::NotebookPreferences {
                        revision,
                        preferences,
                    }) => this.preferences_dialog(notebook, revision, preferences, window, cx),
                    _ => {
                        this.error = Some("无法读取笔记本偏好".into());
                        cx.notify();
                    }
                }
            });
        }));
    }
    fn preferences_dialog(
        &mut self,
        notebook: Uuid,
        revision: i64,
        preferences: NotebookPreferences,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let heading = cx.new(|cx| {
            let mut input = InputState::new(window, cx);
            input.set_value(preferences.heading.clone(), window, cx);
            input
        });
        let goal = cx.new(|cx| {
            let mut input = InputState::new(window, cx);
            input.set_value(preferences.goal.to_string(), window, cx);
            input
        });
        let values = Rc::new(RefCell::new(preferences));
        let owner = cx.weak_entity();
        let feedback = Rc::new(RefCell::new(None::<String>));
        let pending = Rc::new(std::cell::Cell::new(false));
        let active = Rc::new(std::cell::Cell::new(true));
        window.open_dialog(cx, move |dialog, _, _| {
            let heading = heading.clone();
            let goal = goal.clone();
            let values = values.clone();
            let owner = owner.clone();
            let feedback = feedback.clone();
            let pending = pending.clone();
            let active = active.clone();
            let closed = active.clone();
            let mut dialog = dialog
                .title("笔记本偏好")
                .child(div().child("阅读目标标题"))
                .child(Input::new(&heading).aria_label("阅读目标标题"))
                .child(div().child("每周目标篇数（1–100）"))
                .child(Input::new(&goal).aria_label("每周目标篇数"));
            for (key, label, checked) in [
                ("enabled", "追加阅读目标", values.borrow().enabled),
                ("whiteboard", "启用白板", values.borrow().whiteboard),
                ("video", "启用视频", values.borrow().video),
                ("html", "启用 HTML 导入", values.borrow().html),
                (
                    "remote",
                    "允许加载远程嵌入（会连接内容提供方）",
                    values.borrow().remote_embed,
                ),
            ] {
                let values = values.clone();
                dialog = dialog.child(Checkbox::new(key).label(label).checked(checked).on_click(
                    move |next, _, cx| {
                        let mut p = values.borrow_mut();
                        match key {
                            "enabled" => p.enabled = *next,
                            "whiteboard" => p.whiteboard = *next,
                            "video" => p.video = *next,
                            "html" => p.html = *next,
                            _ => p.remote_embed = *next,
                        }
                        cx.refresh_windows();
                    },
                ));
            }
            if let Some(error) = feedback.borrow().clone() { dialog = dialog.child(div().child(error)); }
            dialog
                .on_close(move |_, _, _| closed.set(false))
                .footer(
                    DialogFooter::new()
                        .child(DialogClose::new().trigger(|b| b.label("取消")))
                        .child(
                            DialogAction::new()
                                .child(Button::new("save-preferences").primary().disabled(pending.get()).label(if pending.get() { "正在保存" } else { "保存" })),
                        ),
                )
                .on_ok(move |_, window, cx| {
                    if pending.get() { return false; }
                    let feedback = feedback.clone();
                    let pending = pending.clone();
                    let active = active.clone();
                    let mut p = values.borrow().clone();
                    p.heading = heading.read(cx).value().to_string();
                    p.goal = goal.read(cx).value().parse().unwrap_or(0);
                    owner
                        .update(cx, |this, cx| {
                            if !p.is_valid() {
                                *feedback.borrow_mut() = Some("目标应为 1–100，标题不能超过 80 个 UTF-16 单元".into());
                                cx.refresh_windows();
                                return false;
                            }
                            let Some(client) = cx
                                .try_global::<BackendSession>()
                                .map(|s| s.client().clone())
                            else {
                                return false;
                            };
                            pending.set(true);
                            *feedback.borrow_mut() = None;
                            cx.refresh_windows();
                            this.preferences_task =
                                Some(cx.spawn_in(window, async move |this, cx| {
                                    let result = saving::request(
                                        &client,
                                        Command::SetNotebookPreferences {
                                            notebook,
                                            expected: revision,
                                            preferences: p,
                                        },
                                    )
                                    .await;
                                    let _ = this.update_in(cx, |this, window, cx| {
                                        pending.set(false);
                                        if result.is_ok() {
                                            this.error = Some("笔记本偏好已保存".into());
                                            if active.get() { window.close_dialog(cx); }
                                        } else {
                                            *feedback.borrow_mut() = Some("偏好未保存，输入已保留；若设置已在别处修改，请重新打开偏好并核对。".into());
                                        }
                                        cx.refresh_windows();
                                    });
                                }));
                            false
                        })
                        .unwrap_or(true)
                })
        });
    }
}

fn render_capture(node: &anynote_editor::capture_card::CardNode) -> AnyElement {
    render_capture_at(node, 16.)
}
fn render_capture_at(
    node: &anynote_editor::capture_card::CardNode,
    inherited_font: f32,
) -> AnyElement {
    use anynote_editor::capture_card::{CardLength as L, CardStyle as S};
    let absolute = |v: L, font: f32| match v {
        L::Pixels(n) => n,
        L::Rem(n) => n * 16.,
        L::Em(n) => n * font,
        L::Fraction(n) => n * font,
        L::Auto => 0.,
    };
    let font = node
        .styles()
        .iter()
        .rev()
        .find_map(|s| match s {
            S::Lengths("font-size", v) => Some(absolute(v[0], inherited_font)),
            _ => None,
        })
        .unwrap_or(inherited_font);
    let length = |v: L| -> Length {
        match v {
            L::Auto => Length::Auto,
            L::Fraction(n) => relative(n).into(),
            _ => px(absolute(v, font)).into(),
        }
    };
    let definite = |v: L| -> DefiniteLength {
        match v {
            L::Fraction(n) => relative(n),
            _ => px(absolute(v, font)).into(),
        }
    };
    let mut content = div()
        .flex()
        .min_w_0()
        .gap_1()
        .when(!node.is_row(), |d| d.flex_col())
        .when(node.is_row(), |d| d.flex_wrap())
        .when(node.is_centered(), |d| d.items_center().text_center())
        .when(
            matches!(
                node.tag(),
                "strong" | "b" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
            ),
            |d| d.font_weight(FontWeight::BOLD),
        )
        .when(matches!(node.tag(), "em" | "i"), |d| d.italic())
        .when(node.tag() == "li", |d| d.pl_3())
        .when(node.tag() == "br", |d| d.h_2());
    for style in node.styles() {
        content = match style {
            S::Color("color", c) => content.text_color(rgba(*c)),
            S::Color("background", c) => content.bg(rgba(*c)),
            S::Color("border-color", c) => content.border_color(rgba(*c)),
            S::Border(n, c) => content.border(px(*n)).border_color(rgba(*c)),
            S::Weight(n) => content.font_weight(FontWeight(*n)),
            S::LineHeight(n) => content.line_height(relative(*n)),
            S::Lengths(property, v) => {
                let edges = [
                    v[0],
                    *v.get(1).unwrap_or(&v[0]),
                    *v.get(2).unwrap_or(&v[0]),
                    *v.get(3).or(v.get(1)).unwrap_or(&v[0]),
                ];
                match *property {
                    "font-size" => content.text_size(px(font)),
                    "width" => content.w(length(v[0])),
                    "min-width" => content.min_w(length(v[0])),
                    "max-width" => content.max_w(length(v[0])),
                    "padding" => content
                        .pt(definite(edges[0]))
                        .pr(definite(edges[1]))
                        .pb(definite(edges[2]))
                        .pl(definite(edges[3])),
                    "margin" => content
                        .mt(length(edges[0]))
                        .mr(length(edges[1]))
                        .mb(length(edges[2]))
                        .ml(length(edges[3])),
                    "gap" => content
                        .gap_y(definite(v[0]))
                        .gap_x(definite(*v.get(1).unwrap_or(&v[0]))),
                    "border-radius" => content
                        .rounded_tl(px(absolute(edges[0], font)))
                        .rounded_tr(px(absolute(edges[1], font)))
                        .rounded_br(px(absolute(edges[2], font)))
                        .rounded_bl(px(absolute(edges[3], font))),
                    _ => content,
                }
            }
            S::Keyword(key, value) => match (*key, value.as_str()) {
                ("flex-wrap", "wrap") => content.flex_wrap(),
                ("flex-wrap", "nowrap") => content.flex_nowrap(),
                ("align-items", "center") => content.items_center(),
                ("align-items", "flex-start") => content.items_start(),
                ("align-items", "flex-end") => content.items_end(),
                ("align-items", "stretch") => content.items_stretch(),
                ("justify-content", "center") => content.justify_center(),
                ("justify-content", "flex-start") => content.justify_start(),
                ("justify-content", "flex-end") => content.justify_end(),
                ("justify-content", "space-between") => content.justify_between(),
                ("text-align", "left") => content.text_left(),
                ("text-align", "center") => content.text_center(),
                ("text-align", "right") => content.text_right(),
                _ => content,
            },
            _ => content,
        };
    }
    if !node.text().is_empty() {
        content = content.child(node.text().to_owned());
    }
    for child in node.children() {
        content = content.child(render_capture_at(child, font));
    }
    content.into_any_element()
}

#[cfg(all(test, feature = "ui-tests"))]
mod tests {
    use super::*;
    use core::prelude::v1::test;
    use gpui_kit::test::{TestEventExt, TestQueryExt, TestWindowExt};
    fn open(cx: &mut TestAppContext, source: String) -> (AnyWindowHandle, Entity<DocumentEditor>) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            install_actions(cx);
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(1000.), px(900.)),
                    ))),
                    ..Default::default()
                },
                cx,
                |window, cx| cx.new(|cx| DocumentEditor::new(source, window, cx)),
            )
            .unwrap()
        })
    }
    #[gpui_kit::test]
    fn builtin_fields_use_native_dialog_and_shared_undo(cx: &mut TestAppContext) {
        let original = anynote_editor::builtin::insert("garden.reading.card", "test-card").unwrap();
        let (window, editor) = open(cx, original.clone());
        cx.update_window(window, |_, window, cx| {
            window.render_frame(cx);
            let view = editor.read(cx);
            let ix = view
                .state
                .projection
                .leaves
                .iter()
                .position(|l| l.kind == NodeKind::Atom)
                .unwrap();
            let key = view.keys[ix];
            window.click(("edit-fields", key), cx);
            let point = window.find_by_label("摘录").bounds().center();
            window.pointer_down(point, MouseButton::Left, cx);
            window.pointer_up(point, MouseButton::Left, cx);
            window.press(
                if cfg!(target_os = "macos") {
                    "cmd-a"
                } else {
                    "ctrl-a"
                },
                cx,
            );
            window.input("Native 📚 field", cx);
            window.click("apply-fields", cx);
            assert!(editor.read(cx).source().contains("Native 📚 field"));
            assert_eq!(editor.read(cx).undo_steps(), 1);
            editor.update(cx, |this, cx| {
                this.run(&RunCommand::new("undo"), window, cx)
            });
            assert_eq!(editor.read(cx).source(), original);
        })
        .unwrap();
    }
    #[gpui_kit::test]
    fn details_toggle_and_unknown_copy_do_not_mutate_source(cx: &mut TestAppContext) {
        let original = anynote_editor::builtin::insert("core.details", "test-details").unwrap();
        let (window, editor) = open(cx, original.clone());
        cx.update_window(window, |_, window, cx| {
            window.render_frame(cx);
            let view = editor.read(cx);
            let ix = view
                .state
                .projection
                .leaves
                .iter()
                .position(|l| l.kind == NodeKind::Atom)
                .unwrap();
            let key = view.keys[ix];
            window.click(("toggle-details", key), cx);
            assert_eq!(editor.read(cx).expanded_blocks.len(), 1);
            window.click(("copy-source-block", key), cx);
            assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), original);
            assert_eq!(editor.read(cx).source(), original);
            assert_eq!(editor.read(cx).undo_steps(), 0);
            window.click(("toggle-details", key), cx);
            assert!(editor.read(cx).expanded_blocks.is_empty());
        })
        .unwrap();
    }
}
