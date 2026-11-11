//! Continuous and source editing share one document session, history and save
//! controller; projection and native input never own a second body.
mod accessibility;
mod boards;
mod builtin;
mod element;
mod images;
mod input;
mod projection;
mod saving;
mod session;
mod state;
mod videos;
pub use saving::{FlushState, flush_all, flush_for_navigation, open_document, open_document_at};
#[cfg(all(test, feature = "ui-tests"))]
mod lifecycle_tests;
pub(crate) use saving::cancel_quit;
mod source_mode;
#[cfg(test)]
mod tests;

use anynote_editor::structure::NodeKind;
use gpui_kit::{
    base::text::editor_host::{
        BlockNode, CodeBlock, FlowPosition, InlineNode, LinkMark, Paragraph, RenderContext,
        TextMark,
    },
    component::{
        ActiveTheme, Disableable, Sizable, WindowExt,
        button::{Button, ButtonVariants},
        checkbox::Checkbox,
        dialog::{DialogAction, DialogClose, DialogFooter},
        input::{
            self as kit_input, Editor as SourceEditor, EditorState, Input, InputEditsEvent,
            InputState,
        },
        menu::{AppMenuBar, DropdownMenu, PopupMenu},
    },
    prelude::FluentBuilder,
    *,
};
use projection::LeafId;
use state::{DocumentSession, Result};
use std::{cell::RefCell, collections::HashMap, rc::Rc};

#[derive(Clone, PartialEq, serde::Deserialize, Action)]
#[action(no_json)]
pub struct RunCommand {
    name: String,
}
impl RunCommand {
    pub fn new(name: impl Into<String>) -> Self {
        Self { name: name.into() }
    }
}

const COMMANDS: &[(&str, &str)] = &[
    ("reading-card", "阅读卡片"),
    ("callout", "提示块"),
    ("details", "折叠块"),
    ("paragraph", "正文"),
    ("h1", "一级标题"),
    ("h2", "二级标题"),
    ("h3", "三级标题"),
    ("h4", "四级标题"),
    ("h5", "五级标题"),
    ("h6", "六级标题"),
    ("bullet", "无序列表"),
    ("ordered", "有序列表"),
    ("task", "任务列表"),
    ("quote", "引用"),
    ("code", "代码块"),
    ("table", "表格"),
    ("rule", "分隔线"),
    ("image", "图片…"),
    ("board", "白板…"),
    ("video", "视频…"),
];

pub fn insert_menu() -> Menu {
    Menu::new("插入").items(
        COMMANDS
            .iter()
            .copied()
            .chain([
                ("bold", "加粗"),
                ("italic", "斜体"),
                ("strike", "删除线"),
                ("link", "链接"),
            ])
            .map(|(id, label)| MenuItem::action(label, RunCommand::new(id))),
    )
}

pub fn install_actions(cx: &mut App) {
    for (mac, other, command) in [
        ("cmd-s", "ctrl-s", "save"),
        ("cmd-b", "ctrl-b", "bold"),
        ("cmd-i", "ctrl-i", "italic"),
        ("cmd-z", "ctrl-z", "undo"),
        ("cmd-shift-z", "ctrl-shift-z", "redo"),
    ] {
        cx.bind_keys([KeyBinding::new(
            if cfg!(target_os = "macos") {
                mac
            } else {
                other
            },
            RunCommand::new(command),
            Some("AnyNoteDocument"),
        )]);
    }
}

