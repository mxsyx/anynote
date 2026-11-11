use super::*;
use anynote_editor::board::Library;
use gpui_kit::component::input::{Input, InputState};

pub(super) const MENUS: &[(&str, &[(&str, &str)])] = &[
    (
        "排列",
        &[
            ("front", "置于顶层"),
            ("back", "置于底层"),
            ("forward", "上移一层"),
            ("backward", "下移一层"),
            ("align-left", "左对齐"),
            ("align-center", "水平居中"),
            ("align-right", "右对齐"),
            ("align-top", "顶端对齐"),
            ("align-middle", "垂直居中"),
            ("align-bottom", "底端对齐"),
            ("distribute-x", "水平分布"),
            ("distribute-y", "垂直分布"),
        ],
    ),
    (
        "图形",
        &[
            ("flip-x", "水平翻转"),
            ("flip-y", "垂直翻转"),
            ("lock", "锁定"),
            ("unlock", "解锁所有图形"),
            ("properties", "属性…"),
            ("solid", "纯色填充"),
            ("hachure", "排线填充"),
            ("transparent", "无填充"),
            ("edit-text", "编辑文字…"),
            ("crop", "裁剪图片"),
            ("copy-text", "复制文字"),
            ("copy-styles", "复制样式"),
            ("paste-styles", "粘贴样式"),
        ],
    ),
    (
        "文件",
        &[
            ("import-library", "导入图库…"),
            ("save-library", "导出图库…"),
            ("copy-png", "复制为 PNG"),
            ("export-png", "导出 PNG…"),
            ("save-scene", "导出场景…"),
            ("clear", "清空画布"),
        ],
    ),
    (
        "视图",
        &[
            ("zoom-in", "放大"),
            ("zoom-out", "缩小"),
            ("reset-view", "重置缩放"),
            ("fit", "适应全部图形"),
            ("fit-selection", "适应选中图形"),
            ("theme", "切换主题"),
        ],
    ),
];

const STYLE_FIELDS: [(&str, &str); 4] = [
    ("strokeColor", "描边颜色"),
    ("backgroundColor", "填充颜色"),
    ("strokeWidth", "描边宽度"),
    ("opacity", "不透明度（0–100）"),
];

