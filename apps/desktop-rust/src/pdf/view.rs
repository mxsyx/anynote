use super::{PdfServer, reader::ResourceReader};
use crate::backend_client::BackendClient;
use anynote_core::asset::AssetScope;
use gpui_kit::{
    component::{
        ActiveTheme, Disableable, Sizable,
        button::{Button, ButtonVariants},
    },
    prelude::*,
    *,
};
use gpui_webview::WebView;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

enum ViewerEvent {
    Loaded,
    Download,
    Unsupported,
}

pub struct PdfView {
    scope: AssetScope,
    client: BackendClient,
    webview: Option<Entity<WebView>>,
    server: Option<PdfServer>,
    focus: FocusHandle,
    loading: bool,
    error: Option<String>,
    exporting: bool,
    cancelled: Arc<AtomicBool>,
    load: Option<Task<()>>,
    events: Option<Task<()>>,
    timeout: Option<Task<()>>,
    export: Option<Task<()>>,
    _release: Subscription,
}
impl Focusable for PdfView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}
impl PdfView {
    pub fn new(
        scope: AssetScope,
        client: BackendClient,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut view = Self {
            scope,
            client,
            webview: None,
            server: None,
            focus: cx.focus_handle().tab_stop(true),
            loading: true,
            error: None,
            exporting: false,
            cancelled: Arc::new(AtomicBool::new(false)),
            load: None,
            events: None,
            timeout: None,
            export: None,
            _release: cx.on_release(|this, cx| this.close(cx)),
        };
        view.open(window, cx);
        view
    }
    pub fn is_loading(&self) -> bool {
        self.loading
    }
    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }
    pub fn close(&mut self, cx: &mut App) {
        self.cancelled.store(true, Ordering::Release);
        self.load = None;
        self.events = None;
        self.timeout = None;
        self.export = None;
        if let Some(view) = self.webview.take() {
            let _ = view.read(cx).set_visible(false);
        }
        self.server = None;
    }
    fn open(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.close(cx);
        self.cancelled = Arc::new(AtomicBool::new(false));
        self.loading = true;
        self.error = None;
        let client = self.client.clone();
        let scope = self.scope.clone();
        self.load = Some(cx.spawn_in(window, async move |this, cx| {
            let result = cx
                .background_spawn(async move { PdfServer::open(client, scope) })
                .await;
            let _ = this.update_in(cx, |this, window, cx| {
                match result.and_then(|server| this.mount(server, window, cx)) {
                    Ok(()) => {}
                    Err(error) => {
                        this.loading = false;
                        this.error = Some(error);
                    }
                }
                cx.notify();
            });
        }));
        cx.notify();
    }
    fn mount(
        &mut self,
        server: PdfServer,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        crate::webview::platform_check()?;
        let url = server.url().to_owned();
        let allowed = url.clone();
        let (send, receive) = async_channel::bounded(4);
        let download = send.clone();
        let loaded = Arc::new(AtomicBool::new(false));
        let downloaded_after_load = loaded.clone();
        let native = WebView::build(
            crate::webview::builder()
                .with_url(&url)
                .with_navigation_handler(move |target| {
                    target.split('#').next() == Some(allowed.as_str())
                })
                .with_download_started_handler(move |_, _| {
                    let _ = download.try_send(if downloaded_after_load.load(Ordering::Acquire) {
                        ViewerEvent::Download
                    } else {
                        ViewerEvent::Unsupported
                    });
                    false
                })
                .with_on_page_load_handler(move |event, _| {
                    if matches!(event, wry::PageLoadEvent::Finished) {
                        loaded.store(true, Ordering::Release);
                        let _ = send.try_send(ViewerEvent::Loaded);
                    }
                }),
            window,
            cx,
        )
        .map_err(|_| "无法打开系统 PDF 查看器，请重试或导出文件".to_owned())?;
        let view = cx.new(|_| native);
        view.read(cx).focus_handle(cx).focus(window, cx);
        let _ = view.read(cx).raw().focus();
        self.webview = Some(view);
        self.server = Some(server);
        self.events = Some(cx.spawn_in(window, async move |this, cx| {
            while let Ok(result) = receive.recv().await {
                if this
                    .update_in(cx, |this, window, cx| {
                        this.loading = false;
                        this.timeout = None;
                        match result {
                            ViewerEvent::Loaded => {}
                            ViewerEvent::Download => this.export(window, cx),
                            ViewerEvent::Unsupported => {
                                if let Some(view) = this.webview.take() {
                                    let _ = view.read(cx).set_visible(false);
                                }
                                this.server = None;
                                this.error = Some(
                                    "系统查看器无法预览此 PDF，请导出后使用其他阅读器打开".into(),
                                );
                            }
                        }
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        }));
        self.timeout = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_secs(30))
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.loading {
                    this.loading = false;
                    this.error = Some("PDF 加载时间较长。若无法阅读，请重试或导出文件".into());
                    cx.notify();
                }
            });
        }));
        Ok(())
    }
    fn export(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.exporting {
            return;
        }
        let prompt = cx.prompt_for_new_path(std::path::Path::new("."), Some("document.pdf"));
        let client = self.client.clone();
        let scope = self.scope.clone();
        let cancelled = self.cancelled.clone();
        self.exporting = true;
        self.export = Some(cx.spawn_in(window, async move |this, cx| {
            let result = async {
                let Some(path) = prompt
                    .await
                    .map_err(|_| "无法打开导出对话框".to_owned())?
                    .map_err(|_| "无法选择导出位置".to_owned())?
                else {
                    return Ok(());
                };
                cx.background_spawn(async move {
                    let reader = ResourceReader::open(client, scope)?;
                    crate::asset_writer::export_reader(&path, reader, &cancelled)
                })
                .await
            }
            .await;
            let _ = this.update(cx, |this, cx| {
                this.exporting = false;
                if let Err(error) = result {
                    this.error = Some(error);
                }
                cx.notify();
            });
        }));
        cx.notify();
    }
}
impl Render for PdfView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("pdf-reader")
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .flex_col()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_3()
                    .py_2()
                    .child(
                        Button::new("pdf-retry")
                            .small()
                            .ghost()
                            .label("重新加载")
                            .disabled(self.exporting)
                            .on_click(cx.listener(|this, _, window, cx| this.open(window, cx))),
                    )
                    .child(
                        Button::new("pdf-export")
                            .small()
                            .ghost()
                            .label("导出原件…")
                            .disabled(self.exporting)
                            .on_click(cx.listener(|this, _, window, cx| this.export(window, cx))),
                    )
                    .when(self.loading || self.exporting, |bar| {
                        bar.child(
                            div()
                                .text_sm()
                                .text_color(cx.theme().muted_foreground)
                                .child(if self.exporting {
                                    "正在导出 PDF"
                                } else {
                                    "正在打开 PDF"
                                }),
                        )
                    }),
            )
            .when_some(self.error.clone(), |root, error| {
                root.child(
                    div()
                        .id("pdf-error")
                        .px_3()
                        .py_2()
                        .text_sm()
                        .text_color(cx.theme().danger)
                        .child(error),
                )
            })
            .when_some(self.webview.clone(), |root, view| {
                root.child(div().flex_1().min_h_0().min_w_0().child(view))
            })
    }
}