/// Continuous and source views share one document, history and save controller.
pub struct DocumentEditor {
    state: DocumentSession,
    focus: FocusHandle,
    layout: ListState,
    table_scroll: HashMap<(anynote_editor::model::BlockId, Vec<usize>), ScrollHandle>,
    code_scroll: HashMap<u64, ScrollHandle>,
    reveal_selection: bool,
    geometry: Rc<RefCell<element::GeometryFrame>>,
    accessible_positions: Rc<RefCell<accessibility::TextMap>>,
    keys: Vec<u64>,
    identities: HashMap<LeafId, u64>,
    next_key: u64,
    view_revision: u64,
    projected_generation: u64,
    composition_rows: Option<std::ops::Range<usize>>,
    last_rem: Pixels,
    last_scale: f32,
    overlay_anchor: Point<Pixels>,
    dragging_selection: bool,
    drag_position: Option<Point<Pixels>>,
    slash: Option<Entity<PopupMenu>>,
    slash_first: Option<String>,
    slash_start: Option<usize>,
    source: Option<Entity<EditorState>>,
    source_subscription: Option<Subscription>,
    search: Entity<InputState>,
    menu: Option<Entity<AppMenuBar>>,
    show_search: bool,
    error: Option<String>,
    save_task: Option<Task<()>>,
    debounce_task: Option<Task<()>>,
    saving: bool,
    flush_requested: bool,
    closing: bool,
    switching: Option<anynote_core::document_session::DocumentSnapshot>,
    lifecycle: Vec<Subscription>,
    source_blur: Option<Subscription>,
    rich_scroll: Option<(ListOffset, u64)>,
    source_scroll: Option<(Point<Pixels>, u64)>,
    images: images::Images,
    pdf: Option<Entity<crate::pdf::PdfView>>,
    board: Option<Entity<crate::board::BoardSession>>,
    videos: videos::Videos,
    board_pending: Option<anynote_editor::model::BlockId>,
    board_subscription: Option<Subscription>,
    builtin_pending: Option<anynote_core::builtin::ReadingCommand>,
    builtin_request: Option<(anynote_core::builtin::ReadingRequest, u64, uuid::Uuid)>,
    builtin_running: bool,
    builtin_task: Option<Task<()>>,
    preferences_task: Option<Task<()>>,
    expanded_blocks: std::collections::HashSet<anynote_editor::model::BlockId>,
    capture_cards: HashMap<anynote_editor::model::BlockId, anynote_editor::capture_card::CardNode>,
}
impl DocumentEditor {
    pub fn new(source: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let state = DocumentSession::new(source);
        let layout = ListState::new(
            state.projection.rows.len(),
            ListAlignment::Top,
            window.rem_size() * 4.,
        );
        let focus = cx.focus_handle().tab_stop(true);
        focus.focus(window, cx);
        let mut this = Self {
            state,
            focus,
            layout,
            table_scroll: HashMap::new(),
            code_scroll: HashMap::new(),
            reveal_selection: false,
            geometry: Default::default(),
            accessible_positions: Default::default(),
            keys: vec![],
            identities: HashMap::new(),
            next_key: 1,
            view_revision: 0,
            projected_generation: 0,
            composition_rows: None,
            last_rem: window.rem_size(),
            last_scale: window.scale_factor(),
            overlay_anchor: point(px(0.), px(0.)),
            dragging_selection: false,
            drag_position: None,
            slash: None,
            slash_first: None,
            slash_start: None,
            source: None,
            source_subscription: None,
            search: cx.new(|cx| InputState::new(window, cx).placeholder("查找正文")),
            menu: (!cfg!(target_os = "macos")).then(|| AppMenuBar::new(cx)),
            show_search: false,
            error: None,
            save_task: None,
            debounce_task: None,
            saving: false,
            flush_requested: false,
            closing: false,
            switching: None,
            lifecycle: vec![],
            source_blur: None,
            rich_scroll: None,
            source_scroll: None,
            images: Default::default(),
            pdf: None,
            board: None,
            videos: Default::default(),
            board_pending: None,
            board_subscription: None,
            builtin_pending: None,
            builtin_request: None,
            builtin_running: false,
            builtin_task: None,
            preferences_task: None,
            expanded_blocks: Default::default(),
            capture_cards: Default::default(),
        };
        this.rekey();
        this.install_lifecycle(window, cx);
        this
    }
    pub fn source(&self) -> &str {
        self.state.editor.document().source()
    }
    pub fn text(&self) -> &str {
        &self.state.projection.text
    }
    pub fn is_composing(&self) -> bool {
        self.state.composition.is_some()
    }
    pub fn undo_steps(&self) -> usize {
        self.state.editor.undo_steps()
    }
    pub fn selection(&self) -> std::ops::Range<usize> {
        self.state.range()
    }

