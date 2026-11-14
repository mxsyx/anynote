use super::*;

impl Workspace {
    pub(super) fn close_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.snapshot.is_none() {
            return;
        }
        self.save_then(window, cx, |this, window, cx| {
            if let Some(id) = this.navigation.close_current() {
                this.load_note(id, false, None, window, cx);
            } else {
                this.remember_position(window, cx);
                this.snapshot = None;
                cx.notify();
            }
        });
    }
    pub(super) fn save_then(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        action: impl FnOnce(&mut Self, &mut Window, &mut Context<Self>) + 'static,
    ) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.status = "正在保存草稿…".into();
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            loop {
                let Ok(state) = cx.update(|_, cx| crate::document_editor::flush_for_navigation(cx))
                else {
                    return;
                };
                match state {
                    crate::document_editor::FlushState::Ready => break,
                    crate::document_editor::FlushState::Failed => {
                        let _ = this.update(cx, |this, cx| {
                            this.busy = false;
                            this.status = "草稿尚未保存，请在编辑窗口处理错误后重试".into();
                            cx.notify();
                        });
                        return;
                    }
                    crate::document_editor::FlushState::Waiting => {
                        cx.background_executor()
                            .timer(Duration::from_millis(50))
                            .await
                    }
                }
            }
            let _ = this.update_in(cx, |this, window, cx| {
                this.busy = false;
                this.status.clear();
                action(this, window, cx);
            });
        })
        .detach();
    }
    pub(super) fn switch_book(&mut self, book: Uuid, window: &mut Window, cx: &mut Context<Self>) {
        if self.book == Some(book) || !self.books.iter().any(|b| b.id == book && !b.unavailable) {
            return;
        }
        self.save_then(window, cx, move |this, window, cx| {
            this.remember_position(window, cx);
            this.cancel_search(window, cx);
            this.reset_book(Some(book), cx);
            this.preferences.active_book = Some(book);
            this.persist_preferences(window, cx);
            this.refresh(window, cx);
        });
    }
    pub(super) fn reset_book(&mut self, book: Option<Uuid>, cx: &mut Context<Self>) {
        self.generation += 1;
        self.book = book;
        self.snapshot = None;
        self.pending_anchor = None;
        self.pending_position = None;
        self.revision = None;
        self.history.clear();
        self.history_next = None;
        self.backlinks.clear();
        self.nodes.clear();
        self.expanded.clear();
        self.tag = None;
        self.show_search = false;
        self.collection = Collection::Tree;
        self.tree.update(cx, |tree, cx| tree.set_items(vec![], cx));
    }
    pub(super) fn open_note(
        &mut self,
        id: DocumentId,
        record: bool,
        anchor: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.save_then(window, cx, move |this, window, cx| {
            this.load_note(id, record, anchor, window, cx)
        });
    }
    pub(super) fn load_note(
        &mut self,
        id: DocumentId,
        record: bool,
        anchor: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(client) = self.client(cx) else {
            return;
        };
        self.remember_position(window, cx);
        self.generation += 1;
        let generation = self.generation;
        self.busy = true;
        self.status = "正在打开笔记…".into();
        self.history.clear();
        self.backlinks.clear();
        self.revision = None;
        cx.spawn_in(window, async move |this, cx| {
            let result = request(&client, Command::OpenDocument { id: id.clone() }).await;
            let _ = this.update_in(cx, |this, window, cx| {
                if this.generation != generation {
                    return;
                }
                this.busy = false;
                match result {
                    Ok(Reply::Document(snapshot)) => {
                        this.navigation.visit(
                            id.clone(),
                            snapshot.content().title().to_owned(),
                            record,
                        );
                        this.preferences.recent.retain(|key| key != &id);
                        this.preferences.recent.insert(0, id.clone());
                        this.preferences.recent.truncate(100);
                        this.set_reading_text(snapshot.content().body(), cx);
                        this.pending_position = this
                            .preferences
                            .positions
                            .iter()
                            .find(|p| p.id.as_ref() == Some(&id))
                            .cloned();
                        this.restore_reading_target(cx);
                        this.snapshot = Some(snapshot);
                        this.status.clear();
                        this.preferences.active_book = Some(id.notebook());
                        this.persist_preferences(window, cx);
                        if this.book != Some(id.notebook()) {
                            this.book = Some(id.notebook());
                            this.collection = Collection::Tree;
                        }
                        this.refresh(window, cx);
                        if let Some(anchor) = anchor {
                            this.follow_anchor(&anchor, window, cx);
                        }
                    }
                    Err(error) => this.status = format!("无法打开笔记：{}", error_text(&error)),
                    _ => this.status = "笔记响应无效".into(),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub(super) fn edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(snapshot) = self.snapshot.clone() else {
            return;
        };
        if self.busy || self.revision.is_some() {
            return;
        }
        if let Err(error) = crate::document_editor::open_document(snapshot, cx) {
            self.status = format!("无法打开编辑窗口：{error}");
        }
        self.remember_position(window, cx);
    }
    pub(super) fn mutate(
        &mut self,
        command: WorkspaceCommand,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.save_then(window, cx, move |this, window, cx| {
            this.execute(command, window, cx)
        });
    }
    fn execute(&mut self, command: WorkspaceCommand, window: &mut Window, cx: &mut Context<Self>) {
        let Some(client) = self.client(cx) else {
            return;
        };
        self.operation =
            matches!(command, WorkspaceCommand::Transfer { .. }).then(|| command.clone());
        self.busy = true;
        self.status = "正在处理…".into();
        let trash_note = match &command {
            WorkspaceCommand::Trash { id, restore: false } => Some(id.clone()),
            _ => None,
        };
        let refresh_note = matches!(
            command,
            WorkspaceCommand::Patch { .. } | WorkspaceCommand::RestoreRevision { .. }
        );
        cx.spawn_in(window, async move |this, cx| {
            let result = call(&client, command).await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.busy = false;
                match result {
                    Ok(reply) => {
                        this.operation = None;
                        this.status.clear();
                        if trash_note
                            .as_ref()
                            .is_some_and(|id| this.snapshot.as_ref().is_some_and(|s| s.id() == id))
                        {
                            this.snapshot = None;
                            this.navigation.close_current();
                        }
                        match reply {
                            WorkspaceReply::Book(book) => {
                                if this.book != Some(book.id) {
                                    this.remember_position(window, cx);
                                    this.cancel_search(window, cx);
                                    this.reset_book(Some(book.id), cx);
                                }
                                this.preferences.active_book = Some(book.id);
                                this.persist_preferences(window, cx);
                            }
                            WorkspaceReply::Node(node)
                                if !node.folder && (refresh_note || this.snapshot.is_none()) =>
                            {
                                this.load_note(node.id, true, None, window, cx);
                                return;
                            }
                            WorkspaceReply::Transferred { id, complete } => {
                                if complete {
                                    this.load_note(id, true, None, window, cx);
                                    return;
                                } else {
                                    this.status =
                                        "已复制；源或目标已改变，移动未完成，请检查两个笔记本"
                                            .into();
                                    cx.notify();
                                    return;
                                }
                            }
                            _ => {}
                        }
                        this.refresh(window, cx);
                    }
                    Err(error) => {
                        this.status = format!("操作未完成，草稿已保留：{}", error_text(&error))
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub(super) fn name_dialog(
        &mut self,
        kind: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.busy {
            return;
        }
        let selected = self.selected(cx);
        let book = self.book;
        if kind != "book" && book.is_none() {
            self.status = "请先新建或打开笔记本".into();
            cx.notify();
            return;
        }
        let title = match kind {
            "book" => "新建笔记本",
            "folder" => "新建目录",
            "rename-book" => "笔记本设置",
            "rename" => "重命名",
            "tags" => "编辑标签",
            _ => "新建笔记",
        };
        let value = match kind {
            "rename" => selected
                .as_ref()
                .map(|n| n.title.clone())
                .unwrap_or_default(),
            "tags" => selected
                .as_ref()
                .map(|n| n.tags.join(", "))
                .unwrap_or_default(),
            "rename-book" => self
                .books
                .iter()
                .find(|b| Some(b.id) == book)
                .map(|b| b.title.clone())
                .unwrap_or_default(),
            _ => String::new(),
        };
        let field = cx.new(|cx| {
            let mut input = InputState::new(window, cx);
            input.set_value(value, window, cx);
            input
        });
        let owner = cx.weak_entity();
        let book_meta = self.books.iter().find(|b| Some(b.id) == book).cloned();
        let icon = cx.new(|cx| {
            let mut input = InputState::new(window, cx).placeholder("笔记本图标");
            input.set_value(
                book_meta
                    .as_ref()
                    .map(|b| b.icon.clone())
                    .unwrap_or_default(),
                window,
                cx,
            );
            input
        });
        let color = cx.new(|cx| {
            let mut input = InputState::new(window, cx).placeholder("笔记本颜色，如 #b18d62");
            input.set_value(
                book_meta
                    .as_ref()
                    .map(|b| b.color.clone())
                    .unwrap_or_default(),
                window,
                cx,
            );
            input
        });
        window.open_dialog(cx, move |dialog, _, _| {
            let field = field.clone();
            let owner = owner.clone();
            let selected = selected.clone();
            let book_meta = book_meta.clone();
            let icon = icon.clone();
            let color = color.clone();
            dialog
                .title(title)
                .child(Input::new(&field).id("workspace-name").aria_label(title))
                .when(kind == "rename-book", |dialog| {
                    dialog
                        .child(Input::new(&icon).aria_label("笔记本图标"))
                        .child(Input::new(&color).aria_label("笔记本颜色"))
                })
                .footer(
                    DialogFooter::new()
                        .child(DialogClose::new().trigger(|b| b.label("取消")))
                        .child(
                            DialogAction::new().child(
                                Button::new("workspace-name-submit").primary().label("保存"),
                            ),
                        ),
                )
                .on_ok(move |_, window, cx| {
                    let value = field.read(cx).value().trim().to_owned();
                    if value.is_empty() && kind != "tags" {
                        return false;
                    }
                    let command = match kind {
                        "book" => WorkspaceCommand::CreateBook { title: value },
                        "rename-book" => {
                            let Some(meta) = &book_meta else {
                                return false;
                            };
                            WorkspaceCommand::RenameBook {
                                book: meta.id,
                                title: value,
                                icon: icon.read(cx).value().trim().to_owned(),
                                color: color.read(cx).value().trim().to_owned(),
                            }
                        }
                        "rename" | "tags" => {
                            let Some(node) = &selected else {
                                return false;
                            };
                            WorkspaceCommand::Patch {
                                id: node.id.clone(),
                                expected: node.revision,
                                title: (kind == "rename").then_some(value.clone()),
                                tags: (kind == "tags").then(|| {
                                    value
                                        .split(',')
                                        .map(str::trim)
                                        .filter(|s| !s.is_empty())
                                        .map(str::to_owned)
                                        .collect()
                                }),
                                favorite: None,
                            }
                        }
                        _ => WorkspaceCommand::CreateNode {
                            book: book.unwrap(),
                            parent: selected.as_ref().and_then(|n| {
                                if n.folder {
                                    Some(n.id.note())
                                } else {
                                    n.parent
                                }
                            }),
                            title: value,
                            folder: kind == "folder",
                        },
                    };
                    let _ = owner.update(cx, |this, cx| this.mutate(command, window, cx));
                    true
                })
        });
    }
    pub(super) fn pick(&mut self, directory: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy || (!directory && self.book.is_none()) {
            return;
        }
        let selection = cx.prompt_for_paths(PathPromptOptions {
            files: !directory,
            directories: directory,
            multiple: false,
            prompt: Some(
                if directory {
                    "打开笔记本目录"
                } else {
                    "导入文件"
                }
                .into(),
            ),
        });
        let book = self.book;
        let parent = self.selected(cx).and_then(|n| {
            if n.folder {
                Some(n.id.note())
            } else {
                n.parent
            }
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = selection.await;
            let _ = this.update_in(cx, |this, window, cx| match result {
                Ok(Ok(Some(paths))) => {
                    if let Some(path) = paths.first() {
                        let command = if directory {
                            WorkspaceCommand::Attach { path: path.clone() }
                        } else {
                            WorkspaceCommand::Import {
                                book: book.unwrap(),
                                parent,
                                path: path.clone(),
                            }
                        };
                        this.mutate(command, window, cx);
                    }
                }
                Ok(Ok(None)) => {}
                _ => {
                    this.status = "无法打开文件选择器，请重试".into();
                    cx.notify();
                }
            });
        })
        .detach();
    }
    pub(super) fn cancel_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(token) = self.search_token.take()
            && let Some(client) = self.client(cx)
        {
            cx.spawn_in(window, async move |_, _| {
                let _ = call(&client, WorkspaceCommand::CancelSearch { token }).await;
            })
            .detach();
        }
        self.search_task = None;
    }
    pub(super) fn search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.search_cursor = None;
        self.search_page(window, cx);
    }
    pub(super) fn search_page(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.cancel_search(window, cx);
        self.hits.clear();
        let Some(client) = self.client(cx) else {
            return;
        };
        let mut query = Search::new(self.query.read(cx).value().to_string());
        if !self.search_all {
            query.book = self.book;
        }
        let tag = self.search_tag.read(cx).value().trim().to_owned();
        query.tag = (!tag.is_empty()).then_some(tag);
        query.kind = self.search_kind.clone();
        query.after = self.search_cursor.clone();
        query.updated_after = self.search_days.map(|days| {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;
            now.saturating_sub(i64::from(days) * 86_400_000).max(0)
        });
        let token = query.token;
        self.search_token = Some(token);
        self.search_task = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(250))
                .await;
            let result = call(&client, WorkspaceCommand::Search(query)).await;
            let _ = this.update(cx, |this, cx| {
                if this.search_token != Some(token) {
                    return;
                }
                this.search_token = None;
                match result {
                    Ok(WorkspaceReply::Search {
                        hits,
                        warnings,
                        truncated,
                        complete,
                        cancelled,
                        ..
                    }) => {
                        this.search_cursor = if truncated && complete {
                            hits.last().map(|h| {
                                SearchCursor::new(
                                    h.entry.updated,
                                    h.entry.id.notebook(),
                                    h.entry.id.note(),
                                )
                            })
                        } else {
                            None
                        };
                        this.hits = hits;
                        this.status = if cancelled {
                            "搜索已取消".into()
                        } else if !complete {
                            format!(
                                "搜索未完整扫描，请缩小范围或重新连接离线笔记本。{}",
                                warnings.join("；")
                            )
                        } else if truncated {
                            "此页显示 200 条结果，可继续下一页".into()
                        } else {
                            warnings.join("；")
                        };
                    }
                    Err(error) => this.status = format!("搜索失败：{}", error_text(&error)),
                    _ => {}
                }
                cx.notify();
            });
        }));
        cx.notify();
    }
    pub(super) fn details(&mut self, history: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.snapshot.as_ref().map(|s| s.id().clone()) else {
            return;
        };
        let Some(client) = self.client(cx) else {
            return;
        };
        let generation = self.generation;
        let command = if history {
            WorkspaceCommand::History {
                id,
                offset: self.history_next.unwrap_or(0),
            }
        } else {
            WorkspaceCommand::Backlinks { id }
        };
        cx.spawn_in(window, async move |this, cx| {
            let result = call(&client, command).await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                match result {
                    Ok(WorkspaceReply::History { entries, next }) => {
                        if this.history_next.is_none() {
                            this.history.clear();
                        }
                        this.history.extend(entries);
                        this.history_next = next;
                    }
                    Ok(WorkspaceReply::Backlinks(entries)) => {
                        this.backlinks = entries;
                        if this.backlinks.is_empty() {
                            this.status = "没有反向链接".into();
                        }
                    }
                    Err(error) => this.status = format!("无法加载：{}", error_text(&error)),
                    _ => {}
                }
                cx.notify();
            });
        })
        .detach();
    }
    pub(super) fn preview_revision(
        &mut self,
        revision: Uuid,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(id) = self.snapshot.as_ref().map(|s| s.id().clone()) else {
            return;
        };
        let Some(client) = self.client(cx) else {
            return;
        };
        self.revision = Some(revision);
        let generation = self.generation;
        cx.spawn_in(window, async move |this, cx| {
            let result = call(&client, WorkspaceCommand::Revision { id, revision }).await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation || this.revision != Some(revision) {
                    return;
                }
                match result {
                    Ok(WorkspaceReply::Revision(body)) => this.set_reading_text(&body, cx),
                    Err(error) => this.status = error_text(&error).into(),
                    _ => {}
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub(super) fn follow_link(&mut self, value: &str, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(anchor) = value.strip_prefix('#') {
            self.follow_anchor(anchor, window, cx);
        } else if let Some((id, anchor)) = navigation::internal_link(value) {
            self.open_note(id, true, anchor, window, cx);
        } else if value.starts_with("https://")
            || value.starts_with("http://")
            || value.starts_with("mailto:")
        {
            cx.open_url(value);
        } else {
            self.status = "无法打开此链接".into();
            cx.notify();
        }
    }
    fn follow_anchor(&mut self, anchor: &str, _: &mut Window, cx: &mut Context<Self>) {
        if self.snapshot.is_some() {
            self.pending_anchor = Some(anchor.replace('-', " "));
            self.status = "未找到此锚点；正文加载后会继续定位".into();
            self.restore_reading_target(cx);
            cx.notify();
        }
    }
    pub(super) fn settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let owner = cx.weak_entity();
        window.open_dialog(cx, move |dialog, _, cx| {
            let Some(view) = owner.upgrade() else {
                return dialog;
            };
            let prefs = view.read(cx).preferences.clone();
            let mut content = div().flex().flex_col().gap_3().child("外观");
            for (value, label) in [("system", "跟随系统"), ("light", "浅色"), ("dark", "深色")]
            {
                let owner = owner.clone();
                content = content.child(
                    Button::new(value)
                        .label(label)
                        .selected(prefs.theme == value)
                        .on_click(move |_, window, cx| {
                            let _ = owner.update(cx, |this, cx| {
                                this.preferences.theme = value.into();
                                this.apply_theme(window, cx);
                                this.persist_preferences(window, cx);
                            });
                        }),
                );
            }
            let owner_zoom = owner.clone();
            let owner_tabs = owner.clone();
            dialog
                .title("设置")
                .child(content)
                .child(
                    Button::new("workspace-zoom")
                        .label(format!(
                            "界面缩放：{}%",
                            (prefs.font_size / 16. * 100.) as i32
                        ))
                        .on_click(move |_, window, cx| {
                            let _ = owner_zoom.update(cx, |this, cx| {
                                this.preferences.font_size = if this.preferences.font_size >= 32. {
                                    12.
                                } else {
                                    this.preferences.font_size + 2.
                                };
                                this.apply_theme(window, cx);
                                this.persist_preferences(window, cx);
                            });
                        }),
                )
                .child(
                    gpui_kit::component::checkbox::Checkbox::new("workspace-tabs")
                        .label("显示标签页")
                        .checked(prefs.show_tabs)
                        .on_change(move |value, window, cx| {
                            let _ = owner_tabs.update(cx, |this, cx| {
                                this.preferences.show_tabs = *value;
                                this.persist_preferences(window, cx);
                                cx.notify();
                            });
                        }),
                )
                .footer(DialogFooter::new().child(DialogClose::new().trigger(|b| b.label("关闭"))))
        });
    }
}
