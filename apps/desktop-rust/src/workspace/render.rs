use super::*;
use gpui_kit::component::menu::{DropdownMenu, PopupMenuItem};

impl Workspace {
    fn toolbar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap_2()
            .p_2()
            .border_b_1()
            .border_color(cx.theme().border)
            .child(
                Button::new("workspace-back")
                    .label("后退")
                    .disabled(self.busy || !self.navigation.has_back())
                    .on_click(cx.listener(|this, _, window, cx| {
                        if let Some(id) = this.navigation.back() {
                            this.open_note(id, false, None, window, cx);
                        }
                    })),
            )
            .child(
                Button::new("workspace-forward")
                    .label("前进")
                    .disabled(self.busy || !self.navigation.has_forward())
                    .on_click(cx.listener(|this, _, window, cx| {
                        if let Some(id) = this.navigation.forward() {
                            this.open_note(id, false, None, window, cx);
                        }
                    })),
            )
            .child(
                Button::new("workspace-books")
                    .label("书橱")
                    .disabled(self.busy)
                    .on_click(
                        cx.listener(|this, _, window, cx| this.switch_book(None, window, cx)),
                    ),
            )
            .child(
                div().flex_1().min_w_0().child(
                    self.books
                        .iter()
                        .find(|b| Some(b.id) == self.book)
                        .map(|b| b.title.clone())
                        .unwrap_or_else(|| "我的书橱".into()),
                ),
            )
            .child(
                Button::new("workspace-search")
                    .label("搜索")
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.show_search = !this.show_search;
                        if this.show_search {
                            this.query.update(cx, |q, cx| q.focus(window, cx));
                            this.search(window, cx);
                        } else {
                            this.cancel_search(window, cx);
                        }
                        cx.notify();
                    })),
            )
            .child(
                Button::new("workspace-refresh")
                    .label("刷新")
                    .disabled(self.busy)
                    .on_click(cx.listener(|this, _, window, cx| this.refresh(window, cx))),
            )
            .child(
                Button::new("workspace-settings")
                    .label("设置…")
                    .on_click(cx.listener(|this, _, window, cx| this.settings(window, cx))),
            )
    }
    fn bookshelf(&self, cx: &mut Context<Self>) -> AnyElement {
        let mut books = self.books.iter().collect::<Vec<_>>();
        books.sort_by_key(|book| {
            self.preferences
                .recent
                .iter()
                .position(|id| id.notebook() == book.id)
                .unwrap_or(usize::MAX)
        });
        div()
            .id("bookshelf")
            .flex()
            .flex_col()
            .size_full()
            .gap_4()
            .p_6()
            .child(
                div()
                    .flex()
                    .gap_2()
                    .child(
                        Button::new("workspace-create-book")
                            .label("新建笔记本…")
                            .disabled(self.busy)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.name_dialog("book", window, cx)
                            })),
                    )
                    .child(
                        Button::new("workspace-attach")
                            .label("打开外部笔记本…")
                            .disabled(self.busy)
                            .on_click(
                                cx.listener(|this, _, window, cx| this.pick(true, window, cx)),
                            ),
                    ),
            )
            .when(self.books.is_empty(), |view| {
                view.child(
                    div()
                        .text_color(cx.theme().muted_foreground)
                        .child("书橱还没有笔记本。新建一个，或打开已有笔记本目录。"),
                )
            })
            .child(
                div()
                    .id("bookshelf-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scrollbar()
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap_6()
                            .children(books.into_iter().map(|book| {
                                let id = book.id;
                                let unavailable = book.unavailable;
                                let binding = Rgba::try_from(book.color.as_str())
                                    .map(Hsla::from)
                                    .unwrap_or(cx.theme().border);
                                div()
                                    .w_48()
                                    .flex()
                                    .flex_col()
                                    .gap_2()
                                    .child(
                                        Button::new(SharedString::from(format!("book-{id}")))
                                            .label(format!(
                                                "{}  {}",
                                                if book.icon.is_empty() {
                                                    "❦"
                                                } else {
                                                    &book.icon
                                                },
                                                book.title
                                            ))
                                            .w_full()
                                            .h_48()
                                            .bg(cx.theme().secondary)
                                            .border_l_4()
                                            .border_b_4()
                                            .border_color(binding)
                                            .shadow_md()
                                            .disabled(self.busy || unavailable)
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.switch_book(Some(id), window, cx)
                                            })),
                                    )
                                    .child(
                                        div()
                                            .text_sm()
                                            .text_color(cx.theme().muted_foreground)
                                            .child(if unavailable {
                                                "离线或无法访问：重连目录后刷新"
                                            } else if book.external {
                                                "外部笔记本"
                                            } else {
                                                "本地笔记本"
                                            }),
                                    )
                                    .when(book.external, |view| {
                                        view.child(
                                            Button::new(SharedString::from(format!("detach-{id}")))
                                                .ghost()
                                                .label("移出书橱")
                                                .disabled(self.busy)
                                                .on_click(cx.listener(
                                                    move |this, _, window, cx| {
                                                        this.mutate(
                                                            WorkspaceCommand::Detach { book: id },
                                                            window,
                                                            cx,
                                                        )
                                                    },
                                                )),
                                        )
                                    })
                            })),
                    ),
            )
            .into_any_element()
    }
    fn sidebar(&self, cx: &mut Context<Self>) -> AnyElement {
        let owner = cx.weak_entity();
        let mut filters = div().flex().flex_wrap().gap_1();
        for (collection, label) in [
            (Collection::Tree, "目录"),
            (Collection::Recent, "最近"),
            (Collection::Favorites, "收藏"),
            (Collection::Tags, "标签"),
            (Collection::Trash, "回收站"),
        ] {
            filters = filters.child(
                Button::new(label)
                    .small()
                    .ghost()
                    .label(label)
                    .selected(self.collection == collection)
                    .disabled(self.busy)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.set_collection(collection, window, cx)
                    })),
            );
        }
        let mut content = div()
            .flex()
            .flex_col()
            .size_full()
            .gap_2()
            .p_2()
            .bg(cx.theme().sidebar)
            .text_color(cx.theme().sidebar_foreground)
            .child(filters)
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_1()
                    .child(
                        Button::new("workspace-new-note")
                            .small()
                            .label("新建笔记…")
                            .disabled(self.busy)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.name_dialog("note", window, cx)
                            })),
                    )
                    .child(
                        Button::new("workspace-new-folder")
                            .small()
                            .label("新建目录…")
                            .disabled(self.busy)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.name_dialog("folder", window, cx)
                            })),
                    )
                    .child(
                        Button::new("workspace-import")
                            .small()
                            .label("导入…")
                            .disabled(self.busy)
                            .on_click(
                                cx.listener(|this, _, window, cx| this.pick(false, window, cx)),
                            ),
                    ),
            );
        if self.collection == Collection::Tags {
            let tags = self
                .nodes
                .iter()
                .flat_map(|n| n.tags.iter())
                .collect::<std::collections::BTreeSet<_>>();
            content = content.child(div().flex().flex_wrap().gap_1().children(
                tags.into_iter().map(|tag| {
                    let tag = tag.clone();
                    Button::new(SharedString::from(format!("tag-{tag}")))
                        .small()
                        .label(tag.clone())
                        .selected(self.tag.as_ref() == Some(&tag))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.tag = Some(tag.clone());
                            this.rebuild_tree(cx);
                            cx.notify();
                        }))
                }),
            ));
        }
        content = content
            .child(
                div().flex_1().min_h_0().child(
                    gpui_kit::base::Tree::new(&self.tree)
                        .item(move |_, entry, row_state, _, cx| {
                            let key = entry.item().id.clone();
                            let owner_open = owner.clone();
                            let owner_drop = owner.clone();
                            let node = owner.upgrade().and_then(|view| {
                                view.read(cx)
                                    .nodes
                                    .iter()
                                    .find(|n| n.id.note().to_string() == key.as_ref())
                                    .cloned()
                            });
                            let Some(node) = node else {
                                return div().into_any_element();
                            };
                            let drag = node.clone();
                            let target = node.clone();
                            let id = node.id.clone();
                            div()
                                .id(SharedString::from(format!("node-{}", id.note())))
                                .test_support()
                                .on_drag(DragNode(drag), |drag, _, _, cx| cx.new(|_| drag.clone()))
                                .on_drop(move |drag: &DragNode, window, cx| {
                                    let _ = owner_drop.update(cx, |this, cx| {
                                        if drag.0.id.notebook() != target.id.notebook() {
                                            return;
                                        }
                                        this.mutate(
                                            WorkspaceCommand::Place {
                                                id: drag.0.id.clone(),
                                                expected: drag.0.revision,
                                                parent: if target.folder {
                                                    Some(target.id.note())
                                                } else {
                                                    target.parent
                                                },
                                                before: if target.folder {
                                                    None
                                                } else {
                                                    Some(target.id.note())
                                                },
                                            },
                                            window,
                                            cx,
                                        );
                                    });
                                })
                                .child(
                                    div()
                                        .id(SharedString::from(format!("open-{}", id.note())))
                                        .test_support()
                                        .w_full()
                                        .h_8()
                                        .flex()
                                        .items_center()
                                        .px_2()
                                        .when(row_state.is_selected(), |view| {
                                            view.bg(cx.theme().accent)
                                        })
                                        .child(format!(
                                            "{}{}{}",
                                            "  ".repeat(entry.depth()),
                                            if node.folder {
                                                if entry.is_expanded() { "▾ " } else { "▸ " }
                                            } else {
                                                ""
                                            },
                                            node.title
                                        ))
                                        .on_click(move |_, window, cx| {
                                            let _ = owner_open.update(cx, |this, cx| {
                                                if let Some(ix) = this.tree.read(cx).index_of(&key)
                                                {
                                                    this.tree.update(cx, |tree, cx| {
                                                        tree.set_selected_index(Some(ix), cx)
                                                    });
                                                }
                                                if !node.folder && !node.deleted {
                                                    this.open_note(
                                                        id.clone(),
                                                        true,
                                                        None,
                                                        window,
                                                        cx,
                                                    );
                                                }
                                            });
                                        }),
                                )
                                .into_any_element()
                        })
                        .list_style(StyleRefinement::default().flex_grow_1().size_full())
                        .size_full(),
                ),
            )
            .child(self.node_actions(cx));
        content.into_any_element()
    }
    fn node_actions(&self, cx: &mut Context<Self>) -> AnyElement {
        let selected = self.selected(cx);
        let owner = cx.weak_entity();
        div()
            .flex()
            .flex_wrap()
            .gap_1()
            .child(
                Button::new("workspace-node-actions")
                    .label("笔记操作")
                    .disabled(selected.is_none() || self.busy)
                    .dropdown_menu(move |mut menu, _, _| {
                        if let Some(node) = &selected {
                            for (label, kind) in [("重命名…", "rename"), ("编辑标签…", "tags")]
                            {
                                let owner = owner.clone();
                                menu = menu.item(PopupMenuItem::new(label).on_click(
                                    move |_, window, cx| {
                                        let _ = owner.update(cx, |this, cx| {
                                            this.name_dialog(kind, window, cx)
                                        });
                                    },
                                ));
                            }
                            let favorite = node.favorite;
                            let id = node.id.clone();
                            let expected = node.revision;
                            let owner_favorite = owner.clone();
                            menu = menu.item(
                                PopupMenuItem::new(if favorite {
                                    "取消收藏"
                                } else {
                                    "收藏"
                                })
                                .on_click(move |_, window, cx| {
                                    let _ = owner_favorite.update(cx, |this, cx| {
                                        this.mutate(
                                            WorkspaceCommand::Patch {
                                                id: id.clone(),
                                                expected,
                                                title: None,
                                                tags: None,
                                                favorite: Some(!favorite),
                                            },
                                            window,
                                            cx,
                                        )
                                    });
                                }),
                            );
                            let id = node.id.clone();
                            let restore = node.deleted;
                            let owner_trash = owner.clone();
                            menu = menu.item(
                                PopupMenuItem::new(if restore {
                                    "从回收站恢复"
                                } else {
                                    "移入回收站"
                                })
                                .on_click(move |_, window, cx| {
                                    let _ = owner_trash.update(cx, |this, cx| {
                                        this.mutate(
                                            WorkspaceCommand::Trash {
                                                id: id.clone(),
                                                restore,
                                            },
                                            window,
                                            cx,
                                        )
                                    });
                                }),
                            );
                            for (label, copy) in [("复制到笔记本…", true), ("移动到笔记本…", false)]
                            {
                                let owner = owner.clone();
                                let node = node.clone();
                                menu = menu.item(PopupMenuItem::new(label).on_click(
                                    move |_, window, cx| {
                                        let _ = owner.update(cx, |this, cx| {
                                            this.transfer_dialog(node.clone(), copy, window, cx)
                                        });
                                    },
                                ));
                            }
                            let owner_move = owner.clone();
                            let node = node.clone();
                            menu = menu.item(PopupMenuItem::new("移动 / 排序…").on_click(
                                move |_, window, cx| {
                                    let _ = owner_move.update(cx, |this, cx| {
                                        this.place_dialog(node.clone(), window, cx)
                                    });
                                },
                            ));
                        }
                        menu
                    }),
            )
            .child(
                Button::new("workspace-rename-book")
                    .small()
                    .ghost()
                    .label("笔记本封面…")
                    .disabled(self.busy)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.name_dialog("rename-book", window, cx)
                    })),
            )
            .into_any_element()
    }
    fn transfer_dialog(
        &mut self,
        node: Entry,
        copy: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let books = self
            .books
            .iter()
            .filter(|b| b.id != node.id.notebook() && !b.unavailable)
            .cloned()
            .collect::<Vec<_>>();
        let owner = cx.weak_entity();
        let operation = Uuid::new_v4();
        window.open_dialog(cx, move |dialog, _, _| {
            let mut content = div().flex().flex_col().gap_2();
            if books.is_empty() {
                content = content.child("先创建或打开另一个笔记本");
            }
            for book in &books {
                let owner = owner.clone();
                let node = node.clone();
                let target = book.id;
                content = content.child(
                    Button::new(SharedString::from(book.id.to_string()))
                        .label(book.title.clone())
                        .on_click(move |_, window, cx| {
                            window.close_dialog(cx);
                            let _ = owner.update(cx, |this, cx| {
                                this.mutate(
                                    WorkspaceCommand::Transfer {
                                        id: node.id.clone(),
                                        expected: node.revision,
                                        target,
                                        parent: None,
                                        copy,
                                        operation,
                                    },
                                    window,
                                    cx,
                                )
                            });
                        }),
                );
            }
            dialog
                .title(if copy {
                    "复制到笔记本"
                } else {
                    "移动到笔记本"
                })
                .child(content)
        });
    }
    fn place_dialog(&mut self, node: Entry, window: &mut Window, cx: &mut Context<Self>) {
        let nodes = self
            .nodes
            .iter()
            .filter(|n| n.id != node.id)
            .cloned()
            .collect::<Vec<_>>();
        let owner = cx.weak_entity();
        window.open_dialog(cx, move |dialog, _, _| {
            let mut content = div().id("place-targets").max_h_96().overflow_y_scrollbar();
            let root_owner = owner.clone();
            let root = node.clone();
            content = content.child(Button::new("place-root").label("移到根目录末尾").on_click(
                move |_, window, cx| {
                    window.close_dialog(cx);
                    let _ = root_owner.update(cx, |this, cx| {
                        this.mutate(
                            WorkspaceCommand::Place {
                                id: root.id.clone(),
                                expected: root.revision,
                                parent: None,
                                before: None,
                            },
                            window,
                            cx,
                        )
                    });
                },
            ));
            for target in &nodes {
                let owner = owner.clone();
                let node = node.clone();
                let target = target.clone();
                content = content.child(
                    Button::new(SharedString::from(target.id.note().to_string()))
                        .label(format!(
                            "{}{}",
                            if target.folder {
                                "移入目录："
                            } else {
                                "移到前面："
                            },
                            target.title
                        ))
                        .on_click(move |_, window, cx| {
                            window.close_dialog(cx);
                            let _ = owner.update(cx, |this, cx| {
                                this.mutate(
                                    WorkspaceCommand::Place {
                                        id: node.id.clone(),
                                        expected: node.revision,
                                        parent: if target.folder {
                                            Some(target.id.note())
                                        } else {
                                            target.parent
                                        },
                                        before: if target.folder {
                                            None
                                        } else {
                                            Some(target.id.note())
                                        },
                                    },
                                    window,
                                    cx,
                                )
                            });
                        }),
                );
            }
            dialog.title("移动 / 排序").child(content)
        });
    }
    fn reading(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(snapshot) = &self.snapshot else {
            return div()
                .flex_1()
                .p_6()
                .child("从目录选择笔记，或新建笔记开始记录。")
                .into_any_element();
        };
        let owner = cx.weak_entity();
        let mut pane = div()
            .flex()
            .flex_col()
            .size_full()
            .min_w_0()
            .bg(cx.theme().background)
            .child(
                div()
                    .flex()
                    .items_center()
                    .flex_wrap()
                    .gap_2()
                    .p_3()
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_lg()
                            .child(snapshot.content().title().to_owned()),
                    )
                    .child(
                        Button::new("workspace-edit")
                            .label(
                                if snapshot.primary_pdf().is_some()
                                    || snapshot.primary_image().is_some()
                                {
                                    "打开阅读器…"
                                } else {
                                    "编辑…"
                                },
                            )
                            .disabled(self.busy || self.revision.is_some())
                            .on_click(cx.listener(|this, _, window, cx| this.edit(window, cx))),
                    )
                    .child(Button::new("workspace-history").label("历史").on_click(
                        cx.listener(|this, _, window, cx| this.details(true, window, cx)),
                    ))
                    .child(
                        Button::new("workspace-backlinks")
                            .label("反向链接")
                            .on_click(
                                cx.listener(|this, _, window, cx| this.details(false, window, cx)),
                            ),
                    ),
            )
            .child(
                div()
                    .px_3()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child(format!(
                        "{} 字 · {}",
                        snapshot.content().body().chars().count(),
                        snapshot.content().tags().join(" · ")
                    )),
            );
        if let Some(revision) = self.revision {
            let id = snapshot.id().clone();
            let expected = snapshot.revision();
            pane = pane.child(
                div()
                    .flex()
                    .gap_2()
                    .p_2()
                    .child("历史版本预览")
                    .child(
                        Button::new("workspace-restore-revision")
                            .label("恢复此版本")
                            .disabled(self.busy)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.mutate(
                                    WorkspaceCommand::RestoreRevision {
                                        id: id.clone(),
                                        expected,
                                        revision,
                                    },
                                    window,
                                    cx,
                                )
                            })),
                    )
                    .child(
                        Button::new("workspace-current-revision")
                            .label("返回当前版本")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.revision = None;
                                if let Some(snapshot) = this.snapshot.clone() {
                                    this.set_reading_text(snapshot.content().body(), cx);
                                }
                                cx.notify();
                            })),
                    ),
            );
        }
        if !self.history.is_empty() {
            pane = pane.child(
                div()
                    .id("workspace-history-list")
                    .max_h_32()
                    .overflow_y_scrollbar()
                    .children(self.history.iter().map(|revision| {
                        let id = revision.id;
                        Button::new(SharedString::from(format!("revision-{id}")))
                            .small()
                            .ghost()
                            .label(format!("{} · {}", age(revision.created), revision.actor))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.preview_revision(id, window, cx)
                            }))
                    }))
                    .when(self.history_next.is_some(), |view| {
                        view.child(Button::new("history-more").label("更多历史").on_click(
                            cx.listener(|this, _, window, cx| this.details(true, window, cx)),
                        ))
                    }),
            );
        }
        if !self.backlinks.is_empty() {
            pane = pane.child(
                div()
                    .id("workspace-backlinks-list")
                    .max_h_32()
                    .overflow_y_scrollbar()
                    .children(self.backlinks.iter().map(|entry| {
                        let id = entry.id.clone();
                        Button::new(SharedString::from(format!("backlink-{}", id.note())))
                            .ghost()
                            .label(entry.title.clone())
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.open_note(id.clone(), true, None, window, cx)
                            }))
                    })),
            );
        }
        let image_scope = Some((
            snapshot.id().clone(),
            self.revision.unwrap_or(snapshot.head()),
        ));
        let client = self.client(cx);
        let mut headings = div().flex().flex_wrap().gap_1();
        for line in snapshot
            .content()
            .body()
            .lines()
            .filter(|line| line.starts_with('#'))
            .take(40)
        {
            let title = line.trim_start_matches('#').trim().to_owned();
            let target = title.clone();
            headings = headings.child(
                Button::new(SharedString::from(format!("heading-{title}")))
                    .small()
                    .ghost()
                    .label(title)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.follow_link(&format!("#{target}"), window, cx)
                    })),
            );
        }
        pane.child(headings)
            .child(
                div().flex_1().min_h_0().px_6().py_3().child(
                    TextView::new(&self.reader)
                        .markdown_extensions(self.reading_extensions.clone())
                        .image_source(move |uri| {
                            reading::image_source(uri, image_scope.clone(), client.clone())
                        })
                        .scrollable(true)
                        .on_link_click(move |url, _, window, cx| {
                            let _ = owner.update(cx, |this, cx| this.follow_link(url, window, cx));
                        }),
                ),
            )
            .into_any_element()
    }
    fn search_panel(&self, cx: &mut Context<Self>) -> AnyElement {
        div()
            .id("workspace-search-panel")
            .flex()
            .flex_col()
            .size_full()
            .gap_2()
            .p_3()
            .child(
                Input::new(&self.query)
                    .id("workspace-query")
                    .aria_label("搜索笔记"),
            )
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(
                        Button::new("search-scope")
                            .label(if self.search_all {
                                "所有笔记本"
                            } else {
                                "当前笔记本"
                            })
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.search_all = !this.search_all;
                                this.search(window, cx);
                            })),
                    )
                    .child(Input::new(&self.search_tag).aria_label("搜索标签").w_32())
                    .child(
                        Button::new("search-updated")
                            .label(
                                self.search_days
                                    .map(|days| format!("最近 {days} 天更新"))
                                    .unwrap_or_else(|| "所有时间".into()),
                            )
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.search_days = match this.search_days {
                                    None => Some(7),
                                    Some(7) => Some(30),
                                    Some(30) => Some(90),
                                    _ => None,
                                };
                                this.search(window, cx);
                            })),
                    )
                    .child(
                        Button::new("search-kind")
                            .label(match self.search_kind.as_deref() {
                                Some("markdown") => "文本笔记",
                                Some("pdf") => "PDF",
                                Some("image") => "图片",
                                _ => "所有类型",
                            })
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.search_kind = match this.search_kind.as_deref() {
                                    None => Some("markdown".into()),
                                    Some("markdown") => Some("pdf".into()),
                                    Some("pdf") => Some("image".into()),
                                    _ => None,
                                };
                                this.search(window, cx);
                            })),
                    )
                    .child(
                        Button::new("search-apply")
                            .label("搜索")
                            .on_click(cx.listener(|this, _, window, cx| this.search(window, cx))),
                    )
                    .child(
                        Button::new("search-next")
                            .label("下一页")
                            .disabled(self.search_cursor.is_none() || self.search_token.is_some())
                            .on_click(
                                cx.listener(|this, _, window, cx| this.search_page(window, cx)),
                            ),
                    )
                    .child(
                        Button::new("search-cancel")
                            .label("取消搜索")
                            .disabled(self.search_token.is_none())
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.cancel_search(window, cx);
                                this.status = "搜索已取消".into();
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("search-close")
                            .label("返回阅读")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.cancel_search(window, cx);
                                this.show_search = false;
                                cx.notify();
                            })),
                    ),
            )
            .child(div().text_sm().child(if self.search_token.is_some() {
                "正在搜索…".to_owned()
            } else {
                format!("{} 条结果", self.hits.len())
            }))
            .child(
                div()
                    .id("search-results")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scrollbar()
                    .children(self.hits.iter().map(|hit| {
                        let id = hit.entry.id.clone();
                        let anchor = hit.anchor.clone();
                        div()
                            .p_2()
                            .border_b_1()
                            .border_color(cx.theme().border)
                            .child(
                                Button::new(SharedString::from(format!(
                                    "hit-{}-{}",
                                    id.notebook(),
                                    id.note()
                                )))
                                .ghost()
                                .label(format!("{} / {}", hit.notebook, hit.entry.title))
                                .disabled(self.busy)
                                .on_click(cx.listener(
                                    move |this, _, window, cx| {
                                        this.show_search = false;
                                        this.open_note(
                                            id.clone(),
                                            true,
                                            anchor.clone(),
                                            window,
                                            cx,
                                        );
                                    },
                                )),
                            )
                            .child(
                                div()
                                    .text_sm()
                                    .text_color(cx.theme().muted_foreground)
                                    .child(hit.snippet.clone()),
                            )
                    })),
            )
            .into_any_element()
    }
}
impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let tabs = self.navigation.tabs.clone();
        let selected = tabs
            .iter()
            .position(|(id, _)| Some(id) == self.navigation.current.as_ref());
        let tabbar = TabBar::new("workspace-tabs-bar")
            .selected_index(selected.unwrap_or(0))
            .children(
                tabs.iter()
                    .map(|(_id, title)| Tab::new().label(title.clone()).aria_label(title.clone())),
            )
            .on_click(cx.listener(move |this, ix: &usize, window, cx| {
                if let Some((id, _)) = tabs.get(*ix) {
                    this.open_note(id.clone(), true, None, window, cx);
                }
            }));
        div()
            .id("workspace")
            .key_context("AnyNoteWorkspace")
            .track_focus(&self.focus)
            .flex()
            .flex_col()
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .on_action(
                cx.listener(|this, _: &NewBook, window, cx| this.name_dialog("book", window, cx)),
            )
            .on_action(
                cx.listener(|this, _: &NewNote, window, cx| this.name_dialog("note", window, cx)),
            )
            .on_action(
                cx.listener(|this, _: &NewFolder, window, cx| {
                    this.name_dialog("folder", window, cx)
                }),
            )
            .on_action(
                cx.listener(|this, _: &ShowBooks, window, cx| this.switch_book(None, window, cx)),
            )
            .on_action(cx.listener(|this, _: &SearchNotes, window, cx| {
                this.show_search = true;
                this.query.update(cx, |q, cx| q.focus(window, cx));
                this.search(window, cx);
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &Settings, window, cx| this.settings(window, cx)))
            .on_action(
                cx.listener(|this, _: &ImportFiles, window, cx| this.pick(false, window, cx)),
            )
            .on_action(cx.listener(|this, _: &Refresh, window, cx| this.refresh(window, cx)))
            .on_action(cx.listener(|this, _: &GoBack, window, cx| {
                if !this.busy
                    && let Some(id) = this.navigation.back()
                {
                    this.open_note(id, false, None, window, cx);
                }
            }))
            .on_action(cx.listener(|this, _: &GoForward, window, cx| {
                if !this.busy
                    && let Some(id) = this.navigation.forward()
                {
                    this.open_note(id, false, None, window, cx);
                }
            }))
            .on_action(cx.listener(|this, _: &CloseTab, window, cx| {
                this.close_tab(window, cx);
            }))
            .on_action(cx.listener(|this, _: &TreeFirst, _, cx| {
                this.tree.update(cx, |tree, cx| {
                    tree.set_selected_index(Some(0), cx);
                    tree.scroll_to_item(0, ScrollStrategy::Top);
                })
            }))
            .on_action(cx.listener(|this, _: &TreeLast, _, cx| {
                let mut ix = 0;
                while this.tree.read(cx).entry(ix + 1).is_some() {
                    ix += 1;
                }
                this.tree.update(cx, |tree, cx| {
                    tree.set_selected_index(Some(ix), cx);
                    tree.scroll_to_item(ix, ScrollStrategy::Bottom);
                });
            }))
            .on_action(cx.listener(|this, _: &OpenSelected, window, cx| {
                if let Some(node) = this.selected(cx)
                    && !node.folder
                    && !node.deleted
                {
                    this.open_note(node.id, true, None, window, cx);
                }
            }))
            .on_action(|_: &crate::shell::CloseWindow, window, _| window.remove_window())
            .on_action(cx.listener(|this, _: &crate::shell::ZoomIn, window, cx| {
                this.preferences.font_size = (this.preferences.font_size + 2.).min(32.);
                this.apply_theme(window, cx);
                this.persist_preferences(window, cx);
            }))
            .on_action(cx.listener(|this, _: &crate::shell::ZoomOut, window, cx| {
                this.preferences.font_size = (this.preferences.font_size - 2.).max(12.);
                this.apply_theme(window, cx);
                this.persist_preferences(window, cx);
            }))
            .on_action(
                cx.listener(|this, _: &crate::shell::ResetZoom, window, cx| {
                    this.preferences.font_size = 16.;
                    this.apply_theme(window, cx);
                    this.persist_preferences(window, cx);
                }),
            )
            .on_action(
                cx.listener(|this, _: &crate::shell::ToggleTheme, window, cx| {
                    this.preferences.theme = if cx.theme().is_dark() {
                        "light"
                    } else {
                        "dark"
                    }
                    .into();
                    this.apply_theme(window, cx);
                    this.persist_preferences(window, cx);
                }),
            )
            .on_action(
                cx.listener(|this, _: &crate::shell::FollowSystemTheme, window, cx| {
                    this.preferences.theme = "system".into();
                    this.apply_theme(window, cx);
                    this.persist_preferences(window, cx);
                }),
            )
            .on_drop(cx.listener(|this, paths: &ExternalPaths, window, cx| {
                if let Some(book) = this.book
                    && let Some(path) = paths.paths().first()
                {
                    this.mutate(
                        WorkspaceCommand::Import {
                            book,
                            parent: None,
                            path: path.clone(),
                        },
                        window,
                        cx,
                    );
                }
            }))
            .when(!cfg!(target_os = "macos"), |view| {
                view.child(self.menu.clone())
            })
            .child(self.toolbar(cx))
            .when(
                self.preferences.show_tabs && !self.navigation.tabs.is_empty(),
                |view| view.child(tabbar),
            )
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .child(if self.show_search {
                        self.search_panel(cx)
                    } else if self.book.is_none() {
                        self.bookshelf(cx)
                    } else {
                        gpui_kit::component::resizable::h_resizable("workspace-split")
                            .child(
                                gpui_kit::component::resizable::resizable_panel()
                                    .size(window.rem_size() * 18.)
                                    .size_range(
                                        (window.rem_size() * 12.)..(window.rem_size() * 30.),
                                    )
                                    .child(self.sidebar(cx)),
                            )
                            .child(
                                gpui_kit::component::resizable::resizable_panel()
                                    .child(self.reading(cx)),
                            )
                            .into_any_element()
                    }),
            )
            .child(
                div()
                    .id("workspace-status")
                    .test_support()
                    .role(Role::Status)
                    .aria_label(self.status.clone())
                    .flex()
                    .gap_2()
                    .p_2()
                    .text_sm()
                    .child(self.status.clone())
                    .when(self.operation.is_some() && !self.busy, |view| {
                        view.child(Button::new("workspace-retry").label("重试操作").on_click(
                            cx.listener(|this, _, window, cx| {
                                if let Some(command) = this.operation.clone() {
                                    this.mutate(command, window, cx);
                                }
                            }),
                        ))
                    }),
            )
    }
}

fn age(timestamp: i64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let minutes = now.saturating_sub(timestamp).max(0) / 60_000;
    match minutes {
        0 => "刚刚".into(),
        1..60 => format!("{minutes} 分钟前"),
        60..1440 => format!("{} 小时前", minutes / 60),
        _ => format!("{} 天前", minutes / 1440),
    }
}
