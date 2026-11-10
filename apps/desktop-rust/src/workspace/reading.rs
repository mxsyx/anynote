use super::*;
use anynote_editor::{
    builtin::{BuiltinBlock, Presentation},
    model::Document,
};
use gpui_kit::component::{
    collapsible::Collapsible,
    text::{MarkdownExtensions, MarkdownNode, markdown_ast},
};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

const BLOCK: &str = "anynote-reading-block";

// This projection is never saved. JSON strings keep arbitrary source fences inert.
pub(super) fn project(source: &str) -> String {
    let mut output = String::with_capacity(source.len());
    let mut offset = 0;
    for segment in anynote_core::protocol::markdown::parse_blocks(source) {
        let span = segment.span();
        output.push_str(&source[offset..span.start]);
        let raw = &source[span.clone()];
        if segment.directive().is_some() {
            if let Some(image) = anynote_editor::image::parse(raw) {
                output.push_str(
                    &anynote_editor::image::markdown(&image.resource, &image.alt)
                        .unwrap_or_default(),
                );
            } else {
                if let Some(board) = anynote_core::board::parse(raw)
                    && let Some(preview) = board.preview()
                {
                    output.push_str(&format!("![白板预览](anynote-resource:{preview})\n\n"));
                }
                output.push_str(&format!(
                    "\n```{BLOCK}\n{}\n```\n",
                    serde_json::to_string(raw).unwrap()
                ));
            }
        } else {
            output.push_str(raw);
        }
        offset = span.end;
    }
    output.push_str(&source[offset..]);
    output
}

