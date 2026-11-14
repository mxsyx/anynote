//! Native workspace. The view owns navigation; services own all notebook changes.
mod commands;
mod navigation;
mod reading;
mod render;
mod theme;
use crate::{
    backend_client::{BackendClient, Response},
    backend_session::BackendSession,
};
use anynote_core::{
    backend::{Command, ErrorCode, Reply, ServiceError, ServiceResult},
    document_session::{DocumentId, DocumentSnapshot},
    workspace::*,
};
use gpui_kit::{
    component::{
        ActiveTheme, Disableable, Selectable, Sizable, Theme, ThemeMode, WindowExt,
        button::{Button, ButtonVariants},
        dialog::{DialogAction, DialogClose, DialogFooter},
        input::{Input, InputEvent, InputState},
        menu::AppMenuBar,
        scroll::ScrollableElement,
        tab::{Tab, TabBar},
        text::{TextView, TextViewState},
        tree::{TreeItem, TreeState},
    },
    prelude::FluentBuilder,
    *,
};
use navigation::Navigation;
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};
use uuid::Uuid;

actions!(
    workspace,
    [
        NewBook,
        NewNote,
        NewFolder,
        SearchNotes,
        OpenBook,
        GoBack,
        GoForward,
        CloseTab,
        Settings,
        ImportFiles,
        Refresh,
        TreeFirst,
        TreeLast,
        OpenSelected
    ]
);