impl BoardView {
    fn fit(&mut self, selection: bool) {
        let selected = self.input.board().selected_ids();
        let points: Vec<_> = self
            .scene()
            .elements()
            .filter(|e| !e.is_deleted() && (!selection || selected.contains(e.id())))
            .filter_map(super::super::geometry::visible_bounds)
            .flat_map(|b| [BoardPoint::new(b[0], b[1]), BoardPoint::new(b[2], b[3])])
            .collect();
        if let Some(bounds) = super::super::geometry::bounds(&points) {
            let size = BoardPoint::new(
                f32::from(self.bounds.size.width) as f64,
                f32::from(self.bounds.size.height) as f64,
            );
            self.input.viewport_mut().fit(bounds, size);
        }
    }
    pub(super) fn tool_command(
        &mut self,
        name: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        match name {
            "properties" => self.properties(window, cx),
            "search" => self.search(window, cx),
            "library" => self.library_dialog(window, cx),
            "exit-group" => self.input.edit_group(None),
            "fit" | "fit-selection" => self.fit(name == "fit-selection"),
            "crop" => {
                let id = self.input.board().selected_ids().first().unwrap().clone();
                if let Some(natural) = self.assets.natural_sizes.get(&id) {
                    self.input.start_crop(id, *natural);
                } else {
                    self.input.set_error("图片尚未解码，无法裁剪");
                }
            }
            "clear" => {
                let ids = self
                    .scene()
                    .elements()
                    .filter(|e| !e.is_deleted())
                    .map(|e| e.id().to_owned())
                    .collect::<Vec<_>>();
                self.input.select(ids);
                self.apply(
                    vec![Command::Lock { locked: false }, Command::Delete],
                    window,
                    cx,
                );
            }
            "copy-text" => {
                let text = self
                    .scene()
                    .elements()
                    .filter(|e| self.input.board().selected_ids().contains(e.id()))
                    .filter_map(|e| e.field("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n");
                if !text.is_empty() {
                    cx.write_to_clipboard(ClipboardItem::new_string(text));
                }
            }
            "copy-styles" => {
                self.copied_style = self
                    .input
                    .board()
                    .selected_ids()
                    .first()
                    .and_then(|id| self.scene().element(id))
                    .map(|e| {
                        [
                            "strokeColor",
                            "backgroundColor",
                            "strokeWidth",
                            "opacity",
                            "fillStyle",
                            "strokeStyle",
                        ]
                        .into_iter()
                        .filter_map(|key| e.field(key).map(|v| (key.into(), v.clone())))
                        .collect()
                    });
            }
            "paste-styles" => {
                if let Some(properties) = self.copied_style.clone() {
                    self.apply(vec![Command::Style { properties }], window, cx);
                }
            }
            "add-library" => {
                let created = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                if let Err(error) = self.library.add_selection(
                    self.input.board(),
                    &Uuid::new_v4().to_string(),
                    created,
                ) {
                    self.input.set_error(format!("无法加入图库：{error}"));
                } else {
                    self.library_dialog(window, cx);
                }
            }
            "import-library" => self.import_library(window, cx),
            "export-png" | "copy-png" | "save-scene" | "save-library" => {
                self.export(name, window, cx)
            }
            _ => return false,
        }
        cx.notify();
        true
    }
    fn properties(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.input.cancel();
        let Some(element) = self
            .input
            .board()
            .selected_ids()
            .first()
            .and_then(|id| self.scene().element(id))
        else {
            return;
        };
        let initial_style: serde_json::Map<String, Value> = ["strokeStyle", "fillStyle"]
            .into_iter()
            .filter_map(|key| element.field(key).map(|v| (key.into(), v.clone())))
            .collect();
        let fields = STYLE_FIELDS.map(|(key, label)| {
            let value = element.field(key).cloned().unwrap_or_else(|| match key {
                "strokeWidth" => json!(1),
                "opacity" => json!(100),
                "backgroundColor" => json!("transparent"),
                _ => json!("#1e1e1e"),
            });
            let initial = value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| value.to_string());
            let input = cx.new(|cx| {
                let mut state = InputState::new(window, cx);
                state.set_value(initial.clone(), window, cx);
                state
            });
            (key, label, initial, input)
        });
        let owner = cx.weak_entity();
        let focus = self.focus.clone();
        let feedback = std::rc::Rc::new(std::cell::RefCell::new(None::<String>));
        let style = std::rc::Rc::new(std::cell::RefCell::new(serde_json::Map::new()));
        window.open_dialog(cx, move |dialog, _, cx| {
            let mut body = div().flex().flex_col().gap_3();
            for (key, label, _, input) in &fields {
                body = body.child(
                    div().flex().flex_col().gap_1().child(*label).child(
                        Input::new(input)
                            .id(SharedString::from(format!("board-property-{key}")))
                            .aria_label(*label),
                    ),
                );
            }
            for (key, label, options) in [
                (
                    "strokeStyle",
                    "线型",
                    vec![("solid", "实线"), ("dashed", "虚线"), ("dotted", "点线")],
                ),
                (
                    "fillStyle",
                    "填充",
                    vec![
                        ("solid", "纯色"),
                        ("hachure", "排线"),
                        ("cross-hatch", "交叉排线"),
                    ],
                ),
            ] {
                let mut row = div().flex().flex_wrap().gap_1().items_center().child(label);
                for (value, label) in options {
                    let style = style.clone();
                    let selected = style
                        .borrow()
                        .get(key)
                        .or_else(|| initial_style.get(key))
                        .and_then(Value::as_str)
                        == Some(value);
                    row = row.child(
                        Button::new(SharedString::from(format!("board-{key}-{value}")))
                            .small()
                            .label(label)
                            .selected(selected)
                            .on_click(move |_, _, cx| {
                                style.borrow_mut().insert(key.into(), json!(value));
                                cx.refresh_windows();
                            }),
                    );
                }
                body = body.child(row);
            }
            if let Some(error) = feedback.borrow().clone() {
                body = body.child(div().text_color(cx.theme().danger).child(error));
            }
            let fields = fields.clone();
            let owner = owner.clone();
            let focus = focus.clone();
            let feedback = feedback.clone();
            let style = style.clone();
            dialog
                .title("选中图形的属性")
                .child(body)
                .footer(
                    DialogFooter::new()
                        .child(DialogClose::new().trigger(|b| b.label("取消")))
                        .child(
                            DialogAction::new().child(
                                Button::new("board-apply-properties")
                                    .primary()
                                    .label("应用"),
                            ),
                        ),
                )
                .on_close(move |_, w, cx| focus.focus(w, cx))
                .on_ok(move |_, w, cx| {
                    let result = (|| -> Result<_, String> {
                        let mut properties = style.borrow().clone();
                        for (key, label, initial, input) in &fields {
                            let value = input.read(cx).value().trim().to_owned();
                            if &value == initial {
                                continue;
                            }
                            let value = if matches!(*key, "strokeWidth" | "opacity") {
                                let number: f64 =
                                    value.parse().map_err(|_| format!("{label}需要数字"))?;
                                if !number.is_finite() || number < 0. || number > 100. {
                                    return Err(format!("{label}需要在 0–100 之间"));
                                }
                                json!(number)
                            } else {
                                if value != "transparent" && Rgba::try_from(value.as_str()).is_err()
                                {
                                    return Err(format!("{label}需要十六进制颜色或 transparent"));
                                }
                                json!(value)
                            };
                            properties.insert((*key).into(), value);
                        }
                        Ok(Command::Style { properties })
                    })();
                    owner
                        .update(cx, |this, cx| {
                            match result {
                                Ok(command) => {
                                    this.apply(vec![command], w, cx);
                                    *feedback.borrow_mut() = this.input.error().map(str::to_owned);
                                }
                                Err(error) => {
                                    *feedback.borrow_mut() = Some(error);
                                    cx.notify();
                                }
                            }
                            feedback.borrow().is_none()
                        })
                        .unwrap_or(true)
                })
        });
    }
    fn search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let query = cx.new(|cx| InputState::new(window, cx).placeholder("搜索白板文字"));
        self.dialog_subscription = Some(cx.subscribe(
            &query,
            |_, _, event: &gpui_kit::component::input::InputEvent, cx| {
                if matches!(event, gpui_kit::component::input::InputEvent::Change) {
                    cx.refresh_windows();
                }
            },
        ));
        let owner = cx.weak_entity();
        let focus = self.focus.clone();
        window.open_dialog(cx, move |dialog, _, cx| {
            let needle = query.read(cx).value().to_lowercase();
            let results: Vec<_> = owner
                .upgrade()
                .map(|owner| {
                    owner
                        .read(cx)
                        .scene()
                        .elements()
                        .filter(|e| !e.is_deleted())
                        .filter_map(|e| {
                            let text = e.field("text")?.as_str()?;
                            (!needle.is_empty() && text.to_lowercase().contains(&needle))
                                .then(|| (e.id().to_owned(), text.to_owned()))
                        })
                        .take(100)
                        .collect()
                })
                .unwrap_or_default();
            let mut body = div()
                .id("board-search-results")
                .flex()
                .flex_col()
                .gap_1()
                .max_h(rems(18.))
                .overflow_y_scroll();
            if results.is_empty() {
                body = body.child(if needle.is_empty() {
                    "输入文字开始搜索"
                } else {
                    "没有匹配的文字"
                });
            }
            for (id, text) in results {
                let owner = owner.clone();
                body = body.child(
                    Button::new(SharedString::from(format!("board-search-{id}")))
                        .ghost()
                        .label(text.chars().take(80).collect::<String>())
                        .on_click(move |_, w, cx| {
                            let _ = owner.update(cx, |this, cx| {
                                this.input.select([id.clone()]);
                                this.fit(true);
                                cx.notify();
                            });
                            w.close_dialog(cx);
                        }),
                );
            }
            let focus = focus.clone();
            dialog
                .title("搜索白板")
                .child(
                    Input::new(&query)
                        .id("board-search-query")
                        .aria_label("搜索白板文字"),
                )
                .child(body)
                .child(
                    div()
                        .text_sm()
                        .text_color(cx.theme().muted_foreground)
                        .child("最多显示 100 项；可继续输入缩小范围"),
                )
                .on_close(move |_, w, cx| focus.focus(w, cx))
        });
    }
    fn library_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let owner = cx.weak_entity();
        let focus = self.focus.clone();
        window.open_dialog(cx, move |dialog, _, cx| {
            let items: Vec<_> = owner
                .upgrade()
                .map(|v| {
                    v.read(cx)
                        .library
                        .items()
                        .iter()
                        .take(100)
                        .map(|item| {
                            let elements = item["elements"].as_array().unwrap();
                            let title = elements
                                .iter()
                                .find_map(|e| e.get("text").and_then(Value::as_str))
                                .map(|s| s.chars().take(40).collect::<String>())
                                .unwrap_or_else(|| format!("{} 个图形", elements.len()));
                            (item["id"].as_str().unwrap().to_owned(), title)
                        })
                        .collect()
                })
                .unwrap_or_default();
            let mut body = div()
                .id("board-library-items")
                .flex()
                .flex_col()
                .gap_2()
                .max_h(rems(20.))
                .overflow_y_scroll();
            if items.is_empty() {
                body = body.child("选择图形后，从更多菜单加入图库");
            }
            for (id, title) in items {
                let insert_owner = owner.clone();
                let remove_owner = owner.clone();
                let remove_id = id.clone();
                body = body.child(
                    div()
                        .flex()
                        .gap_2()
                        .items_center()
                        .child(
                            Button::new(SharedString::from(format!("board-library-insert-{id}")))
                                .label(format!("插入 {title}"))
                                .on_click(move |_, w, cx| {
                                    let inserted = insert_owner
                                        .update(cx, |this, cx| {
                                            let result = this
                                                .library
                                                .clipboard(&id)
                                                .and_then(|v| v.serialize())
                                                .map_err(|e| e.to_string())
                                                .and_then(|source| {
                                                    clipboard::paste(
                                                        &source,
                                                        this.input
                                                            .viewport()
                                                            .to_world(this.center()),
                                                    )
                                                });
                                            match result {
                                                Ok(command) => this.apply(vec![command], w, cx),
                                                Err(error) => this.input.set_error(error),
                                            }
                                            this.input.error().is_none()
                                        })
                                        .unwrap_or(false);
                                    if inserted {
                                        w.close_dialog(cx);
                                    }
                                }),
                        )
                        .child(
                            Button::new(SharedString::from(format!(
                                "board-library-remove-{remove_id}"
                            )))
                            .ghost()
                            .label("移除")
                            .on_click(move |_, _, cx| {
                                let _ = remove_owner.update(cx, |this, cx| {
                                    if let Err(error) = this
                                        .library
                                        .remove(&[remove_id.clone()].into_iter().collect())
                                    {
                                        this.input.set_error(error.to_string());
                                    }
                                    cx.notify();
                                });
                                cx.refresh_windows();
                            }),
                        ),
                );
            }
            let focus = focus.clone();
            dialog
                .title("图库")
                .child(body)
                .child(
                    div()
                        .text_sm()
                        .child("本窗口图库 · 关闭前可在更多菜单导出 · 最多显示 100 项"),
                )
                .on_close(move |_, w, cx| focus.focus(w, cx))
        });
    }
    fn import_library(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.file_busy = true;
        let selection = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("导入图库".into()),
        });
        self.file_task = Some(cx.spawn_in(window, async move |this, cx| {
            let result = match selection.await {
                Ok(Ok(Some(paths))) => match paths.into_iter().next() {
                    Some(path) => Some(
                        cx.background_spawn(async move {
                            use std::io::Read;
                            let mut source = String::new();
                            std::fs::File::open(path)
                                .and_then(|f| {
                                    f.take(16 * 1024 * 1024 + 1).read_to_string(&mut source)
                                })
                                .map_err(|e| e.to_string())?;
                            Library::parse(&source).map_err(|e| e.to_string())
                        })
                        .await,
                    ),
                    None => None,
                },
                Ok(Err(error)) => Some(Err(error.to_string())),
                _ => None,
            };
            let _ = this.update_in(cx, |this, w, cx| {
                this.file_busy = false;
                if let Some(result) = result {
                    match result
                        .and_then(|library| this.library.merge(&library).map_err(|e| e.to_string()))
                    {
                        Ok(_) => this.library_dialog(w, cx),
                        Err(error) => this.input.set_error(format!("无法导入图库：{error}")),
                    }
                }
                cx.notify();
            });
        }));
    }
    fn export(&mut self, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        let png = matches!(name, "export-png" | "copy-png");
        let copy = name == "copy-png";
        let scene = self.scene().clone();
        let library = (name == "save-library").then(|| self.library.clone());
        let filename = if png {
            "whiteboard.png"
        } else if name == "save-library" {
            "whiteboard.excalidrawlib"
        } else {
            "whiteboard.excalidraw"
        };
        let selection =
            (!copy).then(|| cx.prompt_for_new_path(std::path::Path::new("."), Some(filename)));
        self.file_busy = true;
        self.file_task = Some(cx.spawn_in(window, async move |this, cx| {
            let destination = if let Some(selection) = selection {
                match selection.await {
                    Ok(Ok(Some(path))) => Some(path),
                    result => {
                        let _ = this.update(cx, |this, cx| {
                            this.file_busy = false;
                            if let Ok(Err(error)) = result {
                                this.input.set_error(format!("无法导出：{error}"));
                            }
                            cx.notify();
                        });
                        return;
                    }
                }
            } else {
                None
            };
            let result: Result<Option<Vec<u8>>, String> = cx
                .background_spawn(async move {
                    let bytes = if png {
                        super::super::preview::png(&scene)?
                    } else {
                        let source = if let Some(library) = library {
                            library.serialize()
                        } else {
                            scene.serialize()
                        };
                        source.map_err(|e| e.to_string())?.into_bytes()
                    };
                    if let Some(path) = destination {
                        std::fs::write(path, &bytes).map_err(|e| e.to_string())?;
                        Ok(None)
                    } else {
                        Ok(Some(bytes))
                    }
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.file_busy = false;
                match result {
                    Ok(Some(bytes)) => cx.write_to_clipboard(ClipboardItem::new_image(
                        &Image::from_bytes(ImageFormat::Png, bytes),
                    )),
                    Ok(None) => {}
                    Err(error) => this.input.set_error(format!("无法导出：{error}")),
                }
                cx.notify();
            });
        }));
    }
}
