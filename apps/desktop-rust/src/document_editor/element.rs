use super::*;
use gpui_kit::base::text::editor_host::{LeafGeometry, collect_leaf_geometry};
use std::ops::Range;

#[derive(Default)]
pub(super) struct GeometryFrame {
    pub leaves: HashMap<u64, LeafGeometry>,
    pub revision: u64,
    pub bounds: Bounds<Pixels>,
    pub rem: Pixels,
    pub scale: f32,
}
pub(super) struct EditorElement {
    child: Option<AnyElement>,
    owner: Entity<DocumentEditor>,
    frame: Rc<RefCell<GeometryFrame>>,
    revision: u64,
    decorations: HashMap<u64, Vec<(Range<usize>, Hsla)>>,
}
impl EditorElement {
    pub fn new(
        child: AnyElement,
        owner: Entity<DocumentEditor>,
        frame: Rc<RefCell<GeometryFrame>>,
        revision: u64,
        decorations: HashMap<u64, Vec<(Range<usize>, Hsla)>>,
    ) -> Self {
        Self {
            child: Some(child),
            owner,
            frame,
            revision,
            decorations,
        }
    }
}
impl IntoElement for EditorElement {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}
impl Element for EditorElement {
    type RequestLayoutState = AnyElement;
    type PrepaintState = ();
    fn id(&self) -> Option<ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }
    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, AnyElement) {
        let mut child = self.child.take().unwrap();
        (child.request_layout(window, cx), child)
    }
    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        child: &mut AnyElement,
        window: &mut Window,
        cx: &mut App,
    ) {
        let (_, leaves) = collect_leaf_geometry(std::mem::take(&mut self.decorations), || {
            child.prepaint(window, cx)
        });
        *self.frame.borrow_mut() = GeometryFrame {
            leaves,
            revision: self.revision,
            bounds,
            rem: window.rem_size(),
            scale: window.scale_factor(),
        };
        self.owner.update(cx, |view, cx| {
            view.reveal_inner_caret(window, cx);
            if view.drag_scroll_distance(window) != Pixels::ZERO {
                let owner = cx.weak_entity();
                window.on_next_frame(move |window, cx| {
                    let _ = owner.update(cx, |view, cx| view.advance_selection_drag(window, cx));
                });
            }
            if let Some(caret) = view.caret_bounds(window) {
                let anchor = point(caret.left(), caret.bottom() + window.rem_size() / 4.);
                if view.overlay_anchor != anchor {
                    view.overlay_anchor = anchor;
                    if view.slash.is_some() || !view.state.range().is_empty() {
                        let owner = cx.weak_entity();
                        window.on_next_frame(move |_, cx| {
                            let _ = owner.update(cx, |_, cx| cx.notify());
                        });
                    }
                }
            }
        });
    }
    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        child: &mut AnyElement,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        child.paint(window, cx);
        let owner = self.owner.clone();
        window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
            if phase == DispatchPhase::Bubble && owner.read(cx).dragging_selection {
                owner.update(cx, |view, cx| view.mouse_move(event, window, cx));
            }
        });
        let view = self.owner.read(cx);
        if view.focus.is_focused(window) {
            if view.state.range().is_empty()
                && let Some(caret) = view.caret_bounds(window)
                && bounds.intersects(&caret)
            {
                // Caret thickness is one physical device pixel, independent of UI zoom.
                let (ix, _) = view.state.projection.at(view.state.head);
                let clip = view.leaf_viewport(ix, bounds);
                if caret.intersects(&clip) {
                    window.paint_quad(fill(caret.intersect(&clip), cx.theme().foreground));
                }
            }
            window.handle_input(
                &view.focus,
                ElementInputHandler::new(bounds, self.owner.clone()),
                cx,
            );
        }
    }
}
impl DocumentEditor {
    fn leaf_viewport(&self, ix: usize, bounds: Bounds<Pixels>) -> Bounds<Pixels> {
        if let Some(scroll) = self.code_scroll.get(&self.keys[ix]) {
            return bounds.intersect(&scroll.bounds());
        }
        let row = &self.state.projection.rows[self.state.projection.row_for(ix)];
        if let Some((block, path, ..)) = &row.table
            && let Some(scroll) = self.table_scroll.get(&(*block, path.clone()))
        {
            let viewport = scroll.bounds();
            return bounds.intersect(&Bounds::new(
                point(viewport.left(), bounds.top()),
                size(viewport.size.width, bounds.size.height),
            ));
        }
        bounds
    }
    fn reveal_inner_caret(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.reveal_selection {
            return;
        }
        let Some(caret) = self.caret_bounds(window) else {
            return;
        };
        self.reveal_selection = false;
        let (ix, _) = self.state.projection.at(self.state.head);
        let row = &self.state.projection.rows[self.state.projection.row_for(ix)];
        let scroll = self
            .code_scroll
            .get(&self.keys[ix])
            .map(|scroll| (scroll, Axis::Vertical))
            .or_else(|| {
                row.table.as_ref().and_then(|(block, path, ..)| {
                    self.table_scroll
                        .get(&(*block, path.clone()))
                        .map(|scroll| (scroll, Axis::Horizontal))
                })
            });
        let Some((scroll, axis)) = scroll else {
            return;
        };
        let bounds = scroll.bounds();
        let mut offset = scroll.offset();
        let original = offset;
        match axis {
            Axis::Vertical => {
                if caret.top() < bounds.top() {
                    offset.y += bounds.top() - caret.top();
                } else if caret.bottom() > bounds.bottom() {
                    offset.y -= caret.bottom() - bounds.bottom();
                }
                offset.y = offset.y.clamp(-scroll.max_offset().y, Pixels::ZERO);
            }
            Axis::Horizontal => {
                if caret.left() < bounds.left() {
                    offset.x += bounds.left() - caret.left();
                } else if caret.right() > bounds.right() {
                    offset.x -= caret.right() - bounds.right();
                }
                offset.x = offset.x.clamp(-scroll.max_offset().x, Pixels::ZERO);
            }
        }
        if offset != original {
            scroll.set_offset(offset);
            let owner = cx.weak_entity();
            window.on_next_frame(move |_, cx| {
                let _ = owner.update(cx, |_, cx| cx.notify());
            });
        }
    }
    pub(super) fn decorations(&self, cx: &App) -> HashMap<u64, Vec<(Range<usize>, Hsla)>> {
        let range = self.state.range();
        self.state
            .projection
            .leaves
            .iter()
            .enumerate()
            .filter_map(|(ix, leaf)| {
                let start = range.start.max(leaf.logical.start);
                let end = range.end.min(leaf.logical.end);
                (start < end).then(|| {
                    (
                        self.keys[ix],
                        vec![(
                            start - leaf.logical.start..end - leaf.logical.start,
                            cx.theme().selection,
                        )],
                    )
                })
            })
            .collect()
    }
    pub(super) fn geometry_valid(&self, window: &Window) -> bool {
        let frame = self.geometry.borrow();
        frame.revision == self.view_revision
            && frame.rem == window.rem_size()
            && frame.scale == window.scale_factor()
    }
    pub(super) fn caret_bounds(&self, window: &Window) -> Option<Bounds<Pixels>> {
        if !self.geometry_valid(window) {
            return None;
        }
        let (ix, byte) = if let Some(c) = &self.state.composition {
            (
                c.leaf,
                c.local.start + self.state.editor.composition()?.selection().end,
            )
        } else {
            self.state.projection.at(self.state.head)
        };
        let frame = self.geometry.borrow();
        let geometry = frame.leaves.get(&self.keys[ix])?;
        let point = geometry.position_for_index(byte);
        Some(Bounds::new(
            point,
            size(px(1. / window.scale_factor()), geometry.caret_height()),
        ))
    }
    pub(super) fn hit(&self, point: Point<Pixels>, window: &Window) -> Option<usize> {
        if !self.geometry_valid(window) {
            return None;
        }
        let frame = self.geometry.borrow();
        let (ix, geometry) = self
            .keys
            .iter()
            .enumerate()
            .filter_map(|(ix, key)| {
                let geometry = frame.leaves.get(key)?;
                let bounds = geometry
                    .bounds()
                    .intersect(&self.leaf_viewport(ix, frame.bounds));
                (bounds.size.width > Pixels::ZERO && bounds.size.height > Pixels::ZERO)
                    .then_some((ix, geometry, bounds))
            })
            .min_by(|(_, _, a), (_, _, b)| {
                let distance = |bounds: &Bounds<Pixels>| {
                    let dy = (bounds.top() - point.y)
                        .max(point.y - bounds.bottom())
                        .max(px(0.));
                    let dx = (bounds.left() - point.x)
                        .max(point.x - bounds.right())
                        .max(px(0.));
                    (dy.as_f32(), dx.as_f32())
                };
                distance(a)
                    .partial_cmp(&distance(b))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(ix, geometry, _)| (ix, geometry))?;
        Some(self.state.projection.leaves[ix].logical.start + geometry.index_for_position(point))
    }
    pub(super) fn mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.source.is_some() || self.is_composing() {
            return;
        }
        let Some(at) = self.hit(event.position, window) else {
            return;
        };
        self.focus.focus(window, cx);
        self.dragging_selection = true;
        self.drag_position = Some(event.position);
        let (anchor, head) = if event.click_count >= 3 {
            let (ix, _) = self.state.projection.at(at);
            let leaf = &self.state.projection.leaves[ix];
            (leaf.logical.start, leaf.logical.end)
        } else if event.click_count == 2 {
            use unicode_segmentation::UnicodeSegmentation;
            self.text()
                .split_word_bound_indices()
                .find(|(ix, w)| *ix <= at && at < ix + w.len())
                .map_or((at, at), |(ix, w)| (ix, ix + w.len()))
        } else {
            (
                if event.modifiers.shift {
                    self.state.anchor
                } else {
                    at
                },
                at,
            )
        };
        let result = self.state.select(anchor, head);
        self.changed(result, window, cx);
        self.slash = None;
    }
    pub(super) fn mouse_move(
        &mut self,
        event: &MouseMoveEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if cx.has_active_drag() {
            self.stop_selection_drag();
            return;
        }
        if !event.dragging() {
            self.stop_selection_drag();
        }
        if !self.dragging_selection || self.is_composing() {
            return;
        }
        self.drag_position = Some(event.position);
        if let Some(at) = self.hit(event.position, window) {
            let result = self.state.select(self.state.anchor, at);
            self.changed(result, window, cx);
            self.slash = None;
        }
        cx.notify();
    }
    pub(super) fn stop_selection_drag(&mut self) {
        self.dragging_selection = false;
        self.drag_position = None;
    }
    fn drag_scroll_distance(&self, window: &Window) -> Pixels {
        let Some(position) = self
            .drag_position
            .filter(|_| self.dragging_selection && self.source.is_none() && !self.is_composing())
        else {
            return Pixels::ZERO;
        };
        let bounds = self.geometry.borrow().bounds;
        let edge = window.rem_size();
        if position.y < bounds.top() + edge {
            -edge / 2.
        } else if position.y > bounds.bottom() - edge {
            edge / 2.
        } else {
            Pixels::ZERO
        }
    }
    fn advance_selection_drag(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.focus.is_focused(window) {
            self.stop_selection_drag();
            return;
        }
        let distance = self.drag_scroll_distance(window);
        if distance == Pixels::ZERO {
            return;
        }
        if let Some(at) = self
            .drag_position
            .and_then(|position| self.hit(position, window))
            && at != self.state.head
        {
            let result = self.state.select(self.state.anchor, at);
            self.changed(result, window, cx);
        }
        let before = self.layout.logical_scroll_top();
        self.layout.scroll_by(distance);
        if before != self.layout.logical_scroll_top() {
            cx.notify();
        }
    }
    fn vertical(&mut self, down: bool, extend: bool, window: &Window) -> Result<()> {
        let (ix, at) = self.state.projection.at(self.state.head);
        let frame = self.geometry.borrow();
        let key = self.keys[ix];
        let next = if let Some(geometry) = frame.leaves.get(&key) {
            let position = geometry.position_for_index(at);
            let target = point(
                position.x,
                position.y + geometry.line_height() * if down { 1.5 } else { -0.5 },
            );
            self.hit(target, window).filter(|p| *p != self.state.head)
        } else {
            None
        };
        let next = next.unwrap_or_else(|| {
            let next = if down {
                (ix + 1).min(self.state.projection.leaves.len() - 1)
            } else {
                ix.saturating_sub(1)
            };
            self.state.projection.leaves[next].logical.start
        });
        drop(frame);
        self.state
            .select(if extend { self.state.anchor } else { next }, next)
    }
    pub(super) fn key_down(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.source.is_some() {
            return;
        }
        let key = event.keystroke.key.as_str();
        let modifiers = event.keystroke.modifiers;
        if self.is_composing() {
            if key == "escape" {
                let result = self.state.cancel_composition();
                self.changed(result, window, cx);
                cx.stop_propagation();
            }
            return;
        }
        if self.slash.is_some() {
            if key == "escape" {
                self.slash = None;
                self.slash_start = None;
                self.slash_first = None;
                cx.notify();
                cx.stop_propagation();
                return;
            }
            if key == "enter"
                && let Some(name) = self.slash_first.clone()
            {
                self.run(&RunCommand::new(name), window, cx);
                cx.stop_propagation();
                return;
            }
            if key == "down"
                && let Some(menu) = &self.slash
            {
                menu.focus_handle(cx).focus(window, cx);
                cx.stop_propagation();
                return;
            }
        }
        let primary = if cfg!(target_os = "macos") {
            modifiers.platform
        } else {
            modifiers.control
        };
        if primary {
            match key {
                "a" => {
                    let result = self.state.select(0, self.text().len());
                    self.changed(result, window, cx);
                }
                "c" => self.copy(false, window, cx),
                "x" => self.copy(true, window, cx),
                "v" => {
                    if let Some(item) = cx.read_from_clipboard() {
                        self.paste_item(item, window, cx);
                    }
                }
                "f" => {
                    self.show_search = true;
                    self.search.update(cx, |s, cx| s.focus(window, cx));
                    cx.notify();
                }
                _ => return,
            }
            cx.stop_propagation();
            return;
        }
        let result = match key {
            "enter" => self.state.enter(),
            "backspace" => self.state.delete(true),
            "delete" => self.state.delete(false),
            "tab" => self.state.tab(modifiers.shift),
            "left" | "right" => self.state.move_horizontal(
                key == "left",
                modifiers.shift,
                modifiers.alt || modifiers.control,
            ),
            "up" | "down" => self.vertical(key == "down", modifiers.shift, window),
            "home" | "end" => {
                let (ix, _) = self.state.projection.at(self.state.head);
                let leaf = &self.state.projection.leaves[ix];
                let next = if key == "home" {
                    leaf.logical.start
                } else {
                    leaf.logical.end
                };
                self.state.select(
                    if modifiers.shift {
                        self.state.anchor
                    } else {
                        next
                    },
                    next,
                )
            }
            _ => return,
        };
        self.changed(result, window, cx);
        cx.stop_propagation();
    }
}