#[derive(Clone)]
struct WorkspaceWindow(AnyWindowHandle, WeakEntity<Workspace>);
impl Global for WorkspaceWindow {}
pub(crate) fn activate(cx: &mut App) -> bool {
    let Some(WorkspaceWindow(window, view)) = cx.try_global::<WorkspaceWindow>().cloned() else {
        return false;
    };
    if view.upgrade().is_none() {
        return false;
    }
    window
        .update(cx, |_, window, cx| {
            window.activate_window();
            cx.activate(true);
        })
        .is_ok()
}
fn in_workspace(
    cx: &mut App,
    action: impl FnOnce(&mut Workspace, &mut Window, &mut Context<Workspace>),
) {
    let Some(WorkspaceWindow(window, view)) = cx.try_global::<WorkspaceWindow>().cloned() else {
        return;
    };
    let _ = window.update(cx, |_, window, cx| {
        window.activate_window();
        let _ = view.update(cx, |view, cx| action(view, window, cx));
    });
}
pub fn install_actions(cx: &mut App) {
    cx.on_action(|_: &NewBook, cx| in_workspace(cx, |this, w, cx| this.name_dialog("book", w, cx)));
    cx.on_action(|_: &NewNote, cx| in_workspace(cx, |this, w, cx| this.name_dialog("note", w, cx)));
    cx.on_action(|_: &NewFolder, cx| {
        in_workspace(cx, |this, w, cx| this.name_dialog("folder", w, cx))
    });
    cx.on_action(|_: &OpenBook, cx| in_workspace(cx, |this, w, cx| this.pick(true, w, cx)));
    cx.on_action(|_: &Settings, cx| in_workspace(cx, |this, w, cx| this.settings(w, cx)));
    cx.on_action(|_: &GoBack, cx| {
        in_workspace(cx, |this, w, cx| {
            if let Some(id) = this.navigation.back() {
                this.open_note(id, false, None, w, cx);
            }
        })
    });
    cx.on_action(|_: &GoForward, cx| {
        in_workspace(cx, |this, w, cx| {
            if let Some(id) = this.navigation.forward() {
                this.open_note(id, false, None, w, cx);
            }
        })
    });
    cx.on_action(|_: &CloseTab, cx| in_workspace(cx, |this, w, cx| this.close_tab(w, cx)));
    cx.on_action(|_: &Refresh, cx| in_workspace(cx, |this, w, cx| this.refresh(w, cx)));
    cx.on_action(|_: &ImportFiles, cx| in_workspace(cx, |this, w, cx| this.pick(false, w, cx)));
    cx.on_action(|_: &SearchNotes, cx| {
        in_workspace(cx, |this, w, cx| {
            this.show_search = true;
            this.query.update(cx, |q, cx| q.focus(w, cx));
            this.search(w, cx);
        })
    });

    fn key(mac: &'static str, other: &'static str) -> &'static str {
        if cfg!(target_os = "macos") {
            mac
        } else {
            other
        }
    }
    cx.bind_keys([
        KeyBinding::new(key("cmd-n", "ctrl-n"), NewNote, None),
        KeyBinding::new(
            key("cmd-o", "ctrl-o"),
            ImportFiles,
            Some("AnyNoteWorkspace"),
        ),
        KeyBinding::new(key("cmd-k", "ctrl-k"), SearchNotes, None),
        KeyBinding::new(key("cmd-p", "ctrl-p"), SearchNotes, None),
        KeyBinding::new(key("cmd-,", "ctrl-,"), Settings, None),
        KeyBinding::new(key("cmd-[", "alt-left"), GoBack, None),
        KeyBinding::new(key("cmd-]", "alt-right"), GoForward, None),
        KeyBinding::new(key("cmd-shift-o", "ctrl-shift-o"), ImportFiles, None),
        KeyBinding::new(key("cmd-r", "ctrl-r"), Refresh, None),
    ]);
    cx.bind_keys([
        KeyBinding::new("home", TreeFirst, Some("Tree")),
        KeyBinding::new("end", TreeLast, Some("Tree")),
        KeyBinding::new("enter", OpenSelected, Some("Tree")),
    ]);
}
pub fn menu() -> Menu {
    Menu::new("工作区").items([
        MenuItem::action("新建笔记本…", NewBook),
        MenuItem::action("打开笔记本…", OpenBook),
        MenuItem::action("新建笔记…", NewNote),
        MenuItem::action("新建目录…", NewFolder),
        MenuItem::action("导入文件…", ImportFiles),
        MenuItem::separator(),
        MenuItem::action("搜索", SearchNotes),
        MenuItem::action("后退", GoBack),
        MenuItem::action("前进", GoForward),
        MenuItem::action("关闭标签页", CloseTab),
        MenuItem::action("设置…", Settings),
    ])
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Collection {
    Tree,
    Recent,
    Favorites,
    Tags,
    Trash,
}
#[derive(Clone)]
struct DragNode(Entry);
impl Render for DragNode {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .p_2()
            .bg(cx.theme().popover)
            .text_color(cx.theme().popover_foreground)
            .child(self.0.title.clone())
    }
}
pub struct Workspace {
    focus: FocusHandle,
    notebook_focus: FocusHandle,
    menu: Entity<AppMenuBar>,
    books: Vec<Book>,
    book: Option<Uuid>,
    nodes: Vec<Entry>,
    tree: Entity<TreeState>,
    expanded: HashSet<String>,
    collection: Collection,
    tag: Option<String>,
    navigation: Navigation,
    snapshot: Option<DocumentSnapshot>,
    reader: Entity<TextViewState>,
    pending_anchor: Option<String>,
    pending_position: Option<ReadingPosition>,
    reading_extensions: gpui_kit::component::text::MarkdownExtensions,
    history: Vec<HistoryEntry>,
    history_next: Option<usize>,
    revision: Option<Uuid>,
    backlinks: Vec<Entry>,
    query: Entity<InputState>,
    search_tag: Entity<InputState>,
    search_days: Option<u32>,
    search_kind: Option<String>,
    search_all: bool,
    show_search: bool,
    sidebar_visible: bool,
    hits: Vec<Hit>,
    search_token: Option<Uuid>,
    search_cursor: Option<SearchCursor>,
    search_task: Option<Task<()>>,
    generation: u64,
    busy: bool,
    status: String,
    preferences: Preferences,
    preferences_loaded: bool,
    subscriptions: Vec<Subscription>,
    operation: Option<WorkspaceCommand>,
}
async fn request(client: &BackendClient, command: Command) -> ServiceResult<Reply> {
    match client
        .submit(command, Duration::from_secs(30))?
        .receive()
        .await?
    {
        Response::Reply(reply) => Ok(reply),
        _ => Err(ServiceError::new(ErrorCode::InvalidRequest)),
    }
}
async fn call(client: &BackendClient, command: WorkspaceCommand) -> ServiceResult<WorkspaceReply> {
    match request(client, Command::Workspace(command)).await? {
        Reply::Workspace(reply) => Ok(reply),
        _ => Err(ServiceError::new(ErrorCode::InvalidRequest)),
    }
}
impl Workspace {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.set_global(WorkspaceWindow(window.window_handle(), cx.weak_entity()));
        let query = cx.new(|cx| InputState::new(window, cx).placeholder("搜索所有笔记"));
        let tree = cx.new(|cx| TreeState::new(cx));
        let focus = cx.focus_handle().tab_stop(true);
        focus.focus(window, cx);
        let mut this = Self {
            focus,
            notebook_focus: cx.focus_handle().tab_stop(true),
            menu: AppMenuBar::new(cx),
            books: vec![],
            book: None,
            nodes: vec![],
            tree: tree.clone(),
            expanded: HashSet::new(),
            collection: Collection::Tree,
            tag: None,
            navigation: Default::default(),
            snapshot: None,
            reading_extensions: reading::extensions(cx.weak_entity()),
            reader: cx.new(|cx| TextViewState::markdown("", cx)),
            pending_anchor: None,
            pending_position: None,
            history: vec![],
            history_next: None,
            revision: None,
            backlinks: vec![],
            query: query.clone(),
            search_tag: cx.new(|cx| InputState::new(window, cx).placeholder("标签")),
            search_days: None,
            search_kind: None,
            search_all: true,
            show_search: false,
            sidebar_visible: true,
            hits: vec![],
            search_token: None,
            search_cursor: None,
            search_task: None,
            generation: 0,
            busy: false,
            status: String::new(),
            preferences: Default::default(),
            preferences_loaded: false,
            subscriptions: vec![],
            operation: None,
        };
        this.subscriptions.push(
            cx.subscribe_in(&query, window, |this, _, event, window, cx| {
                if matches!(event, InputEvent::Change) {
                    this.search(window, cx);
                }
            }),
        );
        this.subscriptions
            .push(cx.observe(&tree, |_, _, cx| cx.notify()));
        let reader = this.reader.clone();
        this.subscriptions
            .push(cx.observe(&reader, |this, _, cx| this.restore_reading_target(cx)));
        this.subscriptions
            .push(cx.subscribe(&tree, |this, _, event, _| {
                use gpui_kit::component::tree::TreeEvent;
                match event {
                    TreeEvent::Expanded(id) => {
                        this.expanded.insert(id.to_string());
                    }
                    TreeEvent::Collapsed(id) => {
                        this.expanded.remove(id.as_ref());
                    }
                }
            }));
        this.subscriptions
            .push(cx.observe_window_appearance(window, |this, window, cx| {
                if this.preferences.theme == "system" {
                    Theme::sync_system_appearance(Some(window), cx);
                    theme::paper(cx);
                }
            }));
        this.subscriptions
            .push(cx.observe_window_activation(window, |this, window, cx| {
                if window.is_window_active() && !this.busy {
                    this.refresh(window, cx);
                }
            }));
        let weak = cx.weak_entity();
        window.on_window_should_close(cx, move |window, cx| {
            let _ = weak.update(cx, |this, cx| this.remember_position(window, cx));
            true
        });
        this.refresh(window, cx);
        this
    }
    fn client(&self, cx: &App) -> Option<BackendClient> {
        cx.try_global::<BackendSession>()
            .filter(|s| !s.is_quitting())
            .map(|s| s.client().clone())
    }
    fn refresh(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let Some(client) = self.client(cx) else {
            self.status = "后端不可用".into();
            return;
        };
        if !client.is_connected() {
            if !BackendSession::begin_reconnect(cx) {
                return;
            }
            self.busy = true;
            self.status = "正在重新连接…".into();
            cx.notify();
            cx.spawn_in(window, async move |this, cx| {
                let result = client.reconnect().recv().await;
                let _ = this.update_in(cx, |this, window, cx| {
                    this.busy = false;
                    match result {
                        Ok(Ok(client)) => {
                            BackendSession::end_reconnect(Some(client), cx);
                            this.refresh(window, cx);
                        }
                        _ => {
                            BackendSession::end_reconnect(None, cx);
                            this.status = "重新连接失败，请重试".into();
                            cx.notify();
                        }
                    }
                });
            })
            .detach();
            return;
        }
        self.busy = true;
        self.status = "正在加载…".into();
        let generation = self.generation;
        let book = self.book;
        let load_preferences = !self.preferences_loaded;
        let preferences = self.preferences.clone();
        let trash = self.collection == Collection::Trash;
        cx.spawn_in(window, async move |this, cx| {
            let result = async {
                let preferences = if load_preferences {
                    match call(&client, WorkspaceCommand::Preferences).await? {
                        WorkspaceReply::Preferences(prefs) => prefs,
                        _ => return Err(ServiceError::new(ErrorCode::InvalidRequest)),
                    }
                } else {
                    preferences
                };
                let WorkspaceReply::Books(books) = call(&client, WorkspaceCommand::Books).await?
                else {
                    return Err(ServiceError::new(ErrorCode::InvalidRequest));
                };
                let selected = preferred_book(&books, book, &preferences);
                let trash = trash && selected == book;
                let mut entries = Vec::new();
                if let Some(book) = selected {
                    let mut offset = 0;
                    loop {
                        match call(
                            &client,
                            WorkspaceCommand::Nodes {
                                book,
                                trash,
                                offset,
                            },
                        )
                        .await?
                        {
                            WorkspaceReply::Nodes {
                                entries: page,
                                next,
                            } => {
                                entries.extend(page);
                                if let Some(next) = next {
                                    offset = next;
                                } else {
                                    break;
                                }
                            }
                            _ => return Err(ServiceError::new(ErrorCode::InvalidRequest)),
                        }
                    }
                }
                Ok((books, entries, selected, preferences))
            }
            .await;
            let _ = this.update_in(cx, |this, window, cx| {
                if this.generation != generation {
                    return;
                }
                this.busy = false;
                match result {
                    Ok((books, nodes, selected, preferences)) => {
                        if load_preferences {
                            this.preferences = preferences;
                            this.preferences_loaded = true;
                            this.apply_theme(window, cx);
                        }
                        if this.book != selected {
                            this.reset_book(selected, cx);
                        }
                        this.books = books;
                        this.nodes = nodes;
                        this.status.clear();
                        this.rebuild_tree(cx);
                        if this.preferences.active_book != selected {
                            this.preferences.active_book = selected;
                            this.persist_preferences(window, cx);
                        }
                    }
                    Err(error) => this.status = format!("无法加载，请重试：{}", error_text(&error)),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn visible_nodes(&self) -> impl Iterator<Item = &Entry> {
        self.nodes.iter().filter(|node| match self.collection {
            Collection::Favorites => node.favorite,
            Collection::Tags => self.tag.as_ref().is_none_or(|tag| node.tags.contains(tag)),
            Collection::Recent => self.preferences.recent.contains(&node.id),
            _ => true,
        })
    }
    fn rebuild_tree(&mut self, cx: &mut Context<Self>) {
        let selected = self
            .tree
            .read(cx)
            .selected_item()
            .map(|item| item.id.clone())
            .or_else(|| {
                self.snapshot
                    .as_ref()
                    .map(|s| SharedString::from(s.id().note().to_string()))
            });
        let visible = self.visible_nodes().collect::<Vec<_>>();
        let items = if self.collection == Collection::Tree {
            fn branch(
                parent: Option<Uuid>,
                children: &HashMap<Option<Uuid>, Vec<&Entry>>,
                expanded: &HashSet<String>,
                seen: &mut HashSet<Uuid>,
            ) -> Vec<TreeItem> {
                children
                    .get(&parent)
                    .into_iter()
                    .flatten()
                    .filter_map(|n| {
                        if !seen.insert(n.id.note()) {
                            return None;
                        }
                        Some(
                            TreeItem::new(n.id.note().to_string(), n.title.clone())
                                .children(branch(Some(n.id.note()), children, expanded, seen))
                                .expanded(expanded.contains(&n.id.note().to_string())),
                        )
                    })
                    .collect()
            }
            let mut children: HashMap<Option<Uuid>, Vec<&Entry>> = HashMap::new();
            for n in visible {
                children.entry(n.parent).or_default().push(n);
            }
            branch(None, &children, &self.expanded, &mut HashSet::new())
        } else {
            let mut visible = visible;
            visible.sort_by_key(|n| std::cmp::Reverse(n.updated));
            visible
                .into_iter()
                .map(|n| TreeItem::new(n.id.note().to_string(), n.title.clone()))
                .collect()
        };
        self.tree.update(cx, |tree, cx| {
            tree.set_items(items, cx);
            if let Some(id) = selected {
                tree.reveal_item(&id, ScrollStrategy::Center, cx);
                if let Some(ix) = tree.index_of(&id) {
                    tree.set_selected_index(Some(ix), cx);
                }
            }
        });
    }
    fn selected(&self, cx: &App) -> Option<Entry> {
        let id = &self.tree.read(cx).selected_item()?.id;
        self.nodes
            .iter()
            .find(|n| n.id.note().to_string() == id.as_ref())
            .cloned()
    }
    fn set_collection(
        &mut self,
        collection: Collection,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.busy {
            return;
        }
        self.collection = collection;
        self.refresh(window, cx);
    }
    fn remember_position(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(snapshot) = &self.snapshot {
            let position = self.reader.read(cx).list_state().logical_scroll_top();
            self.preferences
                .positions
                .retain(|p| p.id.as_ref() != Some(snapshot.id()));
            let mut saved = ReadingPosition::default();
            saved.id = Some(snapshot.id().clone());
            saved.block = position.item_ix;
            saved.offset = f32::from(position.offset_in_item).max(0.);
            self.preferences.positions.insert(0, saved);
            self.preferences.positions.truncate(100);
            self.persist_preferences(window, cx);
        }
    }
    fn persist_preferences(&self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(client) = self.client(cx) {
            let prefs = self.preferences.clone();
            cx.spawn_in(window, async move |this, cx| {
                if let Err(error) = call(&client, WorkspaceCommand::SetPreferences(prefs)).await {
                    let _ = this.update(cx, |this, cx| {
                        this.status = format!("无法保存阅读偏好：{}", error_text(&error));
                        cx.notify();
                    });
                }
            })
            .detach();
        }
    }
    fn apply_theme(&self, window: &mut Window, cx: &mut Context<Self>) {
        match self.preferences.theme.as_str() {
            "dark" => Theme::change(ThemeMode::Dark, Some(window), cx),
            "light" => Theme::change(ThemeMode::Light, Some(window), cx),
            _ => Theme::sync_system_appearance(Some(window), cx),
        }
        theme::paper(cx);
        // Base font anchors the rem scale; content and virtualized rows follow it.
        Theme::update(cx, |theme| theme.font_size = px(self.preferences.font_size));
        cx.notify();
    }
}

fn preferred_book(
    books: &[Book],
    current: Option<Uuid>,
    preferences: &Preferences,
) -> Option<Uuid> {
    current
        .into_iter()
        .chain(preferences.active_book)
        .chain(preferences.recent.iter().map(DocumentId::notebook))
        .chain(books.iter().map(|book| book.id))
        .find(|id| books.iter().any(|book| book.id == *id && !book.unavailable))
}

fn error_text(error: &ServiceError) -> &'static str {
    match error.code() {
        ErrorCode::Conflict => "笔记已更改，请刷新后重试",
        ErrorCode::Busy => "笔记本正被占用，请稍后重试",
        ErrorCode::NotFound => "笔记或目录不存在，请刷新",
        ErrorCode::Disconnected | ErrorCode::StaleSession => "后端连接已中断，请重新连接",
        ErrorCode::InvalidRequest => "参数无效，请检查名称、目标目录或输入内容",
        ErrorCode::Timeout => "响应超时，请刷新检查结果",
        ErrorCode::Cancelled => "操作已取消",
        _ => "无法访问笔记本，请检查目录和权限后重试",
    }
}

#[cfg(all(test, feature = "ui-tests"))]
mod tests;
