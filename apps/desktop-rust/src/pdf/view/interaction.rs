use super::*;
use crate::pdf::{index, search, selection, service};
use anynote_core::{
    backend::{Command, Reply},
    pdf::*,
};
use std::ops::Range;
use uuid::Uuid;

pub(super) struct Reading {
    pub(super) password: String,
    pub(super) query: Entity<InputState>,
    pub(super) comment: Entity<InputState>,
    pub(super) selection: Option<Range<usize>>,
    pub(super) drag: Option<usize>,
    pub(super) destination: Option<Bounds<Pixels>>,
    pub(super) annotations: Vec<PdfAnnotation>,
    pub(super) current: bool,
    pub(super) focused: Option<Uuid>,
    pub(super) pending_anchor: Option<PdfAnchor>,
    pub(super) status: String,
    pub(super) working: bool,
    pub(super) operation: Option<Task<()>>,
    pub(super) index_job: Option<index::IndexJob>,
    pub(super) index_task: Option<Task<()>>,
    pub(super) search_job: Option<search::SearchJob>,
    pub(super) search_task: Option<Task<()>>,
    pub(super) hits: Vec<selection::SearchHit>,
    pub(super) hit: usize,
    pending_hit: bool,
    center_pending: bool,
    pub(super) search_status: String,
    pub(super) annotation_page: usize,
}
impl Reading {
    pub(super) fn new(window: &mut Window, cx: &mut Context<PdfView>) -> Self {
        Self {
            password: String::new(),
            query: cx.new(|cx| InputState::new(window, cx)),
            comment: cx.new(|cx| InputState::new(window, cx).placeholder("内容（可选）")),
            selection: None,
            drag: None,
            destination: None,
            annotations: vec![],
            current: false,
            focused: None,
            pending_anchor: None,
            status: String::new(),
            working: false,
            operation: None,
            index_job: None,
            index_task: None,
            search_job: None,
            search_task: None,
            hits: vec![],
            hit: 0,
            pending_hit: false,
            center_pending: false,
            search_status: String::new(),
            annotation_page: 0,
        }
    }
    pub(super) fn stop(&mut self) {
        self.index_job = None;
        self.search_job = None;
        self.index_task = None;
        self.search_task = None;
        self.operation = None;
        self.working = false;
        self.selection = None;
        self.drag = None;
        self.destination = None;
        self.password.clear();
    }
}
impl PdfView {
    pub fn selected_text(&self) -> Option<String> {
        self.draft(String::new()).map(|d| d.quote().to_owned())
    }
    pub fn annotations(&self) -> &[PdfAnnotation] {
        &self.reading.annotations
    }
    pub fn is_indexing(&self) -> bool {
        self.reading.index_job.is_some()
    }
    pub fn reading_status(&self) -> &str {
        &self.reading.status
    }
    pub fn page_bounds(&self) -> Option<Bounds<Pixels>> {
        self.reading.destination
    }
    pub(super) fn draft(&self, body: String) -> Option<AnnotationDraft> {
        Some(selection::select(
            self.raster.as_ref()?,
            self.reading.selection.clone()?,
            body,
        ))
    }
    fn point(&self, p: Point<Pixels>) -> Option<[f64; 2]> {
        let b = self.reading.destination?;
        if !b.contains(&p) {
            return None;
        }
        Some([
            f64::from((p.x - b.origin.x) / b.size.width),
            f64::from((p.y - b.origin.y) / b.size.height),
        ])
    }
    pub(super) fn selection_start(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.focus.focus(window, cx);
        if let Some((raster, point)) = self.raster.as_ref().zip(self.point(event.position))
            && let Some(ix) = selection::hit(raster, point)
        {
            self.reading.focused = None;
            self.reading.drag = Some(ix);
            self.reading.selection = Some(ix..ix + 1);
            cx.notify();
        }
    }
    pub(super) fn selection_move(
        &mut self,
        event: &MouseMoveEvent,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if event.pressed_button != Some(MouseButton::Left) {
            self.reading.drag = None;
            return;
        }
        if let Some((anchor, (raster, point))) = self
            .reading
            .drag
            .zip(self.raster.as_ref().zip(self.point(event.position)))
            && let Some(ix) = selection::hit(raster, point)
        {
            self.reading.selection = Some(anchor.min(ix)..anchor.max(ix) + 1);
            cx.notify();
        }
    }
    pub(super) fn reading_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let secondary = if cfg!(target_os = "macos") {
            event.keystroke.modifiers.platform
        } else {
            event.keystroke.modifiers.control
        };
        match event.keystroke.key.as_str() {
            "a" if secondary => {
                if let Some(r) = &self.raster {
                    self.reading.selection = Some(0..r.glyphs().len());
                }
            }
            "c" if secondary => {
                if let Some(text) = self.selected_text() {
                    cx.write_to_clipboard(ClipboardItem::new_string(text));
                }
            }
            "f" if secondary => {
                self.reading.query.focus_handle(cx).focus(window, cx);
            }
            "left" | "right" if event.keystroke.modifiers.shift => {
                if let Some(r) = &self.raster {
                    let range = self.reading.selection.get_or_insert(0..0);
                    if event.keystroke.key == "right" {
                        range.end = (range.end + 1).min(r.glyphs().len());
                    } else {
                        range.end = range.end.saturating_sub(1).max(range.start);
                    }
                }
            }
            "escape" if self.reading.search_job.is_some() || self.reading.index_job.is_some() => {
                self.cancel_reading(cx);
            }
            "escape" => {
                self.reading.selection = None;
                self.reading.focused = None;
            }
            _ => return false,
        }
        cx.notify();
        true
    }
    pub(super) fn paint_annotations(
        &self,
        destination: Bounds<Pixels>,
        window: &mut Window,
        cx: &App,
    ) {
        let paint = |r: &anynote_core::image::ImageRect, selected: bool, window: &mut Window| {
            let b = Bounds::new(
                point(
                    destination.origin.x + destination.size.width * r.x as f32,
                    destination.origin.y + destination.size.height * r.y as f32,
                ),
                size(
                    destination.size.width * r.width as f32,
                    destination.size.height * r.height as f32,
                ),
            );
            let color = if selected {
                cx.theme().info
            } else {
                cx.theme().warning
            };
            window.paint_quad(fill(b, color.opacity(0.25)));
            if selected {
                window.paint_quad(outline(b, color, BorderStyle::Solid));
            }
        };
        for a in self
            .reading
            .annotations
            .iter()
            .filter(|a| a.hash() == self.hash && a.draft().page() == self.page + 1)
        {
            for r in a.draft().rectangles() {
                paint(r, self.reading.focused == Some(a.id()), window);
            }
        }
        if let Some(draft) = self.draft(String::new()) {
            for r in draft.rectangles() {
                paint(r, true, window);
            }
        }
    }
    pub(super) fn load_annotations(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.mutate(
            PdfCommand::Load {
                scope: self.scope.clone(),
                hash: self.hash.clone(),
            },
            window,
            cx,
        );
    }
    pub(super) fn mutate(
        &mut self,
        command: PdfCommand,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.reading.working || self.closed {
            return;
        }
        self.reading.working = true;
        let client = self.client.clone();
        let scope = self.scope.clone();
        let hash = self.hash.clone();
        self.reading.operation = Some(cx.spawn_in(window, async move |this, cx| {
            let result = async {
                let reply = service::request(&client, command).await?;
                let loaded = service::request(&client, PdfCommand::Load { scope, hash }).await?;
                Ok::<_, String>((reply, loaded))
            }
            .await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.reading.working = false;
                match result {
                    Ok((
                        reply,
                        PdfReply::Loaded {
                            annotations,
                            current,
                            coverage,
                        },
                    )) => {
                        this.reading.annotations = annotations;
                        this.reading.current = current;
                        if let Some(c) = coverage {
                            this.reading.status = c.message();
                        }
                        match reply {
                            PdfReply::Annotation { id } => {
                                this.reading.focused = Some(id);
                                this.reading.selection = None;
                                this.reading
                                    .comment
                                    .update(cx, |s, cx| s.set_value("", window, cx));
                            }
                            PdfReply::Note { document } => {
                                this.reading.status = "已创建阅读笔记".into();
                                this.open_reading_note(document, cx);
                            }
                            _ => {}
                        }
                        if let Some(anchor) = this.reading.pending_anchor.take() {
                            this.navigate(anchor, window, cx);
                        }
                    }
                    Ok(_) => this.reading.status = "PDF 服务响应无效".into(),
                    Err(error) => this.reading.status = format!("操作失败，可重试：{error}"),
                }
                cx.notify();
            });
        }));
        cx.notify();
    }
    fn open_reading_note(
        &self,
        document: anynote_core::document_session::DocumentId,
        cx: &mut Context<Self>,
    ) {
        let client = self.client.clone();
        cx.spawn(async move |_, cx| {
            let response = client.submit(
                Command::OpenDocument { id: document },
                std::time::Duration::from_secs(15),
            );
            if let Ok(handle) = response
                && let Ok(crate::backend_client::Response::Reply(Reply::Document(snapshot))) =
                    handle.receive().await
            {
                let _ = cx.update(|cx| crate::document_editor::open_document(snapshot, cx));
            }
        })
        .detach();
    }
    pub fn navigate(&mut self, anchor: PdfAnchor, window: &mut Window, cx: &mut Context<Self>) {
        if self.count == 0 || self.reading.working {
            self.reading.pending_anchor = Some(anchor);
            return;
        }
        match anchor {
            PdfAnchor::Page(page) if page > 0 && page <= self.count => {
                self.go(page - 1, window, cx)
            }
            PdfAnchor::Annotation(id) => {
                if let Some(a) = self.reading.annotations.iter().find(|a| a.id() == id) {
                    if a.hash() != self.hash {
                        self.reading.status = "此批注属于历史文件，请核对后显式重锚定".into();
                    } else if a.draft().page() <= self.count {
                        let page = a.draft().page();
                        self.go(page - 1, window, cx);
                        self.reading.focused = Some(id);
                        self.reading.center_pending = true;
                    }
                } else {
                    self.reading.status = "批注已删除或不可用".into();
                }
            }
            _ => self.reading.status = "回链页码超出当前 PDF 范围".into(),
        }
        cx.notify();
    }
    pub(super) fn annotate(&mut self, note: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(draft) = self.draft(self.reading.comment.read(cx).value().to_string()) else {
            return;
        };
        if !draft.is_valid() {
            self.reading.status = "选区过大或没有文字几何，请缩小选区".into();
            cx.notify();
            return;
        }
        let command = if note {
            PdfCommand::ReadingNote {
                scope: self.scope.clone(),
                hash: self.hash.clone(),
                draft,
                annotation: None,
            }
        } else {
            PdfCommand::Annotate {
                scope: self.scope.clone(),
                hash: self.hash.clone(),
                draft,
            }
        };
        self.mutate(command, window, cx);
    }
    pub(super) fn start_index(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.reading.index_job.is_some() || !self.reading.current {
            return;
        }
        let (job, receive) = index::run(
            self.client.clone(),
            self.scope.clone(),
            self.reading.password.clone(),
        );
        self.reading.index_job = Some(job);
        self.reading.status = "正在提取可搜索文本".into();
        self.reading.index_task = Some(cx.spawn_in(window, async move |this, cx| {
            let result = receive.recv().await.unwrap_or(Err(PdfError::Cancelled));
            let _ = this.update(cx, |this, cx| {
                this.reading.index_job = None;
                this.reading.status = match result {
                    Ok(c) => c.message(),
                    Err(e) => format!("索引未发布：{e}"),
                };
                cx.notify();
            });
        }));
        cx.notify();
    }
    pub(super) fn cancel_reading(&mut self, cx: &mut Context<Self>) {
        self.reading.index_job = None;
        self.reading.index_task = None;
        self.reading.search_job = None;
        self.reading.search_task = None;
        self.reading.status = "已取消文本任务".into();
        cx.notify();
    }
    pub(super) fn search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.reading.search_job = None;
        self.reading.search_task = None;
        self.reading.hits.clear();
        let query = self.reading.query.read(cx).value().trim().to_owned();
        if query.is_empty() {
            self.reading.search_status.clear();
            cx.notify();
            return;
        }
        if query.len() > 4000 {
            self.reading.search_status = "搜索词过长".into();
            cx.notify();
            return;
        }
        let (job, receive) = search::run(
            self.client.clone(),
            self.scope.clone(),
            self.reading.password.clone(),
            query,
        );
        self.reading.search_job = Some(job);
        self.reading.search_status = "正在搜索".into();
        self.reading.search_task = Some(cx.spawn_in(window, async move |this, cx| {
            let result = receive.recv().await.unwrap_or(Err(PdfError::Cancelled));
            let _ = this.update_in(cx, |this, window, cx| {
                this.reading.search_job = None;
                match result {
                    Ok((hits, partial)) => {
                        this.reading.search_status = format!(
                            "{} 处匹配{}",
                            hits.len(),
                            if partial {
                                " · 已达搜索预算，结果不完整"
                            } else {
                                ""
                            }
                        );
                        this.reading.hits = hits;
                        this.reading.hit = 0;
                        this.show_hit(window, cx);
                    }
                    Err(e) => this.reading.search_status = e.to_string(),
                };
                cx.notify();
            });
        }));
        cx.notify();
    }
    pub(super) fn show_hit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(hit) = self.reading.hits.get(self.reading.hit) {
            self.go(hit.page(), window, cx);
            self.reading.pending_hit = true;
            self.reading.center_pending = true;
        }
    }
    pub(super) fn apply_search_selection(&mut self) {
        if !self.reading.pending_hit {
            return;
        }
        self.reading.pending_hit = false;
        if let Some((raster, hit)) = self
            .raster
            .as_ref()
            .zip(self.reading.hits.get(self.reading.hit))
            && hit.page() == self.page
        {
            self.reading.selection = selection::utf16_selection(raster, hit.range());
        }
    }
    pub(super) fn center_focus(&mut self) {
        if !self.reading.center_pending {
            return;
        }
        self.reading.center_pending = false;
        let draft = self
            .reading
            .focused
            .and_then(|id| {
                self.reading
                    .annotations
                    .iter()
                    .find(|a| a.id() == id)
                    .map(|a| a.draft().clone())
            })
            .or_else(|| self.draft(String::new()));
        let Some(rect) = draft.as_ref().and_then(|d| d.rectangles().first()) else {
            return;
        };
        let size = self.natural().map(|v| v * self.scale());
        self.pan = [
            (self.viewport[0] / 2. - (rect.x + rect.width / 2.) as f32 * size[0])
                .clamp(-(size[0] - self.viewport[0]).max(0.), 0.),
            (self.viewport[1] / 2. - (rect.y + rect.height / 2.) as f32 * size[1])
                .clamp(-(size[1] - self.viewport[1]).max(0.), 0.),
        ];
    }
}
