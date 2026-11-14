use super::{
    codec,
    geometry::{Viewport, Zoom, rectangle},
    service::request,
};
use crate::backend_client::BackendClient;
use anynote_core::{
    backend::{Command, Reply},
    image::*,
};
use gpui_kit::{
    component::{
        ActiveTheme, Disableable, Sizable, WindowExt,
        button::{Button, ButtonVariants},
        dialog::{DialogAction, DialogClose, DialogFooter},
        input::{Input, InputState},
    },
    prelude::*,
    *,
};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

pub struct ImageVersion {
    pub scope: ImageScope,
    pub bytes: Arc<Vec<u8>>,
}
pub struct ImageView {
    scope: ImageScope,
    current: ImageScope,
    client: BackendClient,
    compact: bool,
    alt: String,
    focus: FocusHandle,
    viewport: Viewport,
    bounds: Bounds<Pixels>,
    image_bounds: [f32; 4],
    bytes: Option<Arc<Vec<u8>>>,
    pixels: Option<Arc<image::RgbaImage>>,
    texture: Option<Arc<RenderImage>>,
    metadata: Option<codec::Metadata>,
    hash: String,
    annotations: Vec<ImageAnnotation>,
    selection: Option<ImageRect>,
    anchor: Option<[f64; 2]>,
    dragging: Option<Point<Pixels>>,
    marking: bool,
    loading: bool,
    working: bool,
    error: Option<String>,
    task: Option<Task<()>>,
    operation: Option<Task<()>>,
    cancel: Arc<AtomicBool>,
    generation: u64,
    release: Option<Subscription>,
}
impl EventEmitter<ImageVersion> for ImageView {}
impl Focusable for ImageView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}
pub(crate) fn texture(mut pixels: image::RgbaImage) -> Arc<RenderImage> {
    for pixel in pixels.pixels_mut() {
        pixel.0.swap(0, 2);
    }
    Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
}
impl ImageView {
    pub fn new(
        scope: ImageScope,
        client: BackendClient,
        compact: bool,
        alt: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut view = Self {
            current: scope.clone(),
            scope,
            client,
            compact,
            alt,
            focus: cx.focus_handle().tab_stop(true),
            viewport: Viewport::default(),
            bounds: Bounds::default(),
            image_bounds: [0.; 4],
            bytes: None,
            pixels: None,
            texture: None,
            metadata: None,
            hash: String::new(),
            annotations: vec![],
            selection: None,
            anchor: None,
            dragging: None,
            marking: false,
            loading: false,
            working: false,
            error: None,
            task: None,
            operation: None,
            cancel: Arc::new(AtomicBool::new(false)),
            generation: 0,
            release: None,
        };
        view.release = Some(cx.on_release(|this, cx| {
            this.cancel.store(true, Ordering::Relaxed);
            if let Some(texture) = this.texture.take() {
                cx.drop_image(texture, None);
            }
        }));
        view.load(window, cx);
        view
    }
    pub fn dimensions(&self) -> Option<(u32, u32)> {
        self.metadata.as_ref().map(|m| (m.width, m.height))
    }
    pub fn scope(&self) -> &ImageScope {
        &self.scope
    }
    pub fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.cancel.store(true, Ordering::Relaxed);
        self.task = None;
        self.operation = None;
        self.bytes = None;
        self.pixels = None;
        if let Some(texture) = self.texture.take() {
            cx.drop_image(texture, Some(window));
        }
    }
    fn load(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.close(window, cx);
        self.cancel = Arc::new(AtomicBool::new(false));
        self.generation += 1;
        let generation = self.generation;
        self.loading = true;
        self.working = false;
        self.error = None;
        self.metadata = None;
        self.annotations.clear();
        self.selection = None;
        self.viewport = Viewport::default();
        let client = self.client.clone();
        let scope = self.scope.clone();
        let cancel = self.cancel.clone();
        let compact = self.compact;
        self.task = Some(cx.spawn_in(window, async move |this, cx| {
            let result = async {
                let (hash, bytes) = super::service::read(&client, &scope, &cancel).await?;
                let bytes = Arc::new(bytes);
                let source = bytes.clone();
                let decoded = cx
                    .background_spawn(async move {
                        let preview =
                            codec::preview(&source, if compact { 640 } else { 2560 }, &cancel)?;
                        let pixels = Arc::new(preview.pixels);
                        let texture = texture((*pixels).clone());
                        Ok::<_, String>((preview.metadata, pixels, texture))
                    })
                    .await?;
                let annotations = if !compact {
                    match request(&client, Command::Image(ImageCommand::Annotations { scope }))
                        .await?
                    {
                        Reply::Image(ImageReply::Annotations { annotations }) => annotations,
                        _ => vec![],
                    }
                } else {
                    vec![]
                };
                Ok((bytes, hash, decoded, annotations))
            }
            .await;
            let _ = this.update_in(cx, |this, _, cx| {
                if this.generation != generation {
                    return;
                }
                this.loading = false;
                match result {
                    Ok((bytes, hash, (metadata, pixels, texture), annotations)) => {
                        if !this.compact {
                            this.bytes = Some(bytes);
                            this.pixels = Some(pixels);
                        }
                        this.hash = hash;
                        this.metadata = Some(metadata);
                        this.texture = Some(texture);
                        this.annotations = annotations;
                    }
                    Err(error) => this.error = Some(error),
                }
                cx.notify();
            });
        }));
        cx.notify();
    }
    fn natural(&self) -> [f32; 2] {
        self.metadata
            .as_ref()
            .map_or([1., 1.], |m| [m.width as f32, m.height as f32])
    }
    fn zoom(&mut self, factor: f32, window: &Window) {
        self.viewport.zoom_by(
            factor,
            self.natural(),
            [
                self.bounds.size.width.into(),
                self.bounds.size.height.into(),
            ],
            window.scale_factor(),
        );
    }
    fn rotate(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.working || self.pixels.is_none() {
            return;
        }
        let turns = (self.viewport.turns + 1) % 4;
        let pixels = self.pixels.clone().unwrap();
        self.working = true;
        self.operation = Some(cx.spawn_in(window, async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    texture(match turns {
                        1 => image::imageops::rotate90(&*pixels),
                        2 => image::imageops::rotate180(&*pixels),
                        3 => image::imageops::rotate270(&*pixels),
                        _ => (*pixels).clone(),
                    })
                })
                .await;
            let _ = this.update_in(cx, |this, window, cx| {
                if let Some(old) = this.texture.replace(result) {
                    cx.drop_image(old, Some(window));
                }
                this.viewport.turns = turns;
                this.viewport.pan = [0.; 2];
                this.working = false;
                cx.notify();
            });
        }));
    }
    fn save_version(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.working || self.scope != self.current || self.viewport.turns == 0 {
            return;
        }
        let Some(bytes) = self.bytes.clone() else {
            return;
        };
        let turns = self.viewport.turns;
        let cancel = self.cancel.clone();
        self.working = true;
        self.operation = Some(cx.spawn_in(window, async move |this, cx| {
            let result = cx
                .background_spawn(async move { codec::rotate(&bytes, turns, &cancel) })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.working = false;
                match result {
                    Ok(bytes) => cx.emit(ImageVersion {
                        scope: this.scope.clone(),
                        bytes: Arc::new(bytes),
                    }),
                    Err(error) => this.error = Some(error),
                }
                cx.notify();
            });
        }));
    }
    fn export(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(bytes) = self.bytes.clone() else {
            return;
        };
        if self.working {
            return;
        }
        let name = match self.metadata.as_ref().map(|m| m.mime.as_str()) {
            Some("image/jpeg") => "image.jpg",
            Some("image/webp") => "image.webp",
            Some("image/svg+xml") => "image.svg",
            Some("image/gif") => "image.gif",
            Some("image/bmp") => "image.bmp",
            Some("image/tiff") => "image.tiff",
            Some("image/x-icon" | "image/vnd.microsoft.icon") => "image.ico",
            _ => "image.png",
        };
        let prompt = cx.prompt_for_new_path(std::path::Path::new("."), Some(name));
        let cancel = self.cancel.clone();
        self.working = true;
        self.operation = Some(cx.spawn_in(window, async move |this, cx| {
            let result = async {
                let path = prompt
                    .await
                    .map_err(|_| "无法打开导出对话框")?
                    .map_err(|_| "无法选择导出位置")?;
                let Some(path) = path else {
                    return Ok(());
                };
                cx.background_spawn(
                    async move { crate::asset_writer::export(&path, &bytes, &cancel) },
                )
                .await
            }
            .await;
            let _ = this.update(cx, |this, cx| {
                this.working = false;
                this.error = result.err();
                cx.notify();
            });
        }));
    }
    fn annotate(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(rectangle) = self.selection else {
            return;
        };
        if self.scope != self.current || self.working {
            return;
        }
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("批注内容"));
        let owner = cx.weak_entity();
        window.open_dialog(cx, move |dialog, _, _| {
            let owner = owner.clone();
            let input = input.clone();
            dialog
                .title("添加区域批注")
                .child(
                    Input::new(&input)
                        .id("image-annotation-input")
                        .aria_label("批注内容"),
                )
                .footer(
                    DialogFooter::new()
                        .child(DialogClose::new().trigger(|b| b.label("取消")))
                        .child(
                            DialogAction::new().child(
                                Button::new("confirm-image-annotation")
                                    .primary()
                                    .label("添加"),
                            ),
                        ),
                )
                .on_ok(move |_, window, cx| {
                    let body = input.read(cx).value().to_string();
                    let _ = owner.update(cx, |this, cx| {
                        this.change_annotation(
                            ImageCommand::Annotate {
                                scope: this.scope.clone(),
                                hash: this.hash.clone(),
                                rectangle,
                                body,
                            },
                            window,
                            cx,
                        )
                    });
                    true
                })
        });
    }
    fn change_annotation(
        &mut self,
        command: ImageCommand,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.working {
            return;
        }
        self.working = true;
        let client = self.client.clone();
        let scope = self.scope.clone();
        self.operation = Some(cx.spawn_in(window, async move |this, cx| {
            let result = async {
                request(&client, Command::Image(command)).await?;
                request(&client, Command::Image(ImageCommand::Annotations { scope })).await
            }
            .await;
            let _ = this.update(cx, |this, cx| {
                this.working = false;
                match result {
                    Ok(Reply::Image(ImageReply::Annotations { annotations })) => {
                        this.annotations = annotations;
                        this.selection = None;
                    }
                    Err(error) => this.error = Some(error),
                    _ => this.error = Some("批注响应无效".into()),
                }
                cx.notify();
            });
        }));
    }
    fn history(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.working {
            return;
        }
        self.working = true;
        let client = self.client.clone();
        let scope = self.scope.clone();
        self.operation = Some(cx.spawn_in(window, async move |this, cx| {
            let result = request(&client, Command::Image(ImageCommand::Revisions { scope })).await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.working = false;
                if let Ok(Reply::Image(ImageReply::Revisions { revisions })) = result {
                    let owner = cx.weak_entity();
                    window.open_dialog(cx, move |dialog, _, _| {
                        let owner = owner.clone();
                        dialog.title("图片版本").child(
                            div()
                                .id("image-history-list")
                                .flex()
                                .flex_col()
                                .gap_2()
                                .max_h_96()
                                .overflow_y_scroll()
                                .children(revisions.iter().map(|revision| {
                                    let id = revision.revision;
                                    let owner = owner.clone();
                                    Button::new(SharedString::from(id.to_string()))
                                        .label(format!(
                                            "{} · {}",
                                            revision.created_at,
                                            &revision.hash[..12]
                                        ))
                                        .on_click(move |_, window, cx| {
                                            window.close_dialog(cx);
                                            let _ = owner.update(cx, |this, cx| {
                                                this.scope.revision = id;
                                                this.load(window, cx);
                                            });
                                        })
                                })),
                        )
                    });
                } else {
                    this.error = Some("无法读取图片历史".into());
                }
                cx.notify();
            });
        }));
    }
    fn key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event.keystroke.key.as_str() {
            "+" | "=" => self.zoom(1.25, window),
            "-" => self.zoom(0.8, window),
            "0" => self.viewport = Viewport::default(),
            "1" => {
                self.viewport.zoom = Zoom::Actual;
                self.viewport.pan = [0.; 2];
            }
            "r" => self.rotate(window, cx),
            "left" => self.viewport.pan[0] += 32.,
            "right" => self.viewport.pan[0] -= 32.,
            "up" => self.viewport.pan[1] += 32.,
            "down" => self.viewport.pan[1] -= 32.,
            "escape" => {
                self.selection = None;
                self.marking = false;
                self.anchor = None;
            }
            _ => return,
        }
        cx.stop_propagation();
        cx.notify();
    }
}
impl Render for ImageView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let owner = cx.entity();
        let paint_owner = owner.clone();
        let mut surface = div()
            .id("image-view")
            .flex()
            .flex_col()
            .size_full()
            .min_w_0()
            .min_h_0()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground);
        if !self.compact {
            let disabled = self.loading || self.working;
            surface = surface.child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_2()
                    .p_2()
                    .child(
                        Button::new("image-fit")
                            .small()
                            .label("适应")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.viewport.zoom = Zoom::Fit;
                                this.viewport.pan = [0.; 2];
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("image-actual")
                            .small()
                            .label("实际尺寸")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.viewport.zoom = Zoom::Actual;
                                this.viewport.pan = [0.; 2];
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("image-zoom-out")
                            .small()
                            .label("缩小")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.zoom(0.8, window);
                                cx.notify();
                            })),
                    )
                    .child(Button::new("image-zoom-in").small().label("放大").on_click(
                        cx.listener(|this, _, window, cx| {
                            this.zoom(1.25, window);
                            cx.notify();
                        }),
                    ))
                    .child(
                        Button::new("image-rotate")
                            .small()
                            .label("旋转视图")
                            .disabled(disabled)
                            .on_click(cx.listener(|this, _, w, cx| this.rotate(w, cx))),
                    )
                    .child(
                        Button::new("image-save-version")
                            .small()
                            .label("旋转另存版本")
                            .disabled(
                                disabled || self.viewport.turns == 0 || self.scope != self.current,
                            )
                            .on_click(cx.listener(|this, _, w, cx| this.save_version(w, cx))),
                    )
                    .child(
                        Button::new("image-export")
                            .small()
                            .label("导出原图…")
                            .disabled(disabled)
                            .on_click(cx.listener(|this, _, w, cx| this.export(w, cx))),
                    )
                    .child(
                        Button::new("image-copy")
                            .small()
                            .label("复制图片")
                            .disabled(disabled)
                            .on_click(cx.listener(|this, _, _, cx| {
                                if let Some(bytes) = &this.bytes {
                                    let format =
                                        match this.metadata.as_ref().map(|m| m.mime.as_str()) {
                                            Some("image/jpeg") => ImageFormat::Jpeg,
                                            Some("image/webp") => ImageFormat::Webp,
                                            Some("image/svg+xml") => ImageFormat::Svg,
                                            Some("image/gif") => ImageFormat::Gif,
                                            Some("image/bmp") => ImageFormat::Bmp,
                                            Some("image/tiff") => ImageFormat::Tiff,
                                            Some("image/x-icon" | "image/vnd.microsoft.icon") => {
                                                ImageFormat::Ico
                                            }
                                            _ => ImageFormat::Png,
                                        };
                                    cx.write_to_clipboard(ClipboardItem::new_image(
                                        &Image::from_bytes(format, (**bytes).clone()),
                                    ));
                                }
                            })),
                    )
                    .child(
                        Button::new("image-history")
                            .small()
                            .label("历史…")
                            .disabled(disabled)
                            .on_click(cx.listener(|this, _, w, cx| this.history(w, cx))),
                    )
                    .when(self.scope != self.current, |bar| {
                        bar.child(
                            Button::new("image-current")
                                .small()
                                .label("返回当前版本")
                                .on_click(cx.listener(|this, _, w, cx| {
                                    this.scope = this.current.clone();
                                    this.load(w, cx);
                                })),
                        )
                    })
                    .child(
                        Button::new("image-mark")
                            .small()
                            .label(if self.marking {
                                "结束选区"
                            } else {
                                "区域批注"
                            })
                            .disabled(disabled || self.scope != self.current)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.marking = !this.marking;
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("image-annotate")
                            .small()
                            .label("添加批注…")
                            .disabled(
                                disabled || self.selection.is_none() || self.scope != self.current,
                            )
                            .on_click(cx.listener(|this, _, w, cx| this.annotate(w, cx))),
                    ),
            );
        }
        if self.loading {
            surface = surface.child(
                div()
                    .id("image-loading")
                    .role(Role::Status)
                    .p_2()
                    .child("正在读取图片"),
            );
        }
        if let Some(error) = &self.error {
            surface = surface.child(
                div()
                    .p_2()
                    .text_color(cx.theme().danger)
                    .child(error.clone())
                    .child(
                        Button::new("image-retry")
                            .label("重试")
                            .on_click(cx.listener(|this, _, w, cx| this.load(w, cx))),
                    ),
            );
        }
        let canvas = canvas(
            move |bounds, _, cx| {
                owner.update(cx, |this, _| this.bounds = bounds);
            },
            move |bounds, _, window, cx| {
                paint_owner.update(cx, |this, cx| {
                    let natural = this.natural();
                    let [x, y, w, h] = if this.compact {
                        [0., 0., bounds.size.width.into(), bounds.size.height.into()]
                    } else {
                        this.viewport.bounds(
                            natural,
                            [bounds.size.width.into(), bounds.size.height.into()],
                            window.scale_factor(),
                        )
                    };
                    this.image_bounds = [
                        x + f32::from(bounds.origin.x),
                        y + f32::from(bounds.origin.y),
                        w,
                        h,
                    ];
                    if let Some(texture) = &this.texture {
                        let image_bounds = Bounds::new(
                            point(bounds.origin.x + px(x), bounds.origin.y + px(y)),
                            size(px(w), px(h)),
                        );
                        let _ = window.paint_image(
                            bounds,
                            image_bounds,
                            Corners::default(),
                            texture.clone(),
                            0,
                            false,
                        );
                        for rectangle in this
                            .annotations
                            .iter()
                            .filter(|a| a.hash == this.hash)
                            .flat_map(|a| a.rectangles.iter().copied())
                            .chain(this.selection)
                        {
                            let r = this.viewport.displayed_rect(rectangle);
                            let rect = Bounds::new(
                                point(
                                    image_bounds.origin.x + px(r.x as f32 * w),
                                    image_bounds.origin.y + px(r.y as f32 * h),
                                ),
                                size(px(r.width as f32 * w), px(r.height as f32 * h)),
                            )
                            .intersect(&bounds);
                            window.paint_quad(outline(
                                rect,
                                cx.theme().primary,
                                BorderStyle::Solid,
                            ));
                        }
                    }
                });
            },
        )
        .size_full();
        let compact = self.compact;
        surface = surface.child(
            div()
                .id("image-canvas")
                .test_support()
                .role(Role::Image)
                .aria_label(self.alt.clone())
                .track_focus(&self.focus)
                .focus_visible(|s| s.border_1().border_color(cx.theme().ring))
                .flex_1()
                .min_h_0()
                .overflow_hidden()
                .on_key_down(cx.listener(Self::key))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                        if compact {
                            return;
                        }
                        this.focus.focus(window, cx);
                        cx.stop_propagation();
                        if this.marking && this.texture.is_some() {
                            this.anchor = Some(this.viewport.original_point(
                                [event.position.x.into(), event.position.y.into()],
                                this.image_bounds,
                            ));
                        } else {
                            this.dragging = Some(event.position);
                        }
                    }),
                )
                .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _, cx| {
                    if !event.dragging() {
                        return;
                    }
                    if let Some(start) = this.anchor {
                        this.selection = rectangle(
                            start,
                            this.viewport.original_point(
                                [event.position.x.into(), event.position.y.into()],
                                this.image_bounds,
                            ),
                        );
                    }
                    if let Some(previous) = this.dragging {
                        this.dragging = Some(event.position);
                        this.viewport.pan[0] += f32::from(event.position.x - previous.x);
                        this.viewport.pan[1] += f32::from(event.position.y - previous.y);
                    }
                    cx.notify();
                }))
                .on_mouse_up(
                    MouseButton::Left,
                    cx.listener(|this, _, _, cx| {
                        this.dragging = None;
                        this.anchor = None;
                        cx.notify();
                    }),
                )
                .on_mouse_up_out(
                    MouseButton::Left,
                    cx.listener(|this, _, _, cx| {
                        this.dragging = None;
                        this.anchor = None;
                        cx.notify();
                    }),
                )
                .on_scroll(cx.listener(|this, event: &ScrollEvent, window, cx| {
                    if !this.compact {
                        this.zoom(
                            if event.delta.pixel_delta(window.rem_size()).y > px(0.) {
                                1.1
                            } else {
                                1. / 1.1
                            },
                            window,
                        );
                        cx.stop_propagation();
                        cx.notify();
                    }
                }))
                .child(canvas),
        );
        if !self.compact {
            if let Some(m) = &self.metadata {
                let label = format!(
                    "{} × {} · {} · 视图 {}°",
                    m.width,
                    m.height,
                    m.mime,
                    u16::from(self.viewport.turns) * 90
                );
                surface = surface.child(
                    div()
                        .id("image-metadata")
                        .role(Role::Status)
                        .aria_label(label.clone())
                        .test_support()
                        .px_2()
                        .text_sm()
                        .text_color(cx.theme().muted_foreground)
                        .child(label),
                );
            }
            surface = surface.child(
                div()
                    .id("image-details")
                    .max_h_32()
                    .overflow_y_scroll()
                    .p_2()
                    .text_sm()
                    .children(
                        self.metadata
                            .iter()
                            .flat_map(|m| m.exif.iter())
                            .map(|(k, v)| div().child(format!("{k}: {v}"))),
                    )
                    .children(self.annotations.iter().map(|a| {
                        let id = a.id;
                        let historical = a.hash != self.hash;
                        div()
                            .flex()
                            .gap_2()
                            .child(if historical {
                                format!("旧版本批注：{}", a.body)
                            } else {
                                a.body.clone()
                            })
                            .child(
                                Button::new(SharedString::from(format!("delete-{id}")))
                                    .small()
                                    .ghost()
                                    .label("删除批注")
                                    .disabled(
                                        historical || self.working || self.scope != self.current,
                                    )
                                    .on_click(cx.listener(move |this, _, w, cx| {
                                        this.change_annotation(
                                            ImageCommand::DeleteAnnotation {
                                                scope: this.scope.clone(),
                                                annotation: id,
                                            },
                                            w,
                                            cx,
                                        )
                                    })),
                            )
                    })),
            );
        }
        let _ = window;
        surface
    }
}
