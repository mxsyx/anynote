use super::{PageGeometry, PageRaster, PdfError, PdfWorker, Zoom};
use crate::backend_client::BackendClient;
use anynote_core::asset::AssetScope;
use gpui_kit::{
    component::{
        ActiveTheme, Disableable, Selectable, Sizable,
        button::{Button, ButtonVariants},
        input::{Input, InputState},
    },
    prelude::*,
    *,
};
use std::sync::Arc;

mod controls;
mod interaction;

pub struct PdfView {
    reading: interaction::Reading,
    scope: AssetScope,
    client: BackendClient,
    worker: Option<PdfWorker>,
    task: Option<Task<()>>,
    generation: u64,
    focus: FocusHandle,
    page_input: Entity<InputState>,
    password: Entity<InputState>,
    count: u16,
    page: u16,
    hash: String,
    zoom: Zoom,
    geometry: Option<PageGeometry>,
    raster: Option<PageRaster>,
    texture: Option<Arc<RenderImage>>,
    thumbnails: Vec<(u16, Arc<RenderImage>)>,
    show_thumbnails: bool,
    viewport: [f32; 2],
    pan: [f32; 2],
    edge: u32,
    loading: bool,
    closed: bool,
    error: Option<PdfError>,
    release: Option<Subscription>,
}
fn texture(mut pixels: image::RgbaImage) -> Arc<RenderImage> {
    for p in pixels.pixels_mut() {
        p.0.swap(0, 2);
    }
    Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
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
            reading: interaction::Reading::new(window, cx),
            scope,
            client,
            worker: None,
            task: None,
            generation: 0,
            focus: cx.focus_handle().tab_stop(true),
            page_input: cx.new(|cx| InputState::new(window, cx).default_value("1")),
            password: cx.new(|cx| InputState::new(window, cx).masked(true)),
            count: 0,
            page: 0,
            hash: String::new(),
            zoom: Zoom::FitPage,
            geometry: None,
            raster: None,
            texture: None,
            thumbnails: vec![],
            show_thumbnails: false,
            viewport: [640., 720.],
            pan: [0.; 2],
            edge: 0,
            loading: true,
            closed: false,
            error: None,
            release: None,
        };
        view.release = Some(cx.on_release(|this, cx| {
            this.worker = None;
            if let Some(image) = this.texture.take() {
                cx.drop_image(image, None);
            }
            for (_, image) in this.thumbnails.drain(..) {
                cx.drop_image(image, None);
            }
        }));
        view.open(window, cx);
        view
    }
    pub fn is_loading(&self) -> bool {
        self.loading
    }
    pub fn page(&self) -> u16 {
        self.page
    }
    pub fn page_count(&self) -> u16 {
        self.count
    }
    pub fn hash(&self) -> &str {
        &self.hash
    }
    pub fn raster(&self) -> Option<&PageRaster> {
        self.raster.as_ref()
    }
    pub fn cached_texture_count(&self) -> usize {
        usize::from(self.texture.is_some()) + self.thumbnails.len()
    }
    pub fn zoom(&self) -> Zoom {
        self.zoom
    }
    fn clear_textures(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(image) = self.texture.take() {
            cx.drop_image(image, Some(window));
        }
        for (_, image) in self.thumbnails.drain(..) {
            cx.drop_image(image, Some(window));
        }
        self.raster = None;
    }
    pub fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.reading.stop();
        self.closed = true;
        self.generation += 1;
        self.worker = None;
        self.task = None;
        self.loading = false;
        self.clear_textures(window, cx);
        self.geometry = None;
        cx.notify();
    }
    fn open(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.close(window, cx);
        self.closed = false;
        self.loading = true;
        self.error = None;
        self.count = 0;
        let password = self.password.read(cx).value().to_string();
        self.password
            .update(cx, |input, cx| input.set_value("", window, cx));
        self.reading.password = password.clone();
        let (worker, ready) = PdfWorker::open(self.client.clone(), self.scope.clone(), password);
        self.worker = Some(worker);
        let generation = self.generation;
        self.task = Some(cx.spawn_in(window, async move |this, cx| {
            let result = ready.recv().await.unwrap_or(Err(PdfError::Unavailable));
            let _ = this.update_in(cx, |this, window, cx| {
                if this.generation != generation || this.closed {
                    return;
                }
                this.loading = false;
                match result {
                    Ok((count, hash)) => {
                        this.count = count;
                        this.hash = hash;
                        this.load_annotations(window, cx);
                        this.page = this.page.min(count - 1);
                        this.render_page(window, cx);
                    }
                    Err(error) => {
                        this.error = Some(error);
                        this.worker = None;
                    }
                }
                cx.notify();
            });
        }));
    }
    fn natural(&self) -> [f32; 2] {
        self.geometry
            .as_ref()
            .map_or([612., 792.], PageGeometry::size)
    }
    fn scale(&self) -> f32 {
        self.zoom.scale(self.natural(), self.viewport)
    }
    fn target_edge(&self, window: &Window) -> u32 {
        let size = self.natural();
        (size[0].max(size[1]) * self.scale() * window.scale_factor())
            .ceil()
            .clamp(32., 4096.) as u32
    }
    fn render_page(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.closed || self.count == 0 {
            return;
        }
        self.generation += 1;
        self.task = None;
        self.clear_textures(window, cx);
        let generation = self.generation;
        let edge = self.target_edge(window);
        self.edge = edge;
        let Some(worker) = &self.worker else {
            return;
        };
        let receive = worker.render(self.page, edge, true);
        self.loading = true;
        self.error = None;
        let page = self.page;
        self.task = Some(cx.spawn_in(window, async move |this, cx| {
            let result = receive.recv().await.unwrap_or(Err(PdfError::Cancelled));
            let result = cx
                .background_spawn(async move {
                    result.map(|mut raster| {
                        let image = texture(std::mem::take(&mut raster.pixels));
                        (raster, image)
                    })
                })
                .await;
            let keep = this
                .update_in(cx, |this, window, cx| {
                    if this.generation != generation || this.closed {
                        return false;
                    }
                    this.loading = false;
                    match result {
                        Ok((raster, image)) => {
                            this.geometry = Some(raster.geometry.clone());
                            this.texture = Some(image);
                            this.raster = Some(raster);
                            this.apply_search_selection();
                            this.center_focus();
                        }
                        Err(error) => this.error = Some(error),
                    }
                    // A differently sized page may need a second raster at its actual fit scale.
                    if this.error.is_none() && this.target_edge(window).abs_diff(this.edge) > 2 {
                        this.render_page(window, cx);
                        return false;
                    }
                    cx.notify();
                    this.show_thumbnails && this.error.is_none()
                })
                .unwrap_or(false);
            if !keep {
                return;
            }
            let start = (page / 5) * 5;
            for index in start..start.saturating_add(5) {
                let receiver = this
                    .update(cx, |this, _| {
                        if this.closed || this.generation != generation || index >= this.count {
                            return None;
                        }
                        this.worker
                            .as_ref()
                            .map(|worker| worker.render(index, 160, false))
                    })
                    .ok()
                    .flatten();
                let Some(receiver) = receiver else {
                    break;
                };
                let result = receiver.recv().await;
                let result = cx
                    .background_spawn(async move {
                        result
                            .ok()
                            .and_then(Result::ok)
                            .map(|mut raster| texture(std::mem::take(&mut raster.pixels)))
                    })
                    .await;
                let _ = this.update_in(cx, |this, window, cx| {
                    if this.closed || this.generation != generation {
                        return;
                    }
                    if let Some(image) = result {
                        this.thumbnails.push((index, image));
                        cx.notify();
                    }
                    let _ = window;
                });
            }
        }));
        cx.notify();
    }
    fn go(&mut self, page: u16, window: &mut Window, cx: &mut Context<Self>) {
        if page >= self.count || self.closed {
            return;
        }
        self.reading.selection = None;
        self.reading.drag = None;
        self.reading.focused = None;
        self.page = page;
        self.pan = [0.; 2];
        self.page_input.update(cx, |input, cx| {
            input.set_value((u32::from(page) + 1).to_string(), window, cx)
        });
        self.render_page(window, cx);
    }
    fn change_zoom(&mut self, zoom: Zoom, window: &mut Window, cx: &mut Context<Self>) {
        self.zoom = zoom;
        self.pan = [0.; 2];
        self.render_page(window, cx);
    }
    fn cancel(&mut self, cx: &mut Context<Self>) {
        self.generation += 1;
        self.task = None;
        if let Some(worker) = &self.worker {
            worker.cancel();
        }
        if self.count == 0 {
            self.worker = None;
        }
        self.loading = false;
        self.error = Some(PdfError::Cancelled);
        cx.notify();
    }
    fn key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.reading_key(event, window, cx) {
            cx.stop_propagation();
            return;
        }
        match event.keystroke.key.as_str() {
            "right" | "pagedown" => self.go(self.page.saturating_add(1), window, cx),
            "left" | "pageup" => self.go(self.page.saturating_sub(1), window, cx),
            "home" => self.go(0, window, cx),
            "end" => self.go(self.count.saturating_sub(1), window, cx),
            "+" | "=" => self.change_zoom(Zoom::Scale(self.scale() * 1.25), window, cx),
            "-" => self.change_zoom(Zoom::Scale(self.scale() / 1.25), window, cx),
            "0" => self.change_zoom(Zoom::FitPage, window, cx),
            "escape" if self.loading => self.cancel(cx),
            _ => return,
        }
        cx.stop_propagation();
    }
}
impl Render for PdfView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let disabled = self.count == 0 || self.closed;
        let toolbar = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap_2()
            .p_2()
            .child(
                Button::new("pdf-previous")
                    .small()
                    .label("上一页")
                    .disabled(disabled || self.page == 0)
                    .on_click(
                        cx.listener(|this, _, w, cx| this.go(this.page.saturating_sub(1), w, cx)),
                    ),
            )
            .child(
                Input::new(&self.page_input)
                    .id("pdf-page-input")
                    .aria_label("页码")
                    .w_16(),
            )
            .child(
                Button::new("pdf-jump")
                    .small()
                    .label("跳页")
                    .disabled(disabled)
                    .on_click(cx.listener(|this, _, w, cx| {
                        let value = this.page_input.read(cx).value().parse::<u16>();
                        match value {
                            Ok(n) if n > 0 && n <= this.count => this.go(n - 1, w, cx),
                            _ => {
                                this.error = Some(PdfError::PageNumber);
                                cx.notify();
                            }
                        }
                    })),
            )
            .child(
                Button::new("pdf-next")
                    .small()
                    .label("下一页")
                    .disabled(disabled || self.page + 1 >= self.count)
                    .on_click(
                        cx.listener(|this, _, w, cx| this.go(this.page.saturating_add(1), w, cx)),
                    ),
            )
            .child(
                Button::new("pdf-fit-page")
                    .small()
                    .label("适页")
                    .selected(self.zoom == Zoom::FitPage)
                    .disabled(disabled)
                    .on_click(cx.listener(|this, _, w, cx| this.change_zoom(Zoom::FitPage, w, cx))),
            )
            .child(
                Button::new("pdf-fit-width")
                    .small()
                    .label("适宽")
                    .selected(self.zoom == Zoom::FitWidth)
                    .disabled(disabled)
                    .on_click(
                        cx.listener(|this, _, w, cx| this.change_zoom(Zoom::FitWidth, w, cx)),
                    ),
            )
            .child(
                Button::new("pdf-zoom-out")
                    .small()
                    .label("缩小")
                    .disabled(disabled)
                    .on_click(cx.listener(|this, _, w, cx| {
                        this.change_zoom(Zoom::Scale(this.scale() / 1.25), w, cx)
                    })),
            )
            .child(
                Button::new("pdf-zoom-in")
                    .small()
                    .label("放大")
                    .disabled(disabled)
                    .on_click(cx.listener(|this, _, w, cx| {
                        this.change_zoom(Zoom::Scale(this.scale() * 1.25), w, cx)
                    })),
            )
            .child(
                Button::new("pdf-thumbnails")
                    .small()
                    .label("缩略图")
                    .selected(self.show_thumbnails)
                    .disabled(disabled)
                    .on_click(cx.listener(|this, _, w, cx| {
                        this.show_thumbnails = !this.show_thumbnails;
                        this.render_page(w, cx);
                    })),
            );
        let mut root = div()
            .id("pdf-reader")
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .min_w_0()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(toolbar)
            .child(self.reading_toolbar(cx));
        if let Some(error) = &self.error {
            root = root.child(
                div()
                    .id("pdf-error")
                    .test_support()
                    .role(Role::Status)
                    .aria_label(error.to_string())
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_2()
                    .p_2()
                    .text_color(cx.theme().danger)
                    .child(error.to_string())
                    .when(*error == PdfError::Password, |row| {
                        row.child(
                            div().flex().items_center().gap_2().child("密码").child(
                                Input::new(&self.password)
                                    .id("pdf-password")
                                    .aria_label("PDF 密码")
                                    .w_48(),
                            ),
                        )
                    })
                    .child(
                        Button::new("pdf-retry")
                            .small()
                            .label(if *error == PdfError::Password {
                                "解锁"
                            } else {
                                "重试"
                            })
                            .on_click(cx.listener(|this, _, w, cx| this.open(w, cx))),
                    ),
            );
        }
        let owner = cx.weak_entity();
        let paint_owner = cx.weak_entity();
        let canvas = canvas(
            move |bounds, window, cx| {
                let dimensions = [f32::from(bounds.size.width), f32::from(bounds.size.height)];
                let changed = owner
                    .update(cx, |this, _| {
                        this.viewport = dimensions;
                        !this.closed
                            && !this.loading
                            && this.error.is_none()
                            && this.count > 0
                            && this.target_edge(window).abs_diff(this.edge) > 2
                    })
                    .unwrap_or(false);
                if changed {
                    let owner = owner.clone();
                    window.on_next_frame(move |window, cx| {
                        let _ = owner.update(cx, |this, cx| this.render_page(window, cx));
                    });
                }
            },
            move |bounds, _, window, cx| {
                let _ = paint_owner.update(cx, |this, cx| {
                    let Some(image) = &this.texture else {
                        return;
                    };
                    let scale = this.scale();
                    let natural = this.natural();
                    let [width, height] = natural.map(|n| n * scale);
                    let w = f32::from(bounds.size.width);
                    let h = f32::from(bounds.size.height);
                    this.pan[0] = this.pan[0].clamp(-(width - w).max(0.), 0.);
                    this.pan[1] = this.pan[1].clamp(-(height - h).max(0.), 0.);
                    let destination = Bounds::new(
                        point(
                            bounds.origin.x + px(((w - width) / 2.).max(0.) + this.pan[0]),
                            bounds.origin.y + px(((h - height) / 2.).max(0.) + this.pan[1]),
                        ),
                        size(px(width), px(height)),
                    );
                    this.reading.destination = Some(destination);
                    let _ = window.paint_image(
                        bounds,
                        destination,
                        Corners::default(),
                        image.clone(),
                        0,
                        false,
                    );
                    this.paint_annotations(destination, window, cx);
                });
            },
        )
        .size_full();
        let page = div()
            .id("pdf-page")
            .test_support()
            .role(Role::Image)
            .aria_label(format!("PDF 第 {} 页", u32::from(self.page) + 1))
            .track_focus(&self.focus)
            .focus_visible(|s| s.border_1().border_color(cx.theme().ring))
            .flex_1()
            .min_w_0()
            .min_h_0()
            .overflow_hidden()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event, w, cx| this.selection_start(event, w, cx)),
            )
            .on_mouse_move(cx.listener(Self::selection_move))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _, _, _| this.reading.drag = None),
            )
            .on_key_down(cx.listener(Self::key))
            .on_scroll(cx.listener(|this, event: &ScrollEvent, window, cx| {
                let delta = event.delta.pixel_delta(window.rem_size());
                this.pan[0] += f32::from(delta.x);
                this.pan[1] += f32::from(delta.y);
                cx.notify();
                cx.stop_propagation();
            }))
            .child(canvas);
        let mut body = div().flex().items_stretch().flex_1().min_h_0().min_w_0();
        if self.show_thumbnails {
            body = body.child(
                div()
                    .id("pdf-thumbnail-list")
                    .test_support()
                    .w_32()
                    .flex_shrink_0()
                    .overflow_y_scroll()
                    .p_2()
                    .children(self.thumbnails.iter().map(|(page, image)| {
                        let index = *page;
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .mb_2()
                            .child(
                                img(image.clone())
                                    .w_full()
                                    .h_24()
                                    .object_fit(ObjectFit::Contain),
                            )
                            .child(
                                Button::new(("pdf-thumbnail", u64::from(index)))
                                    .small()
                                    .label(format!("第 {} 页", u32::from(index) + 1))
                                    .selected(index == self.page)
                                    .on_click(
                                        cx.listener(move |this, _, w, cx| this.go(index, w, cx)),
                                    ),
                            )
                    })),
            );
        }
        let status = if self.count == 0 {
            "PDF".into()
        } else {
            format!(
                "第 {} / {} 页 · {:.0}%",
                u32::from(self.page) + 1,
                self.count,
                self.scale() * 100.
            )
        };
        root.child(body.child(page).child(self.annotation_panel(cx)))
            .child(
                div()
                    .id("pdf-status")
                    .test_support()
                    .role(Role::Status)
                    .aria_label(status.clone())
                    .flex()
                    .items_center()
                    .gap_2()
                    .h_8()
                    .flex_shrink_0()
                    .px_2()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child(status)
                    .when(self.loading, |row| {
                        row.child("正在读取 PDF").child(
                            Button::new("pdf-cancel")
                                .small()
                                .ghost()
                                .label("取消")
                                .on_click(cx.listener(|this, _, _, cx| this.cancel(cx))),
                        )
                    }),
            )
    }
}