    fn rekey(&mut self) {
        self.capture_cards = self
            .state
            .editor
            .document()
            .blocks()
            .iter()
            .filter_map(|block| {
                anynote_editor::capture_card::parse(&self.source()[block.span()])
                    .map(|card| (block.id(), card))
            })
            .collect();
        let mut identities = HashMap::new();
        self.keys = self
            .state
            .projection
            .leaves
            .iter()
            .map(|leaf| {
                let key = *self.identities.get(&leaf.id).unwrap_or_else(|| {
                    let key = self.next_key;
                    self.next_key += 1;
                    identities.entry(leaf.id.clone()).or_insert(key)
                });
                identities.insert(leaf.id.clone(), key);
                key
            })
            .collect();
        self.identities = identities;
        let code_keys: std::collections::HashSet<_> = self
            .state
            .projection
            .leaves
            .iter()
            .enumerate()
            .filter(|(_, leaf)| matches!(leaf.kind, NodeKind::Code { .. }))
            .map(|(ix, _)| self.keys[ix])
            .collect();
        self.code_scroll.retain(|key, _| code_keys.contains(key));
        for key in code_keys {
            self.code_scroll.entry(key).or_default();
        }
        self.table_scroll.retain(|(block, path), _| {
            self.state.projection.rows.iter().any(|row| {
                row.table
                    .as_ref()
                    .is_some_and(|(id, p, ..)| id == block && p == path)
            })
        });
    }
    fn changed(&mut self, result: Result<()>, window: &mut Window, cx: &mut Context<Self>) {
        self.error = result.err();
        self.view_revision += 1;
        self.accessible_positions.borrow_mut().clear();
        self.reveal_selection = !self.dragging_selection;
        let generation = self.state.editor.document().generation();
        let composition_rows = self.state.composition.as_ref().map(|c| {
            self.state.projection.row_for(c.leaf)..self.state.projection.row_for(c.last_leaf) + 1
        });
        let previous_rows = std::mem::replace(&mut self.composition_rows, composition_rows.clone());
        if generation != self.projected_generation {
            self.stop_video(cx);
        }
        if generation != self.projected_generation
            || self.keys.len() != self.state.projection.leaves.len()
        {
            let scroll = self.layout.logical_scroll_top();
            self.rekey();
            self.layout.reset(self.state.projection.rows.len());
            self.layout.scroll_to(scroll);
            self.projected_generation = generation;
        } else if let Some(rows) = composition_rows.or(previous_rows) {
            self.layout.remeasure_items(rows);
        }
        let (leaf, _) = self.state.display_at(self.state.display_head());
        let row = self.state.projection.row_for(leaf);
        if self.dragging_selection {
            // Edge dragging owns scrolling until release; revealing the active
            // row here would undo the next autoscroll step.
        } else if self.geometry.borrow().leaves.contains_key(&self.keys[leaf]) {
            self.layout.scroll_to_reveal_item(row);
        } else {
            // Unmeasured rows have no reliable pixel height yet. Jump by model
            // index, then use the next prepaint's geometry for precise placement.
            self.layout.scroll_to(ListOffset {
                item_ix: row,
                offset_in_item: px(0.),
            });
        }
        self.geometry.borrow_mut().leaves.clear();
        self.update_slash(window, cx);
        self.schedule_save(window, cx);
        window.notify_text_input_changed(&self.focus);
        window.notify_text_selection_changed(&self.focus);
        cx.notify();
    }
    fn update_slash(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.slash = None;
        self.slash_first = None;
        self.slash_start = None;
        if self.is_composing() || !self.state.range().is_empty() || self.source.is_some() {
            return;
        }
        let (ix, at) = self.state.projection.at(self.state.head);
        let leaf = &self.state.projection.leaves[ix];
        if leaf.kind != NodeKind::Paragraph {
            return;
        }
        let prefix = &leaf.text[..at];
        let Some(slash) = prefix.rfind('/') else {
            return;
        };
        if slash > 0 && !prefix[..slash].ends_with(char::is_whitespace) {
            return;
        }
        let query = &prefix[slash + 1..];
        if query.chars().any(char::is_whitespace) {
            return;
        }
        let matching = COMMANDS
            .iter()
            .filter(|(id, label)| id.contains(query) || label.contains(query))
            .copied()
            .collect::<Vec<_>>();
        self.slash_first = matching.first().map(|(name, _)| (*name).into());
        self.slash_start = Some(leaf.logical.start + slash);
        let focus = self.focus.clone();
        self.slash = Some(PopupMenu::build(window, cx, move |menu, _, _| {
            matching
                .into_iter()
                .fold(menu.action_context(focus.clone()), |menu, (id, label)| {
                    menu.menu(label, Box::new(RunCommand::new(id)))
                })
        }));
    }
    fn source_composing(&self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        self.source.as_ref().is_some_and(|source| {
            source.update(cx, |source, cx| {
                source.marked_text_range(window, cx).is_some()
            })
        })
    }
    fn run(&mut self, action: &RunCommand, window: &mut Window, cx: &mut Context<Self>) {
        if self.board.is_some() {
            return;
        }
        self.stop_video(cx);
        if action.name == "video" {
            self.insert_video(window, cx);
            return;
        }
        if action.name == "board" {
            self.insert_board(window, cx);
            return;
        }
        if self.run_builtin(&action.name, window, cx) {
            return;
        }
        if action.name == "save" {
            self.retry_save(window, cx);
            return;
        }
        if action.name == "image" {
            self.choose_images(window, cx);
            return;
        }
        if self.source.is_some() && !matches!(action.name.as_str(), "undo" | "redo") {
            self.source_format(&action.name, window, cx);
            return;
        }
        if self.source_composing(window, cx) {
            self.error = Some("请先完成当前输入".into());
            cx.notify();
            return;
        }
        if let Some(start) = self.slash_start.take() {
            let end = self.state.head;
            let result = self
                .state
                .select(start, end)
                .and_then(|_| self.state.replace(""));
            if result.is_err() {
                self.changed(result, window, cx);
                return;
            }
        }
        self.slash = None;
        if action.name == "link" {
            self.edit_link(window, cx);
            return;
        }
        let result = if let Some((direction, ix)) = action.name.split_once(':') {
            ix.parse::<usize>()
                .map_err(|_| "无效块位置".into())
                .and_then(|from| {
                    let block = self
                        .state
                        .projection
                        .leaves
                        .get(from)
                        .and_then(|l| l.id.block)
                        .ok_or("没有可移动块")?;
                    let document = self.state.editor.document();
                    let at = document
                        .blocks()
                        .iter()
                        .position(|b| b.id() == block)
                        .ok_or("块已变化")?;
                    let target = if direction == "move-up" {
                        at.checked_sub(1)
                    } else {
                        (at + 1 < document.blocks().len()).then_some(at + 1)
                    }
                    .ok_or("已到文档边界")?;
                    let tx = anynote_editor::structure::move_blocks(
                        document,
                        block,
                        block,
                        document.blocks()[target].id(),
                        if direction == "move-up" {
                            anynote_editor::structure::BlockSide::Before
                        } else {
                            anynote_editor::structure::BlockSide::After
                        },
                        self.state.millis(),
                    )
                    .map_err(state::error)?;
                    self.state.apply(tx)
                })
        } else {
            self.state.command(&action.name)
        };
        self.changed(result, window, cx);
        self.sync_source(window, cx);
        if self.source.is_none() {
            self.focus.focus(window, cx);
        }
    }
    fn edit_link(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.is_composing() || self.state.range().is_empty() {
            self.error = Some("请先选择链接文字".into());
            cx.notify();
            return;
        }
        let url = self
            .state
            .marks
            .link()
            .map_or("https://", |link| link.url())
            .to_owned();
        let input = cx.new(|cx| {
            let mut input = InputState::new(window, cx);
            input.set_value(url, window, cx);
            input
        });
        let owner = cx.weak_entity();
        window.open_dialog(cx, move |dialog, _, _| {
            let input = input.clone();
            let owner = owner.clone();
            dialog
                .title("编辑链接")
                .child(Input::new(&input).aria_label("链接地址"))
                .footer(
                    DialogFooter::new()
                        .child(DialogClose::new().trigger(|b| b.label("取消")))
                        .child(
                            DialogAction::new()
                                .child(Button::new("apply-link").primary().label("应用")),
                        ),
                )
                .on_ok(move |_, window, cx| {
                    let url = input.read(cx).value().to_string();
                    owner
                        .update(cx, |this, cx| {
                            let result = if url.is_empty() {
                                Ok(None)
                            } else {
                                anynote_editor::inline::Link::new(url, None)
                                    .map(Some)
                                    .map_err(state::error)
                            }
                            .and_then(|link| {
                                this.state
                                    .format(anynote_editor::inline::Format::Link(link))
                            });
                            let done = result.is_ok();
                            this.changed(result, window, cx);
                            done
                        })
                        .unwrap_or(true)
                })
        });
    }
    pub fn find_text(&mut self, query: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if query.is_empty() || self.is_composing() {
            return false;
        }
        let text = &self.state.projection.text;
        let next = text[self.state.range().end..]
            .find(query)
            .map(|at| at + self.state.range().end)
            .or_else(|| text.find(query));
        let Some(at) = next else {
            self.error = Some("未找到匹配内容".into());
            cx.notify();
            return false;
        };
        let result = self.state.select(at, at + query.len());
        self.changed(result, window, cx);
        self.slash = None;
        self.focus.focus(window, cx);
        true
    }
    fn copy(&mut self, cut: bool, window: &mut Window, cx: &mut Context<Self>) {
        let range = self.state.range();
        if range.is_empty() || self.is_composing() {
            return;
        }
        let text = self.state.projection.text[range].to_owned();
        let item = if let Some(markdown) = self.state.selected_markdown() {
            ClipboardItem::new_string_with_json_metadata(
                text,
                serde_json::json!({"anynote.markdown":markdown}),
            )
        } else {
            ClipboardItem::new_string(text)
        };
        cx.write_to_clipboard(item);
        if cut {
            let result = self.state.replace("");
            self.changed(result, window, cx);
        }
    }
    fn paste_item(&mut self, item: ClipboardItem, window: &mut Window, cx: &mut Context<Self>) {
        if self.paste_images(&item, window, cx) {
            return;
        }
        let markdown = item
            .metadata()
            .and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok())
            .and_then(|v| {
                v.get("anynote.markdown")
                    .and_then(|s| s.as_str())
                    .map(str::to_owned)
            });
        let text = markdown.as_ref().cloned().or_else(|| item.text());
        if let Some(text) = text {
            let result = self.state.paste(&text, markdown.is_some());
            self.changed(result, window, cx);
        }
    }
    fn render_leaf(&self, ix: usize, window: &mut Window, cx: &mut App) -> AnyElement {
        let leaf = &self.state.projection.leaves[ix];
        let mut paragraph = Paragraph::default();
        let composing = self.state.composing_leaf(ix);
        if composing {
            paragraph.push(InlineNode::new(
                self.state.display_leaf_text(ix).into_owned(),
            ));
        } else if leaf.runs.is_empty() {
            paragraph.push(InlineNode::new(leaf.text.clone()));
        } else {
            for run in &leaf.runs {
                let marks = run.marks();
                let mut mark = TextMark::default();
                if marks.has(anynote_editor::inline::Mark::Strong) {
                    mark = mark.bold();
                }
                if marks.has(anynote_editor::inline::Mark::Emphasis) {
                    mark = mark.italic();
                }
                if marks.has(anynote_editor::inline::Mark::Strike) {
                    mark = mark.strikethrough();
                }
                if marks.has(anynote_editor::inline::Mark::Code) {
                    mark = mark.code();
                }
                if let Some(link) = marks.link() {
                    mark = mark.link(LinkMark {
                        url: link.url().to_owned().into(),
                        identifier: None,
                        title: link.title().map(|t| t.to_owned().into()),
                    });
                }
                paragraph.push(
                    InlineNode::new(run.text().to_owned()).marks(vec![(0..run.text().len(), mark)]),
                );
            }
        }
        let paragraph = paragraph.with_leaf_key(self.keys[ix]);
        let block = match &leaf.kind {
            NodeKind::Heading(level) => BlockNode::Heading {
                level: *level,
                children: paragraph,
                span: None,
            },
            NodeKind::Code { language } if !composing => BlockNode::CodeBlock(
                CodeBlock::from_code(leaf.text.clone(), language.clone())
                    .with_leaf_key(self.keys[ix]),
            ),
            _ => BlockNode::Paragraph(paragraph),
        };
        let render_context = RenderContext::from_app(cx)
            .with_body_font_size(window.rem_size())
            .on_link_click(|url, event, _, cx| {
                let follow = if cfg!(target_os = "macos") {
                    event.modifiers().platform
                } else {
                    event.modifiers().control
                };
                if follow && !saving::open_pdf_link(url, cx) {
                    cx.open_url(url);
                }
            });
        let flow = FlowPosition::at(&[&block], 0, true);
        let content = block.render_with_id(
            ("content", self.keys[ix]),
            flow,
            &render_context,
            window,
            cx,
        );
        let content = if let Some(scroll) = self.code_scroll.get(&self.keys[ix]) {
            div()
                .w_full()
                .min_w_0()
                .relative()
                .child(
                    div()
                        .id(("code-scroll", self.keys[ix]))
                        .test_support()
                        .w_full()
                        .max_h(rems(20.))
                        .overflow_y_scroll()
                        .track_scroll(scroll)
                        .child(content),
                )
                .child(
                    gpui_kit::base::ScrollableMask::new(Axis::Vertical, scroll)
                        .id(("code-mask", self.keys[ix])),
                )
                .child(
                    div()
                        .absolute()
                        .inset_0()
                        .child(gpui_kit::base::Scrollbar::vertical(scroll)),
                )
                .into_any_element()
        } else {
            content
        };
        div()
            .id(("leaf", self.keys[ix]))
            .role(Role::Paragraph)
            .a11y_synthetic_children(|builder| builder.parent_node().set_hidden())
            .test_support()
            .child(content)
            .into_any_element()
    }
    fn render_row(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let row = self.state.projection.rows[ix].clone();
        let first = row.leaves.start;
        let leaf = self.state.projection.leaves[first].clone();
        let key = self.keys[first];
        if self.state.composing_leaf(first) && matches!(leaf.kind, NodeKind::Atom | NodeKind::Rule)
        {
            return div()
                .w_full()
                .px_6()
                .py_2()
                .child(self.render_leaf(first, window, cx))
                .into_any_element();
        }
        if let Some(video) = self.render_video(first, key, window, cx) {
            return video;
        }
        if let Some(board) = self.render_board_block(first, key, window, cx) {
            return board;
        }
        if let Some(image) = self.render_image_block(first, window, cx) {
            return image;
        }
        let owner = cx.entity();
        let mut content = div()
            .id(("row", key))
            .test_support()
            .flex()
            .items_start()
            .gap_2()
            .px_6()
            .py_2()
            .w_full()
            .when(leaf.indent > 0, |div| {
                div.pl(rems(1.5 + leaf.indent as f32))
            })
            .when(leaf.quote, |div| {
                div.border_l_2().border_color(cx.theme().border)
            })
            .on_drop(cx.listener(move |this, drag: &BlockDrag, window, cx| {
                if drag.owner == owner.entity_id()
                    && drag.generation == this.state.editor.document().generation()
                {
                    let result = this.state.move_block(drag.leaf, first);
                    this.changed(result, window, cx);
                }
            }));
        let pending_task = self
            .state
            .pending_task
            .filter(|_| first == self.state.projection.at(self.state.head).0);
        if let Some(checked) = pending_task {
            content = content.child(
                Checkbox::new(("pending-task", key))
                    .checked(checked)
                    .aria_label("完成任务")
                    .on_click(cx.listener(|this, next, _, cx| {
                        this.state.pending_task = Some(*next);
                        cx.notify();
                    })),
            );
        } else if let Some((_, checked)) = leaf.task {
            content = content.child(
                Checkbox::new(("task", key))
                    .checked(checked)
                    .aria_label("完成任务")
                    .on_click(cx.listener(move |this, next, window, cx| {
                        let result = this.state.toggle_task(first, *next);
                        this.changed(result, window, cx);
                    })),
            );
        } else if let Some(marker) = leaf.marker {
            content = content.child(div().text_color(cx.theme().muted_foreground).child(marker));
        }
        if let Some(block) = self.render_builtin(first, key, cx) {
            content = content.child(div().flex_1().min_w_0().child(block));
        } else if let Some((block, path, row_ix, row_count, columns)) = &row.table {
            let scroll = self
                .table_scroll
                .entry((*block, path.clone()))
                .or_default()
                .clone();
            let mut cells = div().flex().items_stretch().w(rems(12. * *columns as f32));
            for leaf_ix in row.leaves {
                cells = cells.child(
                    div()
                        .id(("cell", self.keys[leaf_ix]))
                        .w(rems(12.))
                        .flex_shrink_0()
                        .border_1()
                        .border_color(cx.theme().border)
                        .p_2()
                        .child(self.render_leaf(leaf_ix, window, cx)),
                );
            }
            content = content.child(
                div()
                    .flex_1()
                    .min_w_0()
                    .relative()
                    .child(
                        div()
                            .id(("table-scroll", key))
                            .test_support()
                            .w_full()
                            .overflow_x_scroll()
                            .track_scroll(&scroll)
                            .child(cells),
                    )
                    .child(
                        gpui_kit::base::ScrollableMask::new(Axis::Horizontal, &scroll)
                            .id(("table-mask", key)),
                    )
                    .when(row_ix + 1 == *row_count, |view| {
                        view.child(
                            div()
                                .absolute()
                                .inset_0()
                                .child(gpui_kit::base::Scrollbar::horizontal(&scroll)),
                        )
                    }),
            );
        } else {
            content = content.child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(self.render_leaf(first, window, cx)),
            );
        }
        if matches!(leaf.kind, NodeKind::Atom | NodeKind::Rule) {
            if let Some(block) = leaf.id.block {
                content = content.child(
                    Button::new(("copy-source-block", key))
                        .small()
                        .ghost()
                        .label("复制原文")
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(block) = this.state.editor.document().block(block) {
                                cx.write_to_clipboard(ClipboardItem::new_string(
                                    this.source()[block.span()].to_owned(),
                                ));
                            }
                        })),
                );
                content = content.child(
                    Button::new(("export-source-block", key))
                        .small()
                        .ghost()
                        .label("导出原文…")
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.export_block(block, window, cx)
                        })),
                );
            }
            let label = if leaf.kind == NodeKind::Rule {
                "分隔线"
            } else {
                "原文块"
            };
            content = content.child(
                Button::new(("source-block", key))
                    .small()
                    .ghost()
                    .label(format!("{label}…"))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        let range = this.state.projection.leaves[first].logical.clone();
                        let _ = this.state.select(range.start, range.end);
                        this.toggle_source(window, cx);
                    })),
            );
        }
        let drag = BlockDrag {
            owner: cx.entity_id(),
            generation: self.state.editor.document().generation(),
            leaf: first,
        };
        let focus = self.focus.clone();
        content
            .child(
                div()
                    .id(("drag-handle", key))
                    .test_support()
                    .cursor_grab()
                    .px_2()
                    .py_1()
                    .text_color(cx.theme().muted_foreground)
                    .child("⠿")
                    .on_drag(drag, |drag, _, _, cx| cx.new(|_| drag.clone())),
            )
            .child(
                Button::new(("move", key))
                    .small()
                    .ghost()
                    .label("块操作")
                    .dropdown_menu(move |menu, _, _| {
                        menu.action_context(focus.clone())
                            .menu(
                                "上移",
                                Box::new(RunCommand::new(format!("move-up:{first}"))),
                            )
                            .menu(
                                "下移",
                                Box::new(RunCommand::new(format!("move-down:{first}"))),
                            )
                    }),
            )
            .into_any_element()
    }
    fn render_toolbar(&self, cx: &mut Context<Self>) -> AnyElement {
        let focus = self.focus.clone();
        let mut toolbar = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap_2()
            .px_4()
            .py_2()
            .border_b_1()
            .border_color(cx.theme().border)
            .child(self.reading_menu(cx))
            .child(
                Button::new("insert-content")
                    .small()
                    .label("插入")
                    .disabled(self.is_composing() || self.source.is_some())
                    .dropdown_menu(move |menu, _, _| {
                        COMMANDS
                            .iter()
                            .fold(menu.action_context(focus.clone()), |menu, (id, label)| {
                                menu.menu(*label, Box::new(RunCommand::new(*id)))
                            })
                    }),
            );
        for (id, label) in [
            ("bold", "加粗"),
            ("italic", "斜体"),
            ("strike", "删除线"),
            ("link", "链接…"),
            ("undo", "撤销"),
            ("redo", "重做"),
        ] {
            toolbar = toolbar.child(
                Button::new(id)
                    .small()
                    .ghost()
                    .label(label)
                    .disabled(self.is_composing())
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.run(&RunCommand::new(id), window, cx)
                    })),
            );
        }
        if self.state.projection.leaves[self.state.projection.at(self.state.head).0].kind
            == NodeKind::Cell
        {
            for (id, label) in [
                ("row", "增加表格行"),
                ("column", "增加表格列"),
                ("deleteRow", "删除表格行"),
                ("deleteColumn", "删除表格列"),
            ] {
                toolbar = toolbar.child(Button::new(id).small().ghost().label(label).on_click(
                    cx.listener(move |this, _, w, cx| this.run(&RunCommand::new(id), w, cx)),
                ));
            }
        }
        toolbar
            .child(
                Button::new("find-text")
                    .small()
                    .ghost()
                    .label("查找")
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
                Button::new("source-mode")
                    .small()
                    .ghost()
                    .label(if self.source.is_some() {
                        "返回正文"
                    } else {
                        "原文"
                    })
                    .on_click(cx.listener(|this, _, window, cx| this.toggle_source(window, cx))),
            )
            .into_any_element()
    }
}
impl Focusable for DocumentEditor {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}
impl Render for DocumentEditor {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(video) = self.video_view(cx) {
            return video;
        }
        if let Some(pdf) = &self.pdf {
            return div()
                .id("document-pdf-reader")
                .size_full()
                .child(pdf.clone());
        }
        if let Some(board) = &self.board {
            return div()
                .id("document-board-session")
                .size_full()
                .bg(cx.theme().background)
                .text_color(cx.theme().foreground)
                .child(board.clone());
        }
        self.images.previews.clear();
        if self.last_rem != window.rem_size() || self.last_scale != window.scale_factor() {
            let (leaf, _) = self.state.projection.at(self.state.head);
            let selected_was_visible = self.geometry.borrow().leaves.contains_key(&self.keys[leaf]);
            self.layout.remeasure();
            if selected_was_visible {
                self.layout.scroll_to(ListOffset {
                    item_ix: self.state.projection.row_for(leaf),
                    offset_in_item: px(0.),
                });
            }
            self.geometry.borrow_mut().leaves.clear();
            self.last_rem = window.rem_size();
            self.last_scale = window.scale_factor();
        }
        let entity = cx.entity();
        let source = self.source.clone();
        let content = if let Some(image) = &self.images.active {
            let image = image.clone();
            div()
                .flex()
                .flex_col()
                .flex_1()
                .min_h_0()
                .child(
                    Button::new("close-image-reader")
                        .label("返回正文")
                        .on_click(cx.listener(|this, _, window, cx| this.close_image(window, cx))),
                )
                .child(image)
                .into_any_element()
        } else if let Some(source) = source {
            div()
                .id("source-editor")
                .flex_1()
                .min_h_0()
                .child(
                    SourceEditor::new(&source)
                        .h(relative(1.))
                        .aria_label("Markdown 原文"),
                )
                .into_any_element()
        } else {
            let owner = entity.clone();
            let content = list(self.layout.clone(), move |ix, window, cx| {
                owner.update(cx, |this, cx| this.render_row(ix, window, cx))
            })
            .flex_1()
            .size_full();
            element::EditorElement::new(
                content.into_any_element(),
                entity,
                self.geometry.clone(),
                self.view_revision,
                self.decorations(cx),
            )
            .into_any_element()
        };
        let accessible = (window.is_a11y_active() && self.source.is_none())
            .then(|| accessibility::Snapshot::new(&self.state, &self.keys));
        let accessible_positions = self.accessible_positions.clone();
        div()
            .id("document-editor")
            .key_context("AnyNoteDocument")
            .flex()
            .flex_col()
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .on_action(cx.listener(Self::run))
            .child(self.render_image_status(cx))
            .on_drop(cx.listener(|this, paths: &ExternalPaths, window, cx| {
                this.import_images(
                    paths
                        .0
                        .iter()
                        .cloned()
                        .map(images::ImageInput::File)
                        .collect(),
                    None,
                    window,
                    cx,
                )
            }))
            .on_action(
                cx.listener(|this, _: &crate::shell::CloseWindow, window, cx| {
                    this.request_close(window, cx)
                }),
            )
            .capture_action(cx.listener(|this, _: &kit_input::Undo, window, cx| {
                if this.focus.is_focused(window)
                    || this
                        .source
                        .as_ref()
                        .is_some_and(|s| s.focus_handle(cx).is_focused(window))
                {
                    cx.stop_propagation();
                    this.run(&RunCommand::new("undo"), window, cx);
                } else {
                    cx.propagate();
                }
            }))
            .capture_action(cx.listener(|this, _: &kit_input::Redo, window, cx| {
                if this.focus.is_focused(window)
                    || this
                        .source
                        .as_ref()
                        .is_some_and(|s| s.focus_handle(cx).is_focused(window))
                {
                    cx.stop_propagation();
                    this.run(&RunCommand::new("redo"), window, cx);
                } else {
                    cx.propagate();
                }
            }))
            .when_some(self.menu.clone(), |view, menu| {
                view.child(gpui_kit::div().h_8().flex_shrink_0().child(menu))
            })
            .child(self.render_toolbar(cx))
            .child(self.render_save_status(cx))
            .when(self.show_search, |div| {
                div.child(
                    gpui_kit::div()
                        .flex()
                        .gap_2()
                        .p_2()
                        .child(Input::new(&self.search).aria_label("查找正文"))
                        .child(
                            Button::new("find-next")
                                .label("下一个")
                                .on_click(cx.listener(|this, _, window, cx| {
                                    let query = this.search.read(cx).value().to_string();
                                    this.find_text(&query, window, cx);
                                })),
                        ),
                )
            })
            .child(
                div()
                    .id("document-content")
                    .flex()
                    .flex_col()
                    .role(Role::MultilineTextInput)
                    .aria_label("文档内容")
                    .test_support()
                    .a11y_synthetic_children(move |builder| {
                        if let Some(snapshot) = accessible {
                            let controls = builder.parent_node().children().to_vec();
                            let tree = snapshot.clone().build(|key| builder.synthetic_node_id(key));
                            for (id, node) in tree.nodes {
                                builder.push_child(id, node);
                            }
                            builder.parent_node().set_children(
                                tree.roots.into_iter().chain(controls).collect::<Vec<_>>(),
                            );
                            if let Some(selection) = tree.selection {
                                builder.parent_node().set_text_selection(selection);
                            }
                            *accessible_positions.borrow_mut() = tree.positions;
                        }
                    })
                    .on_a11y_action(AccessibleAction::SetTextSelection, {
                        let owner = cx.entity();
                        move |data, window, cx| {
                            if let Some(accesskit::ActionData::SetTextSelection(selection)) = data {
                                owner.update(cx, |this, cx| {
                                    let positions = this.accessible_positions.borrow();
                                    let range = positions
                                        .position(selection.anchor)
                                        .zip(positions.position(selection.focus));
                                    drop(positions);
                                    if let Some((anchor, head)) = range {
                                        if this.is_composing() {
                                            let text = this.state.display_text();
                                            use anynote_editor::selection::{
                                                TextUnit, offset_from_byte,
                                            };
                                            if let (Ok(start), Ok(end)) = (
                                                offset_from_byte(
                                                    &text,
                                                    anchor.min(head),
                                                    TextUnit::Utf16,
                                                ),
                                                offset_from_byte(
                                                    &text,
                                                    anchor.max(head),
                                                    TextUnit::Utf16,
                                                ),
                                            ) {
                                                this.set_selected_text_range(
                                                    start..end,
                                                    window,
                                                    cx,
                                                );
                                            }
                                        } else {
                                            let result = this.state.select(anchor, head);
                                            this.changed(result, window, cx);
                                        }
                                    }
                                });
                            }
                        }
                    })
                    .track_focus(&self.focus)
                    .key_context("AnyNoteDocument")
                    .flex_1()
                    .min_h_0()
                    .relative()
                    .overflow_hidden()
                    .on_key_down(cx.listener(Self::key_down))
                    .on_mouse_down(MouseButton::Left, cx.listener(Self::mouse_down))
                    .on_mouse_up(
                        MouseButton::Left,
                        cx.listener(|this, _, _, _| this.stop_selection_drag()),
                    )
                    .on_mouse_up_out(
                        MouseButton::Left,
                        cx.listener(|this, _, _, _| this.stop_selection_drag()),
                    )
                    .on_action(cx.listener(|this, _: &kit_input::Copy, window, cx| {
                        if this.source.is_none() {
                            this.copy(false, window, cx);
                        } else {
                            cx.propagate();
                        }
                    }))
                    .on_action(cx.listener(|this, _: &kit_input::Cut, window, cx| {
                        if this.source.is_none() {
                            this.copy(true, window, cx);
                        } else {
                            cx.propagate();
                        }
                    }))
                    .on_action(cx.listener(|this, _: &kit_input::Paste, window, cx| {
                        if this.source.is_none() {
                            if let Some(item) = cx.read_from_clipboard() {
                                this.paste_item(item, window, cx);
                            }
                        } else {
                            cx.propagate();
                        }
                    }))
                    .on_action(cx.listener(|this, _: &kit_input::SelectAll, window, cx| {
                        if this.source.is_none() {
                            let result = this.state.select(0, this.text().len());
                            this.changed(result, window, cx);
                        } else {
                            cx.propagate();
                        }
                    }))
                    .child(content)
                    .when_some(self.slash.clone(), |div, menu| {
                        div.child(
                            deferred(anchored().position(self.overlay_anchor).child(menu))
                                .with_priority(1),
                        )
                    })
                    .when(
                        !self.state.range().is_empty()
                            && self.source.is_none()
                            && self.slash.is_none(),
                        |div| {
                            let mut toolbar = gpui_kit::div()
                                .flex()
                                .gap_1()
                                .p_1()
                                .border_1()
                                .border_color(cx.theme().border)
                                .bg(cx.theme().popover)
                                .rounded(cx.theme().radius);
                            for (id, label) in
                                [("bold", "加粗"), ("italic", "斜体"), ("link", "链接…")]
                            {
                                toolbar = toolbar.child(
                                    Button::new(SharedString::from(format!("selection-{id}")))
                                        .small()
                                        .ghost()
                                        .label(label)
                                        .on_click(cx.listener(move |this, _, w, cx| {
                                            this.run(&RunCommand::new(id), w, cx)
                                        })),
                                );
                            }
                            div.child(
                                deferred(anchored().position(self.overlay_anchor).child(toolbar))
                                    .with_priority(1),
                            )
                        },
                    ),
            )
            .when_some(self.error.clone(), |div, error| {
                div.child(
                    gpui_kit::div()
                        .id("editor-error")
                        .role(Role::Status)
                        .aria_label(error.clone())
                        .text_color(cx.theme().danger)
                        .px_4()
                        .py_2()
                        .child(error),
                )
            })
    }
}
#[derive(Clone)]
struct BlockDrag {
    owner: EntityId,
    generation: u64,
    leaf: usize,
}
impl Render for BlockDrag {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div().p_2().bg(cx.theme().popover).child("移动块")
    }
}
