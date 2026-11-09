use crate::probe::Probe;
use gpui_kit::{
    App, AppContext, Bounds, Context, Entity, FocusHandle, InteractiveElement, IntoElement,
    KeyBinding, Menu, MenuItem, ParentElement, Render, SharedString, StatefulInteractiveElement,
    Styled, Subscription, Task, TestSupportExt, TitlebarOptions, Window, WindowBounds,
    WindowOptions, actions,
    component::{
        ActiveTheme, Theme, ThemeMode, WindowExt,
        button::{Button, ButtonVariants},
        dialog::{DialogAction, DialogClose, DialogFooter},
        input::{self, Input, InputEvent, InputState},
        menu::AppMenuBar,
        scroll::ScrollableElement,
    },
    div,
    prelude::FluentBuilder,
    px, size,
};

actions!(
    anynote,
    [
        Quit,
        CloseWindow,
        ChooseFile,
        EditText,
        ToggleTheme,
        FollowSystemTheme,
        ZoomIn,
        ZoomOut,
        ResetZoom,
        OpenDocumentEditor,
        OpenLastDocument
    ]
);

pub fn install_actions(cx: &mut App) {
    crate::document_editor::install_actions(cx);
    fn key(mac: &'static str, other: &'static str) -> &'static str {
        if cfg!(target_os = "macos") {
            mac
        } else {
            other
        }
    }
    cx.bind_keys([
        KeyBinding::new(key("cmd-q", "ctrl-q"), Quit, None),
        KeyBinding::new(key("cmd-w", "ctrl-w"), CloseWindow, None),
        KeyBinding::new(key("cmd-o", "ctrl-o"), ChooseFile, Some("AnyNote")),
        KeyBinding::new(
            key("cmd-shift-e", "ctrl-shift-e"),
            EditText,
            Some("AnyNote"),
        ),
        KeyBinding::new(
            key("cmd-shift-t", "ctrl-shift-t"),
            ToggleTheme,
            Some("AnyNote"),
        ),
        KeyBinding::new(key("cmd-=", "ctrl-="), ZoomIn, Some("AnyNote")),
        KeyBinding::new(key("cmd--", "ctrl--"), ZoomOut, Some("AnyNote")),
        KeyBinding::new(key("cmd-0", "ctrl-0"), ResetZoom, Some("AnyNote")),
    ]);
    let menus = vec![
        Menu::new("Anynote").items([
            MenuItem::action("新建笔记…", OpenDocumentEditor),
            MenuItem::action("继续编辑…", OpenLastDocument),
            MenuItem::action("选择文件…", ChooseFile),
            MenuItem::action("编辑测试文本…", EditText),
            MenuItem::separator(),
            MenuItem::action("关闭窗口", CloseWindow),
            MenuItem::action("退出 Anynote", Quit),
        ]),
        Menu::new("编辑").items([
            MenuItem::action("撤销", input::Undo),
            MenuItem::action("重做", input::Redo),
            MenuItem::separator(),
            MenuItem::action("剪切", input::Cut),
            MenuItem::action("复制", input::Copy),
            MenuItem::action("粘贴", input::Paste),
            MenuItem::action("全选", input::SelectAll),
        ]),
        crate::document_editor::insert_menu(),
        Menu::new("显示").items([
            MenuItem::action("切换深色 / 浅色", ToggleTheme),
            MenuItem::action("跟随系统主题", FollowSystemTheme),
            MenuItem::separator(),
            MenuItem::action("放大", ZoomIn),
            MenuItem::action("缩小", ZoomOut),
            MenuItem::action("实际大小", ResetZoom),
        ]),
    ];
    if cfg!(target_os = "macos") {
        cx.set_menus(menus);
    } else {
        gpui_kit::base::GlobalState::global_mut(cx)
            .set_app_menus(menus.into_iter().map(Menu::owned).collect());
    }
    cx.on_action(|_: &Quit, cx| crate::backend_session::request_quit(cx));
}

pub fn open_or_activate(cx: &mut App, probe: Probe) -> gpui_kit::Result<()> {
    if let Some(window) = cx.windows().first() {
        window.update(cx, |_, window, cx| {
            window.activate_window();
            cx.activate(true);
        })?;
        probe.record("activated", true);
        return Ok(());
    }
    // These are physical platform window constraints; content uses the rem scale.
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            size(px(800.), px(560.)),
            cx,
        ))),
        window_min_size: Some(size(px(560.), px(420.))),
        titlebar: Some(TitlebarOptions {
            title: Some("Anynote · 平台检查".into()),
            ..Default::default()
        }),
        app_id: Some("app.anynote.desktop".into()),
        ..Default::default()
    };
    gpui_kit::open_window(options, cx, move |window, cx| {
        cx.new(|cx| Shell::new(window, cx, probe))
    })?;
    cx.activate(true);
    Ok(())
}

