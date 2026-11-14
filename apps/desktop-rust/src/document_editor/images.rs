use super::*;
use crate::{
    backend_session::BackendSession,
    image::{ImageVersion, ImageView, codec},
};
use anynote_core::{
    backend::Command,
    image::{ImageCommand, ImageScope},
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use uuid::Uuid;

pub(super) enum ImageInput {
    File(PathBuf),
    Bytes(String, Vec<u8>),
}
#[derive(Default)]
pub(super) struct Images {
    cache: HashMap<Uuid, Entity<ImageView>>,
    observations: HashMap<Uuid, Subscription>,
    queued: HashSet<Uuid>,
    pub previews: HashSet<Uuid>,
    pub active: Option<Entity<ImageView>>,
    subscription: Option<Subscription>,
    task: Option<Task<()>>,
    pub importing: bool,
    pub staged: HashMap<Uuid, (String, Arc<Vec<u8>>)>,
    cancel: Arc<AtomicBool>,
}
impl DocumentEditor {
    pub(super) fn reset_images(&mut self, window: &mut Window, cx: &mut App) {
        if let Some(pdf) = self.pdf.take() {
            pdf.update(cx, |v, cx| v.close(cx));
        }
        self.images.cancel.store(true, Ordering::Relaxed);
        if let Some(image) = self.images.active.take() {
            image.update(cx, |v, cx| v.close(window, cx));
        }
        self.images.observations.clear();
        for (_, image) in self.images.cache.drain() {
            image.update(cx, |v, cx| v.close(window, cx));
        }
        if let (Some(save), Some(client)) = (
            &self.state.save,
            cx.try_global::<BackendSession>()
                .map(|s| s.client().clone()),
        ) {
            let _ = client.submit(
                Command::Image(ImageCommand::Release {
                    document: save.base().id().clone(),
                    resources: self.images.staged.keys().copied().collect(),
                }),
                std::time::Duration::from_secs(10),
            );
        }
        self.images = Images::default();
    }
    pub(super) fn choose_images(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.images.importing || self.state.save.is_none() {
            self.error = Some("请先打开已保存的笔记".into());
            cx.notify();
            return;
        }
        let prompt = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("插入图片".into()),
        });
        self.images.task = Some(cx.spawn_in(window, async move |this, cx| {
            let result = prompt.await;
            let _ = this.update_in(cx, |this, window, cx| match result {
                Ok(Ok(Some(paths))) => this.import_images(
                    paths.into_iter().map(ImageInput::File).collect(),
                    None,
                    window,
                    cx,
                ),
                Ok(Ok(None)) => {}
                _ => {
                    this.error = Some("无法打开图片选择器".into());
                    cx.notify();
                }
            });
        }));
    }
    pub(super) fn paste_images(
        &mut self,
        item: &ClipboardItem,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let inputs = item
            .entries()
            .iter()
            .flat_map(|entry| match entry {
                ClipboardEntry::Image(image) => vec![ImageInput::Bytes(
                    format!("clipboard.{}", image.format().extension()),
                    image.bytes().to_vec(),
                )],
                ClipboardEntry::ExternalPaths(paths) => {
                    paths.0.iter().cloned().map(ImageInput::File).collect()
                }
                _ => vec![],
            })
            .collect::<Vec<_>>();
        if inputs.is_empty() {
            false
        } else {
            self.import_images(inputs, None, window, cx);
            true
        }
    }
    pub(super) fn import_images(
        &mut self,
        inputs: Vec<ImageInput>,
        replace: Option<ImageScope>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.images.importing
            || self.saving
            || self.is_composing()
            || self.source_composing(window, cx)
        {
            self.error = Some("请等待当前输入或保存完成后插入图片".into());
            cx.notify();
            return;
        }
        let Some(save) = self.state.save.as_ref() else {
            self.error = Some("请先打开已保存的笔记".into());
            cx.notify();
            return;
        };
        if save.retry_needed() {
            self.error = Some("请先解决当前保存问题".into());
            cx.notify();
            return;
        }
        let (epoch, document, generation) = (
            save.epoch(),
            save.base().id().clone(),
            self.state.editor.document().generation(),
        );
        if replace
            .as_ref()
            .is_some_and(|scope| scope.document != document || scope.revision != save.base().head())
        {
            self.error = Some("图片版本已变化，请重新打开后操作".into());
            cx.notify();
            return;
        }
        let replacing = replace
            .as_ref()
            .and_then(|scope| self.images.staged.get(&scope.resource));
        let staged_count = self.images.staged.len() - usize::from(replacing.is_some());
        if staged_count + inputs.len() > 32 {
            self.error = Some("待保存及撤销保留的图片最多 32 张".into());
            cx.notify();
            return;
        }
        let staged_bytes = self
            .images
            .staged
            .values()
            .map(|(_, bytes)| bytes.len())
            .sum::<usize>()
            - replacing.map_or(0, |(_, bytes)| bytes.len());
        let head = self.state.head;
        let anchor = self.state.anchor;
        self.images.importing = true;
        self.images.cancel = Arc::new(AtomicBool::new(false));
        let cancel = self.images.cancel.clone();
        self.images.task = Some(cx.spawn_in(window, async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    use std::io::Read;
                    if inputs.is_empty() || inputs.len() > 32 {
                        return Err("每次可插入 1–32 张图片".to_string());
                    }
                    let mut total = staged_bytes;
                    let mut prepared = vec![];
                    for input in inputs {
                        let (name, bytes) = match input {
                            ImageInput::Bytes(name, bytes) => (name, bytes),
                            ImageInput::File(path) => {
                                let file =
                                    std::fs::File::open(&path).map_err(|_| "无法读取图片文件")?;
                                let meta = file.metadata().map_err(|_| "无法读取图片信息")?;
                                if !meta.is_file() || meta.len() > codec::MAX_BYTES as u64 {
                                    return Err("图片为空、不是文件或超过 50 MiB 上限".into());
                                }
                                let mut bytes = vec![];
                                file.take(codec::MAX_BYTES as u64 + 1)
                                    .read_to_end(&mut bytes)
                                    .map_err(|_| "图片读取失败")?;
                                (
                                    path.file_name()
                                        .unwrap_or_default()
                                        .to_string_lossy()
                                        .to_string(),
                                    bytes,
                                )
                            }
                        };
                        total += bytes.len();
                        if total > 100 * 1024 * 1024 {
                            return Err("本次图片总大小超过 100 MiB".into());
                        }
                        codec::preview(&bytes, 640, &cancel)?;
                        let hash = format!("{:x}", Sha256::digest(&bytes));
                        prepared.push((name, Arc::new(bytes), hash));
                    }
                    Ok(prepared)
                })
                .await;
            let result = result.map(|prepared| {
                prepared
                    .into_iter()
                    .map(|(name, bytes, hash)| {
                        (
                            replace.as_ref().map_or_else(Uuid::new_v4, |s| s.resource),
                            name,
                            bytes,
                            hash,
                        )
                    })
                    .collect::<Vec<_>>()
            });
            let _ = this
                .update_in(cx, |this, window, cx| {
                    this.images.importing = false;
                    let current = this.state.save.as_ref().is_some_and(|s| s.epoch() == epoch)
                        && this.state.editor.document().generation() == generation
                        && this.state.head == head
                        && this.state.anchor == anchor
                        && !this.is_composing();
                    match result {
                        Ok(uploaded) if current => {
                            if replace.is_none() {
                                let body = uploaded
                                    .iter()
                                    .map(|(id, name, _, _)| {
                                        anynote_editor::image::markdown(&id.to_string(), name)
                                            .unwrap()
                                    })
                                    .collect::<Vec<_>>()
                                    .join("\n\n");
                                if let Err(error) = this.state.paste(&body, true) {
                                    this.error = Some(error);
                                    cx.notify();
                                    return false;
                                }
                            }
                            for (resource, name, bytes, hash) in uploaded {
                                this.state
                                    .save
                                    .as_mut()
                                    .unwrap()
                                    .stage_resource(resource, hash);
                                this.images.staged.insert(resource, (name, bytes));
                            }
                            this.changed(Ok(()), window, cx);
                            this.sync_source(window, cx);
                            this.flush(window, cx);
                            true
                        }
                        Ok(_) => {
                            this.error = Some("插入位置已变化，请重新插入图片".into());
                            cx.notify();
                            false
                        }
                        Err(error) => {
                            this.error = Some(error);
                            cx.notify();
                            false
                        }
                    }
                })
                .unwrap_or(false);
        }));
        cx.notify();
    }
    pub(super) fn render_image_status(&self, cx: &mut Context<Self>) -> AnyElement {
        if !self.images.importing {
            return div().into_any_element();
        }
        div()
            .flex()
            .gap_2()
            .px_4()
            .py_2()
            .child("正在准备图片")
            .child(
                Button::new("cancel-image-import")
                    .small()
                    .label("取消")
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.images.cancel.store(true, Ordering::Relaxed);
                        this.images.task = None;
                        this.images.importing = false;
                        this.flush(window, cx);
                        cx.notify();
                    })),
            )
            .into_any_element()
    }
    fn scope(&self, resource: Uuid) -> Option<ImageScope> {
        let base = self.state.save.as_ref()?.base();
        Some(ImageScope {
            document: base.id().clone(),
            revision: base.head(),
            resource,
        })
    }
    pub(super) fn render_image_block(
        &mut self,
        ix: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let leaf = &self.state.projection.leaves[ix];
        let block = leaf.id.block?;
        let parsed = anynote_editor::image::parse(&self.source()[leaf.span.clone()])?;
        let resource = Uuid::parse_str(&parsed.resource).ok()?;
        let key = self.keys[ix];
        let (image, saved) =
            self.render_resource_preview(resource, parsed.alt, parsed.width, window, cx)?;
        Some(
            div()
                .id(("image-block", key))
                .flex()
                .flex_col()
                .gap_2()
                .px_6()
                .py_2()
                .child(image)
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .child(
                            Button::new(("open-image", key))
                                .small()
                                .label("查看图片")
                                .disabled(!saved)
                                .on_click(cx.listener(move |this, _, w, cx| {
                                    this.open_image(resource, w, cx)
                                })),
                        )
                        .child(
                            Button::new(("resize-image", key))
                                .small()
                                .label("显示宽度…")
                                .on_click(cx.listener(move |this, _, w, cx| {
                                    this.resize_image(block, w, cx)
                                })),
                        )
                        .child(
                            Button::new(("copy-image-source", key))
                                .small()
                                .ghost()
                                .label("复制图片源码")
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if let Some(block) = this.state.editor.document().block(block) {
                                        cx.write_to_clipboard(ClipboardItem::new_string(
                                            this.source()[block.span()].into(),
                                        ));
                                    }
                                })),
                        ),
                )
                .into_any_element(),
        )
    }
    pub(super) fn render_resource_preview(
        &mut self,
        resource: Uuid,
        alt: String,
        width: Option<u32>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<(AnyElement, bool)> {
        let scope = self.scope(resource)?;
        let saved = self
            .state
            .save
            .as_ref()?
            .base()
            .resources()
            .contains_key(&resource);
        let cache = self
            .images
            .cache
            .get(&resource)
            .filter(|image| image.read(cx).scope() == &scope)
            .cloned();
        let preview = self.images.previews.contains(&resource) || self.images.previews.len() < 8;
        if preview {
            self.images.previews.insert(resource);
        }
        if preview && cache.is_none() && saved && self.images.queued.insert(resource) {
            let owner = cx.weak_entity();
            let alt = alt.clone();
            window.on_next_frame(move |window, cx| {
                let _ = owner.update(cx, |this, cx| {
                    this.images.queued.remove(&resource);
                    if !this.images.previews.contains(&resource)
                        || this.scope(resource).as_ref() != Some(&scope)
                    {
                        return;
                    }
                    let Some(client) = cx
                        .try_global::<BackendSession>()
                        .map(|s| s.client().clone())
                    else {
                        return;
                    };
                    if this.images.cache.len() >= 8
                        && let Some(old) = this
                            .images
                            .cache
                            .keys()
                            .find(|id| !this.images.previews.contains(id))
                            .copied()
                        && let Some(image) = this.images.cache.remove(&old)
                    {
                        this.images.observations.remove(&old);
                        image.update(cx, |v, cx| v.close(window, cx));
                    }
                    let image = cx.new(|cx| ImageView::new(scope, client, true, alt, window, cx));
                    let subscription = cx.observe_in(&image, window, |this, _, _, cx| {
                        this.layout.remeasure();
                        cx.notify();
                    });
                    this.images.observations.insert(resource, subscription);
                    this.images.cache.insert(resource, image);
                    cx.notify();
                });
            });
        }
        let (natural_width, natural_height) = cache
            .as_ref()
            .and_then(|view| view.read(cx).dimensions())
            .unwrap_or((320, 200));
        // Persisted image width is document geometry, independent of chrome spacing.
        let image = div()
            .w(px(width.unwrap_or(natural_width) as f32))
            .max_w_full()
            .aspect_ratio(natural_width as f32 / natural_height as f32);
        let image = if let Some(view) = cache {
            image.child(view)
        } else {
            image.child(if saved && !preview {
                "打开查看图片"
            } else if saved {
                "正在读取图片"
            } else {
                "图片等待保存"
            })
        };
        Some((image.into_any_element(), saved))
    }
    pub(super) fn open_image(
        &mut self,
        resource: Uuid,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(scope) = self.scope(resource) else {
            return;
        };
        let Some(client) = cx
            .try_global::<BackendSession>()
            .map(|s| s.client().clone())
        else {
            return;
        };
        self.close_image(window, cx);
        let image = cx.new(|cx| ImageView::new(scope, client, false, "图片".into(), window, cx));
        self.images.subscription = Some(cx.subscribe_in(
            &image,
            window,
            |this, _, version: &ImageVersion, window, cx| {
                this.import_images(
                    vec![ImageInput::Bytes(
                        "rotated.png".into(),
                        (*version.bytes).clone(),
                    )],
                    Some(version.scope.clone()),
                    window,
                    cx,
                );
            },
        ));
        image.focus_handle(cx).focus(window, cx);
        self.images.active = Some(image);
        cx.notify();
    }
    pub(super) fn close_image(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(image) = self.images.active.take() {
            image.update(cx, |v, cx| v.close(window, cx));
        }
        self.images.subscription = None;
        self.focus.focus(window, cx);
        cx.notify();
    }
    pub(super) fn images_saved(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(base) = self.state.save.as_ref().map(|s| s.base().clone()) else {
            return;
        };
        let released = self
            .images
            .staged
            .keys()
            .filter(|id| base.resources().contains_key(id))
            .copied()
            .collect::<Vec<_>>();
        for id in &released {
            self.images.staged.remove(id);
        }
        self.images.observations.clear();
        for (_, image) in self.images.cache.drain() {
            image.update(cx, |v, cx| v.close(window, cx));
        }
        if let Some(resource) = self
            .images
            .active
            .as_ref()
            .map(|v| v.read(cx).scope().resource)
        {
            self.open_image(resource, window, cx);
        }
    }
    fn resize_image(
        &mut self,
        block: anynote_editor::model::BlockId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let generation = self.state.editor.document().generation();
        let width = self
            .state
            .editor
            .document()
            .block(block)
            .and_then(|b| anynote_editor::image::parse(&self.source()[b.span()]))
            .and_then(|i| i.width);
        let input = cx.new(|cx| {
            InputState::new(window, cx)
                .default_value(width.map(|n| n.to_string()).unwrap_or_default())
                .placeholder("自适应")
        });
        let owner = cx.weak_entity();
        window.open_dialog(cx, move |dialog, _, _| {
            let input = input.clone();
            let owner = owner.clone();
            dialog
                .title("图片显示宽度")
                .child(div().child("32–4096 像素，留空为自适应"))
                .child(
                    Input::new(&input)
                        .id("image-width-input")
                        .aria_label("图片宽度"),
                )
                .footer(
                    DialogFooter::new()
                        .child(DialogClose::new().trigger(|b| b.label("取消")))
                        .child(
                            DialogAction::new()
                                .child(Button::new("apply-image-width").primary().label("应用")),
                        ),
                )
                .on_ok(move |_, window, cx| {
                    let value = input.read(cx).value().to_string();
                    owner
                        .update(cx, |this, cx| {
                            let result = (|| {
                                if generation != this.state.editor.document().generation() {
                                    return Err("图片块已变化，请重新打开".into());
                                }
                                let width = if value.trim().is_empty() {
                                    None
                                } else {
                                    Some(
                                        value
                                            .trim()
                                            .parse::<u32>()
                                            .map_err(|_| "宽度须为 32–4096 整数")?,
                                    )
                                };
                                let tx = anynote_editor::image::resize(
                                    this.state.editor.document(),
                                    block,
                                    width,
                                    this.state.millis(),
                                )
                                .map_err(|_| "宽度须为 32–4096 整数")?;
                                this.state.apply(tx)
                            })();
                            let done = result.is_ok();
                            this.changed(result, window, cx);
                            done
                        })
                        .unwrap_or(true)
                })
        });
    }
}
