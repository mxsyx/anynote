use super::{
    assets::Assets,
    clipboard,
    geometry::Viewport,
    input::{BoardInput, Tool, drawing},
    paint, text,
};
use anynote_editor::board::{
    Alignment, Axis, Command, Element, ElementKind, Geometry, Layer, Point as BoardPoint, Scene,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use gpui_kit::{
    component::{
        ActiveTheme, Disableable, Selectable, Sizable, Theme, ThemeMode, WindowExt,
        button::{Button, ButtonVariants},
        dialog::{DialogAction, DialogClose, DialogFooter},
        input::{Textarea, TextareaState},
        menu::DropdownMenu,
    },
    prelude::*,
    *,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use uuid::Uuid;

#[derive(Clone, PartialEq, Deserialize, Action)]
#[action(no_json)]
struct BoardCommand {
    name: String,
}
impl BoardCommand {
    fn new(name: &str) -> Self {
        Self { name: name.into() }
    }
}
pub fn install_actions(cx: &mut App) {
    super::session::install_actions(cx);
    let primary = if cfg!(target_os = "macos") {
        "cmd"
    } else {
        "ctrl"
    };
    for (key, name) in [
        ("z", "undo"),
        ("shift-z", "redo"),
        ("a", "select-all"),
        ("c", "copy"),
        ("x", "cut"),
        ("v", "paste"),
        ("d", "duplicate"),
        ("g", "group"),
        ("shift-g", "ungroup"),
        ("=", "zoom-in"),
        ("-", "zoom-out"),
        ("0", "reset-view"),
    ] {
        cx.bind_keys([KeyBinding::load(
            &format!("{primary}-{key}"),
            Box::new(BoardCommand::new(name)),
            Some(std::rc::Rc::new(
                KeyBindingContextPredicate::parse("Whiteboard").unwrap(),
            )),
            false,
            None,
            cx,
        )
        .expect("board key binding")]);
    }
    for (key, name) in [
        ("backspace", "delete"),
        ("delete", "delete"),
        ("escape", "cancel"),
        ("left", "left"),
        ("right", "right"),
        ("up", "up"),
        ("down", "down"),
        ("shift-left", "left-fast"),
        ("shift-right", "right-fast"),
        ("shift-up", "up-fast"),
        ("shift-down", "down-fast"),
        ("enter", "edit-text"),
    ] {
        cx.bind_keys([KeyBinding::new(
            key,
            BoardCommand::new(name),
            Some("Whiteboard"),
        )]);
    }
}

pub struct BoardView {
    input: BoardInput,
    focus: FocusHandle,
    bounds: Bounds<Pixels>,
    assets: Assets,
    asset_scene: Option<Scene>,
    task: Option<Task<()>>,
    import_task: Option<Task<()>>,
    cancel: Arc<AtomicBool>,
    generation: u64,
    loading: bool,
    importing: bool,
    space: bool,
    release: Option<Subscription>,
    blur: Option<Subscription>,
}
impl Focusable for BoardView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}
impl BoardView {
    pub fn new(scene: Scene, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle().tab_stop(true);
        focus.focus(window, cx);
        let mut view = Self {
            input: BoardInput::new(scene),
            focus,
            bounds: Bounds::default(),
            assets: Assets::default(),
            asset_scene: None,
            task: None,
            import_task: None,
            cancel: Arc::new(AtomicBool::new(false)),
            generation: 0,
            loading: false,
            importing: false,
            space: false,
            release: None,
            blur: None,
        };
        view.blur = Some(cx.on_blur(&view.focus, window, |this, _, cx| {
            this.space = false;
            this.input.cancel();
            cx.notify();
        }));
        view.release = Some(cx.on_release(|this, cx| {
            this.cancel.store(true, Ordering::Relaxed);
            for (_, image) in std::mem::take(&mut this.assets.images) {
                cx.drop_image(image, None);
            }
        }));
        view.reload_assets(window, cx);
        view
    }
    pub fn scene(&self) -> &Scene {
        self.input.board().scene()
    }
    pub fn input(&self) -> &BoardInput {
        &self.input
    }
    pub fn is_loading(&self) -> bool {
        self.loading || self.importing
    }
    fn enabled(&self, name: &str) -> bool {
        let selected = self.input.board().selected_ids();
        match name {
            "group" => selected.len() > 1,
            "ungroup" => self.scene().elements().any(|e| {
                selected.contains(e.id())
                    && e.field("groupIds")
                        .and_then(Value::as_array)
                        .is_some_and(|g| !g.is_empty())
            }),
            "unlock" => self
                .scene()
                .elements()
                .any(|e| !e.is_deleted() && e.is_locked()),
            "copy" | "cut" | "duplicate" | "delete" | "front" | "back" | "forward" | "backward"
            | "align-left" | "align-center" | "align-top" | "distribute-x" | "flip-x"
            | "flip-y" | "lock" | "solid" | "hachure" | "transparent" => !selected.is_empty(),
            _ => true,
        }
    }
    fn reload_assets(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self
            .asset_scene
            .as_ref()
            .is_some_and(|previous| super::assets::same_inputs(self.scene(), previous))
        {
            return;
        }
        self.cancel.store(true, Ordering::Relaxed);
        self.cancel = Arc::new(AtomicBool::new(false));
        self.generation += 1;
        let generation = self.generation;
        let scene = self.scene().clone();
        self.asset_scene = Some(scene.clone());
        let cancel = self.cancel.clone();
        self.loading = true;
        self.task = Some(cx.spawn_in(window, async move |this, cx| {
            let assets = cx
                .background_spawn(async move { Assets::load(&scene, &cancel) })
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                for (_, image) in std::mem::take(&mut this.assets.images) {
                    cx.drop_image(image, None);
                }
                this.assets = assets;
                this.loading = false;
                cx.notify();
            });
        }));
    }
    fn local(&self, p: Point<Pixels>) -> BoardPoint {
        BoardPoint::new(
            f32::from(p.x - self.bounds.left()) as f64,
            f32::from(p.y - self.bounds.top()) as f64,
        )
    }
    fn center(&self) -> BoardPoint {
        BoardPoint::new(
            f32::from(self.bounds.size.width) as f64 / 2.,
            f32::from(self.bounds.size.height) as f64 / 2.,
        )
    }
    fn apply(&mut self, commands: Vec<Command>, window: &mut Window, cx: &mut Context<Self>) {
        if self.input.execute(&commands) {
            self.reload_assets(window, cx);
        }
        cx.notify();
    }
    fn command(&mut self, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        if !self.enabled(name) {
            return;
        }
        let selected = self.input.board().selected_ids();
        let command = match name {
            "undo" => {
                self.input.undo();
                self.reload_assets(window, cx);
                None
            }
            "redo" => {
                self.input.redo();
                self.reload_assets(window, cx);
                None
            }
            "cancel" => {
                if self.input.is_dragging() {
                    self.input.cancel();
                } else {
                    self.input.select([]);
                    self.input.set_tool(Tool::Select);
                }
                None
            }
            "select-all" => {
                self.input.select_all();
                None
            }
            "copy" | "cut" => match clipboard::copy(self.input.board()) {
                Ok(text) => {
                    cx.write_to_clipboard(ClipboardItem::new_string(text));
                    if name == "cut" {
                        Some(Command::Delete)
                    } else {
                        None
                    }
                }
                Err(error) => {
                    self.input.set_error(error);
                    None
                }
            },
            "paste" => {
                let item = cx.read_from_clipboard();
                if let Some(image) = item.as_ref().and_then(|item| {
                    item.entries().iter().find_map(|entry| {
                        if let ClipboardEntry::Image(i) = entry {
                            Some(i)
                        } else {
                            None
                        }
                    })
                }) {
                    self.import_bytes(image.bytes().to_vec(), window, cx);
                    return;
                }
                if let Some(text) = item.and_then(|i| i.text()) {
                    match clipboard::paste(&text, self.input.viewport().to_world(self.center())) {
                        Ok(command) => Some(command),
                        Err(error) => {
                            self.input.set_error(error);
                            None
                        }
                    }
                } else {
                    None
                }
            }
            "duplicate" => Some(clipboard::duplicate(
                self.input.board(),
                BoardPoint::new(20., 20.),
            )),
            "delete" => Some(Command::Delete),
            "group" => Some(Command::Group {
                id: Uuid::new_v4().to_string(),
            }),
            "ungroup" => {
                let groups: std::collections::BTreeSet<_> = self
                    .scene()
                    .elements()
                    .filter(|e| selected.contains(e.id()))
                    .filter_map(|e| {
                        e.field("groupIds")?
                            .as_array()?
                            .last()?
                            .as_str()
                            .map(str::to_owned)
                    })
                    .collect();
                self.apply(
                    groups
                        .into_iter()
                        .map(|id| Command::Ungroup { id })
                        .collect(),
                    window,
                    cx,
                );
                return;
            }
            "front" => Some(Command::Layer {
                layer: Layer::Front,
            }),
            "back" => Some(Command::Layer { layer: Layer::Back }),
            "forward" => Some(Command::Layer {
                layer: Layer::Forward,
            }),
            "backward" => Some(Command::Layer {
                layer: Layer::Backward,
            }),
            "align-left" => Some(Command::Align {
                axis: Axis::X,
                alignment: Alignment::Start,
            }),
            "align-center" => Some(Command::Align {
                axis: Axis::X,
                alignment: Alignment::Center,
            }),
            "align-top" => Some(Command::Align {
                axis: Axis::Y,
                alignment: Alignment::Start,
            }),
            "distribute-x" => Some(Command::Distribute { axis: Axis::X }),
            "flip-x" => Some(Command::Flip { axis: Axis::X }),
            "flip-y" => Some(Command::Flip { axis: Axis::Y }),
            "lock" => Some(Command::Lock { locked: true }),
            "unlock" => {
                let ids: Vec<_> = self
                    .scene()
                    .elements()
                    .filter(|e| !e.is_deleted() && e.is_locked())
                    .map(|e| e.id().to_owned())
                    .collect();
                self.input.select(ids);
                Some(Command::Lock { locked: false })
            }
            "left" | "right" | "up" | "down" | "left-fast" | "right-fast" | "up-fast"
            | "down-fast" => {
                let step = if name.ends_with("fast") { 10. } else { 1. };
                Some(Command::Translate {
                    delta: match name.split('-').next().unwrap() {
                        "left" => BoardPoint::new(-step, 0.),
                        "right" => BoardPoint::new(step, 0.),
                        "up" => BoardPoint::new(0., -step),
                        _ => BoardPoint::new(0., step),
                    },
                })
            }
            "zoom-in" | "zoom-out" => {
                let center = self.center();
                self.input
                    .viewport_mut()
                    .zoom_at(if name == "zoom-in" { 1.25 } else { 0.8 }, center);
                None
            }
            "reset-view" => {
                *self.input.viewport_mut() = Viewport::default();
                None
            }
            "theme" => {
                Theme::change(
                    if cx.theme().mode.is_dark() {
                        ThemeMode::Light
                    } else {
                        ThemeMode::Dark
                    },
                    Some(window),
                    cx,
                );
                None
            }
            "edit-text" => {
                self.edit_text(self.input.viewport().to_world(self.center()), window, cx);
                None
            }
            "image" => {
                self.pick_image(window, cx);
                None
            }
            "solid" | "hachure" => Some(Command::Style {
                properties: json!({"fillStyle":name,"backgroundColor":"#a5d8ff"})
                    .as_object()
                    .unwrap()
                    .clone(),
            }),
            "transparent" => Some(Command::Style {
                properties: json!({"backgroundColor":"transparent"})
                    .as_object()
                    .unwrap()
                    .clone(),
            }),
            _ => None,
        };
        if let Some(command) = command {
            self.apply(vec![command], window, cx);
        }
        cx.notify();
    }
    fn edit_text(&mut self, at: BoardPoint, window: &mut Window, cx: &mut Context<Self>) {
        self.input.cancel();
        let selected = self.input.board().selected_ids();
        let existing = if selected.len() == 1 {
            self.scene()
                .element(selected.first().unwrap())
                .filter(|e| e.kind() == ElementKind::Text)
                .cloned()
        } else {
            None
        };
        let mut value = existing
            .as_ref()
            .map(Element::to_json)
            .unwrap_or_else(|| drawing(&Uuid::new_v4().to_string(), Tool::Text, at, at, &[at]));
        if existing.is_none() {
            value["fontSize"] = json!(20);
            value["fontFamily"] = json!(2);
            value["lineHeight"] = json!(1.25);
            value["textAlign"] = json!("left");
            value["containerId"] = Value::Null;
            value["autoResize"] = json!(true);
        }
        let input = cx.new(|cx| {
            let mut state = TextareaState::new(window, cx);
            state.set_value(
                value.get("text").and_then(Value::as_str).unwrap_or(""),
                window,
                cx,
            );
            state
        });
        let owner = cx.weak_entity();
        let focus = self.focus.clone();
        let feedback = std::rc::Rc::new(std::cell::RefCell::new(None::<String>));
        window.open_dialog(cx, move |dialog, _, _| {
            let input = input.clone();
            let owner = owner.clone();
            let value = value.clone();
            let existing = existing.clone();
            let focus = focus.clone();
            let feedback = feedback.clone();
            let mut dialog = dialog
                .title("白板文字")
                .child(Textarea::new(&input).aria_label("白板文字内容").h(rems(8.)));
            if let Some(error) = feedback.borrow().clone() {
                dialog = dialog.child(div().text_sm().child(error));
            }
            dialog
                .footer(
                    DialogFooter::new()
                        .child(DialogClose::new().trigger(|button| button.label("取消")))
                        .child(
                            DialogAction::new()
                                .child(Button::new("board-apply-text").primary().label("应用")),
                        ),
                )
                .on_close(move |_, window, cx| {
                    focus.focus(window, cx);
                })
                .on_ok(move |_, window, cx| {
                    let text = input.read(cx).value().to_string();
                    let mut value = value.clone();
                    let result = (|| -> Result<Command, String> {
                        if text.trim().is_empty() {
                            return Err("请输入文字".into());
                        }
                        let element =
                            Element::from_json(value.clone()).map_err(|e| e.to_string())?;
                        let layout = text::layout(&element, &text)?;
                        let g = element.geometry().map_err(|e| e.to_string())?;
                        let geometry =
                            Geometry::new(g.x(), g.y(), layout.width, layout.height, g.angle())
                                .map_err(|e| e.to_string())?;
                        if existing.is_some() {
                            Ok(Command::Text {
                                id: element.id().into(),
                                text,
                                geometry,
                            })
                        } else {
                            value["text"] = json!(text);
                            value["originalText"] = value["text"].clone();
                            value["width"] = json!(layout.width);
                            value["height"] = json!(layout.height);
                            Ok(Command::Insert {
                                elements: vec![value],
                                files: Default::default(),
                            })
                        }
                    })();
                    owner
                        .update(cx, |this, cx| match result {
                            Ok(command) => {
                                let changed = this.input.execute(&[command]);
                                if changed {
                                    this.input.set_tool(Tool::Select);
                                    this.reload_assets(window, cx);
                                }
                                cx.notify();
                                let success = this.input.error().is_none();
                                if !success {
                                    *feedback.borrow_mut() = this.input.error().map(str::to_owned);
                                }
                                success
                            }
                            Err(error) => {
                                *feedback.borrow_mut() = Some(error.clone());
                                this.input.set_error(error);
                                cx.notify();
                                false
                            }
                        })
                        .unwrap_or(true)
                })
        });
    }
    fn pick_image(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.importing {
            return;
        }
        self.importing = true;
        let selection = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("插入图片".into()),
        });
        self.import_task = Some(cx.spawn_in(window, async move |this, cx| {
            let path = match selection.await {
                Ok(Ok(Some(paths))) => paths.into_iter().next(),
                _ => None,
            };
            let bytes = if let Some(path) = path {
                Some(
                    cx.background_spawn(async move {
                        use std::io::Read;
                        let mut bytes = Vec::new();
                        std::fs::File::open(path)
                            .and_then(|f| {
                                f.take(crate::image::codec::MAX_BYTES as u64 + 1)
                                    .read_to_end(&mut bytes)
                            })
                            .map_err(|e| e.to_string())?;
                        Ok::<_, String>(bytes)
                    })
                    .await,
                )
            } else {
                None
            };
            let _ = this.update_in(cx, |this, window, cx| {
                this.importing = false;
                match bytes {
                    Some(Ok(bytes)) => this.import_bytes(bytes, window, cx),
                    Some(Err(error)) => this.input.set_error(error),
                    None => {}
                }
                cx.notify();
            });
        }));
    }
    fn import_bytes(&mut self, bytes: Vec<u8>, window: &mut Window, cx: &mut Context<Self>) {
        if self.importing {
            return;
        }
        self.importing = true;
        let anchor = self.input.viewport().to_world(self.center());
        self.import_task=Some(cx.spawn_in(window,async move |this,cx| {
            let result=cx.background_spawn(async move {
                let info=crate::image::codec::inspect(&bytes)?;
                let scale=(320./info.width.max(info.height) as f64).min(1.);
                let file=Uuid::new_v4().to_string();
                let mut value=drawing(&Uuid::new_v4().to_string(),Tool::Rectangle,anchor,anchor,&[anchor]);
                value["type"]=json!("image");value["fileId"]=json!(file);value["width"]=json!(info.width as f64*scale);value["height"]=json!(info.height as f64*scale);value["scale"]=json!([1,1]);value["status"]=json!("saved");value["crop"]=Value::Null;
                let mut files=serde_json::Map::new();files.insert(file.clone(),json!({"id":file,"mimeType":info.mime,"dataURL":format!("data:{};base64,{}",info.mime,STANDARD.encode(bytes))}));
                Ok::<_,String>(Command::Insert{elements:vec![value],files})
            }).await;
            let _=this.update_in(cx,|this,window,cx| {this.importing=false;match result {Ok(command)=>this.apply(vec![command],window,cx),Err(error)=>this.input.set_error(error)}cx.notify();});
        }));
    }
    fn pointer_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.focus.focus(window, cx);
        let local = self.local(event.position);
        if self.input.tool() == Tool::Text && !self.space {
            self.input.select([]);
            self.edit_text(self.input.viewport().to_world(local), window, cx);
        } else if event.click_count == 2 {
            if let Some(id) = super::geometry::hit_test(
                self.scene(),
                self.input.viewport().to_world(local),
                self.input.viewport().zoom(),
            ) {
                let text = self
                    .scene()
                    .element(&id)
                    .is_some_and(|e| e.kind() == ElementKind::Text);
                self.input.select([id]);
                if text {
                    self.edit_text(self.input.viewport().to_world(local), window, cx);
                }
            }
        } else {
            self.input.begin(
                local,
                event.modifiers.shift,
                self.space || event.button == MouseButton::Middle,
            );
        }
        cx.notify();
        cx.stop_propagation();
    }
    fn pointer_up(&mut self, event: &MouseUpEvent, window: &mut Window, cx: &mut Context<Self>) {
        if !self.input.is_dragging() {
            return;
        }
        self.input
            .update(self.local(event.position), event.modifiers.shift);
        if self.input.finish() {
            self.reload_assets(window, cx);
        }
        cx.notify();
    }
    fn key_down(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let key = &event.keystroke;
        if key.modifiers.platform || key.modifiers.control || key.modifiers.alt {
            return;
        }
        if key.key == "space" {
            self.space = true;
            cx.stop_propagation();
            return;
        }
        let tool = match key.key.as_str() {
            "v" | "1" => Tool::Select,
            "h" => Tool::Hand,
            "r" | "2" => Tool::Rectangle,
            "d" | "3" => Tool::Diamond,
            "e" | "4" => Tool::Ellipse,
            "a" | "5" => Tool::Arrow,
            "l" | "6" => Tool::Line,
            "p" | "7" => Tool::Freedraw,
            "t" | "8" => Tool::Text,
            _ => return,
        };
        self.input.set_tool(tool);
        cx.stop_propagation();
        cx.notify();
    }
}
impl Render for BoardView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let focus = self.focus.clone();
        let menu_owner = cx.entity().downgrade();
        let owner = cx.entity();
        let paint_owner = owner.clone();
        let canvas = canvas(
            move |bounds, _, cx| owner.update(cx, |this, _| this.bounds = bounds),
            move |bounds, _, window, cx| {
                paint_owner.update(cx, |this, cx| {
                    paint::paint(&this.input, &this.assets, bounds, window, cx)
                });
            },
        )
        .size_full();
        let mut toolbar = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap_1()
            .p_2()
            .border_b_1()
            .border_color(cx.theme().border);
        for tool in [
            Tool::Select,
            Tool::Hand,
            Tool::Rectangle,
            Tool::Diamond,
            Tool::Ellipse,
            Tool::Line,
            Tool::Arrow,
            Tool::Freedraw,
            Tool::Text,
        ] {
            toolbar = toolbar.child(
                Button::new(tool.id())
                    .small()
                    .ghost()
                    .label(tool.label())
                    .selected(self.input.tool() == tool)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.input.set_tool(tool);
                        this.focus.focus(window, cx);
                        cx.notify();
                    })),
            );
        }
        for (name, label, disabled) in [
            ("undo", "撤销", !self.input.board().has_undo()),
            ("redo", "重做", !self.input.board().has_redo()),
            ("image", "图片…", self.importing),
        ] {
            toolbar = toolbar.child(
                Button::new(SharedString::from(format!("board-{name}")))
                    .small()
                    .label(label)
                    .disabled(disabled)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.command(name, window, cx);
                        this.focus.focus(window, cx);
                    })),
            )
        }
        toolbar = toolbar.child(
            Button::new("board-more")
                .small()
                .label("更多")
                .dropdown_menu(move |menu, _, cx| {
                    let mut menu = menu.action_context(focus.clone());
                    for (name, label) in [
                        ("copy", "复制"),
                        ("cut", "剪切"),
                        ("paste", "粘贴"),
                        ("duplicate", "创建副本"),
                        ("delete", "删除"),
                        ("group", "组合"),
                        ("ungroup", "取消组合"),
                        ("front", "置于顶层"),
                        ("back", "置于底层"),
                        ("forward", "上移一层"),
                        ("backward", "下移一层"),
                        ("align-left", "左对齐"),
                        ("align-center", "水平居中"),
                        ("align-top", "顶端对齐"),
                        ("distribute-x", "水平分布"),
                        ("flip-x", "水平翻转"),
                        ("flip-y", "垂直翻转"),
                        ("lock", "锁定"),
                        ("unlock", "解锁所有图形"),
                        ("solid", "纯色填充"),
                        ("hachure", "排线填充"),
                        ("transparent", "无填充"),
                        ("edit-text", "编辑文字…"),
                        ("zoom-in", "放大"),
                        ("zoom-out", "缩小"),
                        ("reset-view", "重置视图"),
                        ("theme", "切换主题"),
                    ] {
                        let disabled = menu_owner
                            .upgrade()
                            .is_none_or(|owner| !owner.read(cx).enabled(name));
                        menu = menu.menu_with_disabled(
                            label,
                            Box::new(BoardCommand::new(name)),
                            disabled,
                        );
                    }
                    menu
                }),
        );
        let status = if let Some(error) = self.input.error() {
            error.to_owned()
        } else if self.loading {
            "正在加载字体和图片".into()
        } else if let Some(error) = self.assets.errors.first() {
            error.clone()
        } else {
            format!(
                "{} · 已选 {} · {:.0}% · 临时草稿，关闭后丢弃",
                self.input.tool().label(),
                self.input.board().selected_ids().len(),
                self.input.viewport().zoom() * 100.
            )
        };
        div()
            .id("board-view")
            .flex()
            .flex_col()
            .size_full()
            .min_w_0()
            .min_h_0()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(toolbar)
            .child(
                div()
                    .id("board-canvas")
                    .test_support()
                    .role(Role::Canvas)
                    .aria_label("白板画布")
                    .track_focus(&self.focus)
                    .key_context("Whiteboard")
                    .on_action(cx.listener(|this, action: &BoardCommand, window, cx| {
                        this.command(&action.name, window, cx)
                    }))
                    .on_action(cx.listener(
                        |this, _: &gpui_kit::component::input::Undo, window, cx| {
                            this.command("undo", window, cx)
                        },
                    ))
                    .on_action(cx.listener(
                        |this, _: &gpui_kit::component::input::Redo, window, cx| {
                            this.command("redo", window, cx)
                        },
                    ))
                    .on_action(cx.listener(
                        |this, _: &gpui_kit::component::input::Copy, window, cx| {
                            this.command("copy", window, cx)
                        },
                    ))
                    .on_action(cx.listener(
                        |this, _: &gpui_kit::component::input::Paste, window, cx| {
                            this.command("paste", window, cx)
                        },
                    ))
                    .on_action(cx.listener(
                        |this, _: &gpui_kit::component::input::Cut, window, cx| {
                            this.command("cut", window, cx)
                        },
                    ))
                    .on_action(cx.listener(
                        |this, _: &gpui_kit::component::input::SelectAll, window, cx| {
                            this.command("select-all", window, cx)
                        },
                    ))
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .focus_visible(|s| s.border_1().border_color(cx.theme().ring))
                    .on_key_down(cx.listener(Self::key_down))
                    .on_key_up(cx.listener(|this, event: &KeyUpEvent, _, _| {
                        if event.keystroke.key == "space" {
                            this.space = false;
                        }
                    }))
                    .on_mouse_down(MouseButton::Left, cx.listener(Self::pointer_down))
                    .on_mouse_down(MouseButton::Middle, cx.listener(Self::pointer_down))
                    .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _, cx| {
                        if this.input.is_dragging() {
                            this.input
                                .update(this.local(event.position), event.modifiers.shift);
                            cx.notify();
                        }
                    }))
                    .on_mouse_up(MouseButton::Left, cx.listener(Self::pointer_up))
                    .on_mouse_up_out(MouseButton::Left, cx.listener(Self::pointer_up))
                    .on_mouse_up(MouseButton::Middle, cx.listener(Self::pointer_up))
                    .on_mouse_up_out(MouseButton::Middle, cx.listener(Self::pointer_up))
                    .on_scroll(cx.listener(|this, event: &ScrollEvent, window, cx| {
                        if this.input.is_dragging() {
                            return;
                        }
                        let delta = event.delta.pixel_delta(window.rem_size());
                        if event.modifiers.platform || event.modifiers.control {
                            let anchor = this.local(event.position);
                            this.input
                                .viewport_mut()
                                .zoom_at((-f32::from(delta.y) as f64 * 0.01).exp(), anchor);
                        } else {
                            this.input.viewport_mut().pan_by(BoardPoint::new(
                                f32::from(delta.x) as f64,
                                f32::from(delta.y) as f64,
                            ));
                        }
                        cx.stop_propagation();
                        cx.notify();
                    }))
                    .child(canvas),
            )
            .child(
                div()
                    .id("board-status")
                    .test_support()
                    .role(Role::Status)
                    .aria_label(status.clone())
                    .px_2()
                    .py_1()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child(status),
            )
    }
}