pub struct Shell {
    input: Entity<InputState>,
    migration: Entity<crate::migration::MigrationView>,
    focus: FocusHandle,
    menu: Entity<AppMenuBar>,
    selected: SharedString,
    picking: bool,
    follow_system: bool,
    probe: Probe,
    _subscriptions: Vec<Subscription>,
    picker_task: Option<Task<()>>,
}

impl Shell {
    pub fn new(window: &mut Window, cx: &mut Context<Self>, probe: Probe) -> Self {
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("中文、英文与 emoji"));
        input.update(cx, |input, cx| input.focus(window, cx));
        let subscription = cx.subscribe_in(&input, window, |this, input, event, _, cx| {
            if matches!(event, InputEvent::Change) {
                this.probe.record("input", input.read(cx).value().as_ref());
            }
        });
        let appearance = cx.observe_window_appearance(window, |this, window, cx| {
            if this.follow_system {
                Theme::sync_system_appearance(Some(window), cx);
            }
        });
        let frame_probe = probe.clone();
        window.on_next_frame(move |window, _| {
            frame_probe.record("window", serde_json::json!({"scale_factor": window.scale_factor(), "rem": f32::from(window.rem_size())}));
        });
        Self {
            input,
            migration: cx.new(|_| crate::migration::MigrationView::new()),
            focus: cx.focus_handle(),
            menu: AppMenuBar::new(cx),
            selected: "尚未选择文件".into(),
            picking: false,
            follow_system: true,
            probe,
            _subscriptions: vec![subscription, appearance],
            picker_task: None,
        }
    }

    fn open_document(&mut self, last: bool, window: &mut Window, cx: &mut Context<Self>) {
        use crate::{backend_client::Response, backend_session::BackendSession};
        use anynote_core::backend::{Command, Reply};
        let Some(session) = cx.try_global::<BackendSession>() else {
            return;
        };
        if session.is_quitting() {
            return;
        }
        let client = session.client().clone();
        cx.spawn_in(window, async move |this, cx| {
            let result = match client.submit(
                if last {
                    Command::OpenLastDocument
                } else {
                    Command::CreateDocument
                },
                std::time::Duration::from_secs(15),
            ) {
                Ok(request) => request.receive().await,
                Err(error) => Err(error),
            };
            let _ = this.update(cx, |this, cx| {
                if let Ok(Response::Reply(Reply::Document(snapshot))) = result {
                    if cx.global::<BackendSession>().is_quitting() {
                        return;
                    }
                    if let Err(error) = crate::document_editor::open_document(snapshot, cx) {
                        this.selected = format!("无法打开笔记：{error}").into();
                    }
                } else {
                    this.selected = "无法打开笔记；可先新建笔记，或稍后重试".into();
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn choose_file(&mut self, _: &ChooseFile, window: &mut Window, cx: &mut Context<Self>) {
        if self.picking {
            return;
        }
        self.picking = true;
        cx.notify();
        let selection = cx.prompt_for_paths(gpui_kit::PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("选择文件".into()),
        });
        self.picker_task = Some(cx.spawn_in(window, async move |this, cx| {
            let result = selection.await;
            let _ = this.update(cx, |this, cx| {
                this.picking = false;
                this.selected = match result {
                    Ok(Ok(Some(paths))) => paths.first().map_or_else(
                        || "已取消选择".into(),
                        |path| path.display().to_string().into(),
                    ),
                    Ok(Ok(None)) => "已取消选择".into(),
                    Ok(Err(error)) => format!("无法打开文件选择器：{error}").into(),
                    Err(_) => "文件选择器已关闭，请重试".into(),
                };
                this.probe.record("file_selection", this.selected.as_ref());
                cx.notify();
            });
        }));
    }

    fn edit_text(&mut self, _: &EditText, window: &mut Window, cx: &mut Context<Self>) {
        let value = self.input.read(cx).value();
        let draft = cx.new(|cx| {
            let mut state = InputState::new(window, cx);
            state.set_value(value, window, cx);
            state
        });
        let owner = cx.weak_entity();
        let closed_probe = self.probe.clone();
        self.probe.record("dialog_open", true);
        window.open_dialog(cx, move |dialog, _, _| {
            let draft = draft.clone();
            let owner = owner.clone();
            dialog
                .title("编辑测试文本")
                .child(
                    Input::new(&draft)
                        .id("draft-text")
                        .aria_label("测试文本草稿"),
                )
                .footer(
                    DialogFooter::new()
                        .child(DialogClose::new().trigger(|button| button.label("取消")))
                        .child(
                            DialogAction::new()
                                .child(Button::new("apply-draft").primary().label("应用")),
                        ),
                )
                .on_ok(move |_, window, cx| {
                    let value = draft.read(cx).value();
                    let _ = owner.update(cx, |this, cx| {
                        this.input
                            .update(cx, |input, cx| input.set_value(value.clone(), window, cx));
                        this.probe.record("dialog_apply", value.as_ref());
                        cx.notify();
                    });
                    true
                })
                .on_close({
                    let probe = closed_probe.clone();
                    move |_, _, _| probe.record("dialog_close", true)
                })
        });
    }

    fn toggle_theme(&mut self, _: &ToggleTheme, window: &mut Window, cx: &mut Context<Self>) {
        self.follow_system = false;
        let mode = if cx.theme().mode.is_dark() {
            ThemeMode::Light
        } else {
            ThemeMode::Dark
        };
        Theme::change(mode, Some(window), cx);
        self.probe.record("theme_dark", cx.theme().mode.is_dark());
    }

    fn zoom(&mut self, delta: f32, cx: &mut Context<Self>) {
        Theme::update(cx, |theme| {
            theme.font_size = px((f32::from(theme.font_size) + delta).clamp(12., 24.))
        });
        self.probe.record("zoom", f32::from(cx.theme().font_size));
    }
}

impl Render for Shell {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        use gpui_kit::component::Disableable;
        div()
            .id("platform-shell")
            .key_context("AnyNote")
            .track_focus(&self.focus)
            .on_action(cx.listener(Self::choose_file))
            .on_action(cx.listener(Self::edit_text))
            .on_action(cx.listener(|this, _: &OpenDocumentEditor, window, cx| {
                this.open_document(false, window, cx)
            }))
            .on_action(cx.listener(|this, _: &OpenLastDocument, window, cx| {
                this.open_document(true, window, cx)
            }))
            .on_action(cx.listener(Self::toggle_theme))
            .on_action(|_: &CloseWindow, window, _| window.remove_window())
            .on_action(cx.listener(|this, _: &FollowSystemTheme, window, cx| {
                this.follow_system = true;
                Theme::sync_system_appearance(Some(window), cx);
            }))
            .on_action(cx.listener(|this, _: &ZoomIn, _, cx| this.zoom(2., cx)))
            .on_action(cx.listener(|this, _: &ZoomOut, _, cx| this.zoom(-2., cx)))
            .on_action(cx.listener(|this, _: &ResetZoom, _, cx| {
                let delta = 16. - f32::from(cx.theme().font_size);
                this.zoom(delta, cx);
            }))
            .flex()
            .flex_col()
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .when(!cfg!(target_os = "macos"), |view| {
                view.child(div().h_8().flex_shrink_0().child(self.menu.clone()))
            })
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .p_6()
                    .gap_4()
                    .child(div().text_xl().child("平台检查"))
                    .child(
                        div()
                            .text_sm()
                            .text_color(cx.theme().muted_foreground)
                            .child("输入内容仅用于平台检查，不会保存到笔记。"),
                    )
                    .child(
                        div().flex().flex_col().gap_2().child("测试文本").child(
                            Input::new(&self.input)
                                .id("test-text")
                                .aria_label("测试文本"),
                        ),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap_2()
                            .child(
                                Button::new("open-document-editor")
                                    .label("新建笔记…")
                                    .on_click(|_, window, cx| {
                                        window.dispatch_action(Box::new(OpenDocumentEditor), cx)
                                    }),
                            )
                            .child(
                                Button::new("open-last-document")
                                    .label("继续编辑…")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.open_document(true, window, cx)
                                    })),
                            )
                            .child(
                                Button::new("choose-file")
                                    .label("选择文件…")
                                    .disabled(self.picking)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.choose_file(&ChooseFile, window, cx)
                                    })),
                            )
                            .child(Button::new("edit-text").label("编辑测试文本…").on_click(
                                cx.listener(|this, _, window, cx| {
                                    this.edit_text(&EditText, window, cx)
                                }),
                            ))
                            .child(Button::new("toggle-theme").label("切换主题").on_click(
                                cx.listener(|this, _, window, cx| {
                                    this.toggle_theme(&ToggleTheme, window, cx)
                                }),
                            )),
                    )
                    .child(
                        div()
                            .id("file-selection")
                            .role(gpui_kit::Role::Status)
                            .test_support()
                            .aria_label(self.selected.clone())
                            .text_sm()
                            .child(self.selected.clone()),
                    )
                    .child(self.migration.clone())
                    .overflow_y_scrollbar(),
            )
    }
}