pub(super) fn extensions(owner: WeakEntity<Workspace>) -> MarkdownExtensions {
    MarkdownExtensions::default()
        .block_parser(|node, _| {
            let markdown_ast::Node::Code(code) = node else {
                return None;
            };
            if code.lang.as_deref() != Some(BLOCK) {
                return None;
            }
            let source = serde_json::from_str::<String>(&code.value).ok()?;
            let document = Document::new(source.clone());
            let block = document.blocks().first()?;
            let builtin = BuiltinBlock::read(&document, block.id());
            let label = builtin
                .as_ref()
                .map(|b| {
                    b.fields()
                        .iter()
                        .map(|f| f.value())
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_else(|| source.clone());
            Some(MarkdownNode::new(BLOCK, (source, builtin)).text(label))
        })
        .block_renderer(BLOCK, move |node, window, cx| {
            let Some((source, builtin)) = node.data::<(String, Option<BuiltinBlock>)>() else {
                return div().into_any_element();
            };
            if let Some(builtin) = builtin {
                let fields = div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .children(builtin.fields().iter().map(|f| {
                        div()
                            .child(
                                div()
                                    .text_sm()
                                    .text_color(cx.theme().muted_foreground)
                                    .child(f.label()),
                            )
                            .child(f.value().to_owned())
                    }));
                let panel = div()
                    .p_3()
                    .border_l_4()
                    .border_color(cx.theme().border)
                    .bg(cx.theme().secondary);
                if builtin.presentation() == Presentation::Details {
                    let key = SharedString::from(format!("details-{}", source));
                    let state = window.use_keyed_state(key.clone(), cx, |_, _| false);
                    let open = *state.read(cx);
                    return panel
                        .child(
                            Collapsible::new()
                                .open(open)
                                .child(
                                    Button::new(key)
                                        .ghost()
                                        .label(if open { "收起详情" } else { "展开详情" })
                                        .on_click(move |_, window, cx| {
                                            state.update(cx, |open, cx| {
                                                *open = !*open;
                                                cx.notify();
                                            });
                                            window.refresh();
                                        }),
                                )
                                .content(fields),
                        )
                        .into_any_element();
                }
                return panel.child(fields).into_any_element();
            }
            let label = if anynote_core::board::parse(source).is_some() {
                "白板 · 打开交互视图"
            } else {
                let document = Document::new(source.clone());
                if document
                    .blocks()
                    .first()
                    .and_then(|b| anynote_editor::video::read(&document, b.id()))
                    .is_some()
                {
                    "视频 · 打开播放卡片"
                } else {
                    "扩展块 · 查看原始内容"
                }
            };
            let unknown = label.starts_with("扩展块");
            let history = owner
                .upgrade()
                .is_some_and(|v| v.read(cx).revision.is_some());
            let owner = owner.clone();
            div()
                .p_3()
                .border_1()
                .border_color(cx.theme().border)
                .child(
                    Button::new(SharedString::from(format!(
                        "read-block-{}",
                        node.source_range().map_or(0, |r| r.start)
                    )))
                    .label(label)
                    .disabled(history)
                    .on_click(move |_, window, cx| {
                        let _ = owner.update(cx, |this, cx| this.edit(window, cx));
                    }),
                )
                .when(unknown, |view| view.child(source.clone()))
                .into_any_element()
        })
}

struct Thumbnail {
    result: Option<Result<Arc<RenderImage>, ImageCacheError>>,
    _task: Task<()>,
    _release: Subscription,
}
impl Thumbnail {
    fn new(
        scope: anynote_core::image::ImageScope,
        client: BackendClient,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let cancel = Arc::new(AtomicBool::new(false));
        let release = cx.on_release({
            let cancel = cancel.clone();
            move |this: &mut Self, cx| {
                cancel.store(true, Ordering::Relaxed);
                if let Some(Ok(image)) = this.result.take() {
                    cx.drop_image(image, None);
                }
            }
        });
        let task = cx.spawn_in(window, async move |this, cx| {
            let result = async {
                let (_, bytes) = crate::image::service::read(&client, &scope, &cancel).await?;
                cx.background_executor()
                    .spawn(async move {
                        crate::image::codec::preview(&bytes, 640, &cancel)
                            .map(|p| crate::image::texture(p.pixels))
                    })
                    .await
            }
            .await
            .map_err(|error: String| ImageCacheError::Asset(error.into()));
            let _ = this.update_in(cx, |this, window, cx| {
                this.result = Some(result);
                cx.notify();
                window.refresh();
            });
        });
        Self {
            result: None,
            _task: task,
            _release: release,
        }
    }
}
pub(super) fn image_source(
    uri: &SharedUri,
    scope: Option<(DocumentId, Uuid)>,
    client: Option<BackendClient>,
) -> ImageSource {
    let resource = uri
        .as_ref()
        .strip_prefix("anynote-resource:")
        .and_then(|s| Uuid::parse_str(s).ok());
    ImageSource::Custom(Arc::new(move |window, cx| {
        let (Some(resource), Some((document, revision)), Some(client)) =
            (resource, &scope, &client)
        else {
            return Some(Err(ImageCacheError::Asset(
                "图片未本地化或资源不可用".into(),
            )));
        };
        let scope = anynote_core::image::ImageScope {
            document: document.clone(),
            revision: *revision,
            resource,
        };
        let key = SharedString::from(format!(
            "read-image-{}-{}-{}",
            document.note(),
            revision,
            resource
        ));
        let state = window.use_keyed_state(key, cx, |window, cx| {
            Thumbnail::new(scope, client.clone(), window, cx)
        });
        state.read(cx).result.clone()
    }))
}

impl Workspace {
    pub(super) fn set_reading_text(&mut self, source: &str, cx: &mut Context<Self>) {
        self.pending_anchor = None;
        self.pending_position = None;
        let projected = project(source);
        self.reader.update(cx, |reader, cx| {
            reader.set_text("", cx);
            reader.set_text(&projected, cx);
        });
    }
    pub(super) fn restore_reading_target(&mut self, cx: &mut Context<Self>) {
        if let Some(anchor) = self.pending_anchor.clone() {
            let text = self.reader.read(cx).rendered_text();
            if let Some(start) = text.as_str().find(&anchor) {
                self.pending_anchor = None;
                self.pending_position = None;
                self.status.clear();
                self.reader.update(cx, |reader, cx| {
                    let _ = reader.reveal_range(start..start + anchor.len(), cx);
                });
                cx.notify();
            }
        } else if self.reader.read(cx).list_state().item_count() > 0
            && let Some(position) = self.pending_position.take()
        {
            let list = self.reader.read(cx).list_state();
            list.scroll_to(ListOffset {
                item_ix: position.block.min(list.item_count() - 1),
                offset_in_item: px(position.offset),
            });
            cx.notify();
        }
    }
}
