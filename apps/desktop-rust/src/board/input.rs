use super::geometry::{Viewport, bounds, distance, hit_test, is_path, outline};
use anynote_editor::board::{
    Board, Command, CropHandle, EditStamp, Element, ElementKind, Geometry, Point, Scene,
};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tool {
    Select,
    Hand,
    Rectangle,
    Diamond,
    Ellipse,
    Line,
    Arrow,
    Freedraw,
    Text,
}
impl Tool {
    pub fn label(self) -> &'static str {
        match self {
            Self::Select => "选择",
            Self::Hand => "平移",
            Self::Rectangle => "矩形",
            Self::Diamond => "菱形",
            Self::Ellipse => "椭圆",
            Self::Line => "线条",
            Self::Arrow => "箭头",
            Self::Freedraw => "画笔",
            Self::Text => "文字",
        }
    }
    pub fn id(self) -> &'static str {
        match self {
            Self::Select => "board-select",
            Self::Hand => "board-hand",
            Self::Rectangle => "board-rectangle",
            Self::Diamond => "board-diamond",
            Self::Ellipse => "board-ellipse",
            Self::Line => "board-line",
            Self::Arrow => "board-arrow",
            Self::Freedraw => "board-freedraw",
            Self::Text => "board-text",
        }
    }
    fn type_name(self) -> &'static str {
        match self {
            Self::Diamond => "diamond",
            Self::Ellipse => "ellipse",
            Self::Line => "line",
            Self::Arrow => "arrow",
            Self::Freedraw => "freedraw",
            Self::Text => "text",
            _ => "rectangle",
        }
    }
}
enum Gesture {
    Pan {
        last: Point,
    },
    Move {
        start: Point,
    },
    Marquee {
        start: Point,
        end: Point,
        previous: BTreeSet<String>,
    },
    Draw {
        id: String,
        tool: Tool,
        start: Point,
        points: Vec<Point>,
    },
    Resize {
        element: Element,
        corner: usize,
    },
    Rotate {
        element: Element,
        start: f64,
    },
    Vertex {
        element: Element,
        index: usize,
    },
    Crop {
        id: String,
        handle: CropHandle,
        natural: [f64; 2],
        ratio: f64,
    },
}

/// Gesture state is transient; only `finish` publishes one RM22 transaction.
pub struct BoardInput {
    board: Board,
    viewport: Viewport,
    tool: Tool,
    gesture: Option<Gesture>,
    preview: Option<Scene>,
    commands: Vec<Command>,
    error: Option<String>,
    selection_before: BTreeSet<String>,
    group_before: Option<String>,
    crop: Option<(String, [f64; 2])>,
}
impl BoardInput {
    pub fn new(scene: Scene) -> Self {
        Self {
            viewport: Viewport::from_scene(&scene),
            board: Board::new(scene, 128),
            tool: Tool::Select,
            gesture: None,
            preview: None,
            commands: vec![],
            error: None,
            selection_before: BTreeSet::new(),
            group_before: None,
            crop: None,
        }
    }
    pub fn board(&self) -> &Board {
        &self.board
    }
    pub fn scene(&self) -> &Scene {
        self.preview.as_ref().unwrap_or_else(|| self.board.scene())
    }
    pub fn viewport(&self) -> Viewport {
        self.viewport
    }
    pub fn viewport_mut(&mut self) -> &mut Viewport {
        &mut self.viewport
    }
    pub fn tool(&self) -> Tool {
        self.tool
    }
    pub fn set_tool(&mut self, tool: Tool) {
        self.cancel();
        self.crop = None;
        self.tool = tool;
    }
    pub fn edit_group(&mut self, id: Option<String>) {
        self.cancel();
        if let Err(error) = self.board.edit_group(id) {
            self.set_error(error.to_string());
        }
    }
    pub fn enter_group(&mut self, id: &str) {
        let group = self.board.scene().element(id).and_then(|e| {
            let groups = e.field("groupIds")?.as_array()?;
            groups
                .iter()
                .rev()
                .filter_map(Value::as_str)
                .skip_while(|group| {
                    self.board
                        .editing_group()
                        .is_some_and(|current| *group != current)
                })
                .nth(usize::from(self.board.editing_group().is_some()))
                .map(str::to_owned)
        });
        if let Some(group) = group {
            self.edit_group(Some(group));
            self.select([id.to_owned()]);
        }
    }
    pub fn start_crop(&mut self, id: String, natural: [f64; 2]) {
        self.select([id.clone()]);
        self.tool = Tool::Select;
        self.crop = Some((id, natural));
    }
    pub fn is_cropping(&self) -> bool {
        self.crop.is_some()
    }
    pub fn end_crop(&mut self) {
        self.cancel();
        self.crop = None;
    }
    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }
    pub fn set_error(&mut self, error: impl Into<String>) {
        self.error = Some(error.into());
    }
    pub fn is_dragging(&self) -> bool {
        self.gesture.is_some()
    }
    pub fn select(&mut self, ids: impl IntoIterator<Item = String>) {
        self.cancel();
        self.crop = None;
        if let Err(e) = self.board.select(ids) {
            self.error = Some(e.to_string());
        }
    }
    pub fn select_all(&mut self) {
        let ids: Vec<_> = self
            .board
            .scene()
            .elements()
            .filter(|e| !e.is_deleted() && !e.is_locked())
            .map(|e| e.id().to_owned())
            .collect();
        self.select(ids);
    }
    pub fn execute(&mut self, commands: &[Command]) -> bool {
        self.cancel();
        match self.board.apply_batch(commands, stamp()) {
            Ok(changed) => {
                self.error = None;
                changed
            }
            Err(e) => {
                self.error = Some(format!("无法完成操作：{e}"));
                false
            }
        }
    }
    pub fn undo(&mut self) {
        self.cancel();
        self.board.undo();
    }
    pub fn redo(&mut self) {
        self.cancel();
        self.board.redo();
    }
    pub fn cancel(&mut self) {
        if self.gesture.is_some() {
            let _ = self.board.edit_group(self.group_before.clone());
            let _ = self.board.select(self.selection_before.clone());
        }
        self.gesture = None;
        self.preview = None;
        self.commands.clear();
    }
    pub fn marquee(&self) -> Option<[Point; 2]> {
        match self.gesture {
            Some(Gesture::Marquee { start, end, .. }) => Some([start, end]),
            _ => None,
        }
    }
    pub fn begin(&mut self, screen: Point, additive: bool, pan: bool) {
        self.cancel();
        self.error = None;
        self.selection_before = self.board.selected_ids().clone();
        self.group_before = self.board.editing_group().map(str::to_owned);
        let world = self.viewport.to_world(screen);
        if pan || self.tool == Tool::Hand {
            self.gesture = Some(Gesture::Pan { last: screen });
            return;
        }
        if self.tool == Tool::Text {
            return;
        }
        if self.tool != Tool::Select {
            self.gesture = Some(Gesture::Draw {
                id: Uuid::new_v4().to_string(),
                tool: self.tool,
                start: world,
                points: vec![world],
            });
            return;
        }
        if self.board.selected_ids().len() == 1 && !additive {
            let id = self.board.selected_ids().first().unwrap();
            let e = self.board.scene().element(id).unwrap();
            if !e.is_locked() {
                for (index, p) in handles(e, self.viewport.zoom()).into_iter().enumerate() {
                    if distance(p, world) * self.viewport.zoom() <= 8. {
                        self.gesture = Some(if let Some((id, natural)) = &self.crop {
                            if id != e.id() || index >= 4 {
                                return;
                            }
                            Gesture::Crop {
                                id: id.clone(),
                                natural: *natural,
                                handle: [
                                    CropHandle::Nw,
                                    CropHandle::Ne,
                                    CropHandle::Se,
                                    CropHandle::Sw,
                                ][index],
                                ratio: e.geometry().unwrap().width()
                                    / e.geometry().unwrap().height(),
                            }
                        } else if is_path(e) {
                            Gesture::Vertex {
                                element: e.clone(),
                                index,
                            }
                        } else if index == 4 {
                            let center = e.geometry().unwrap().center();
                            Gesture::Rotate {
                                element: e.clone(),
                                start: (world.y() - center.y()).atan2(world.x() - center.x()),
                            }
                        } else {
                            Gesture::Resize {
                                element: e.clone(),
                                corner: index,
                            }
                        });
                        return;
                    }
                }
            }
        }
        self.crop = None;
        if let Some(id) = hit_test(self.board.scene(), world, self.viewport.zoom()) {
            let mut selected = if additive || self.board.selected_ids().contains(&id) {
                self.board.selected_ids().clone()
            } else {
                BTreeSet::new()
            };
            if additive && selected.contains(&id) {
                // Remove the whole expanded group, not just its clicked member.
                let mut group = Board::new(self.board.scene().clone(), 0);
                let _ = group.edit_group(self.board.editing_group().map(str::to_owned));
                let _ = group.select([id]);
                selected.retain(|id| !group.selected_ids().contains(id));
            } else {
                selected.insert(id);
            }
            let _ = self.board.select(selected);
            self.gesture = Some(Gesture::Move { start: world });
        } else {
            let previous = if additive {
                self.board.selected_ids().clone()
            } else {
                BTreeSet::new()
            };
            let _ = self.board.select(previous.clone());
            self.gesture = Some(Gesture::Marquee {
                start: world,
                end: world,
                previous,
            });
        }
    }
    pub fn update(&mut self, screen: Point, constrain: bool) {
        let world = self.viewport.to_world(screen);
        let Some(gesture) = self.gesture.as_mut() else {
            return;
        };
        let commands = match gesture {
            Gesture::Crop {
                id,
                handle,
                natural,
                ratio,
            } => vec![Command::CropImage {
                id: id.clone(),
                handle: *handle,
                natural_width: natural[0],
                natural_height: natural[1],
                pointer: world,
                aspect_ratio: constrain.then_some(*ratio),
            }],
            Gesture::Pan { last } => {
                self.viewport
                    .pan_by(Point::new(screen.x() - last.x(), screen.y() - last.y()));
                *last = screen;
                return;
            }
            Gesture::Marquee {
                start,
                end,
                previous,
            } => {
                *end = world;
                let b = bounds(&[*start, world]).unwrap();
                let mut selected = previous.clone();
                for e in self
                    .board
                    .scene()
                    .elements()
                    .filter(|e| !e.is_deleted() && !e.is_locked())
                {
                    if bounds(&outline(e)).is_some_and(|e| {
                        e[0] >= b[0] && e[1] >= b[1] && e[2] <= b[2] && e[3] <= b[3]
                    }) {
                        selected.insert(e.id().into());
                    }
                }
                let _ = self.board.select(selected);
                return;
            }
            Gesture::Move { start } => {
                let mut dx = world.x() - start.x();
                let mut dy = world.y() - start.y();
                if constrain {
                    if dx.abs() > dy.abs() {
                        dy = 0.;
                    } else {
                        dx = 0.;
                    }
                }
                vec![Command::Translate {
                    delta: Point::new(dx, dy),
                }]
            }
            Gesture::Draw {
                id,
                tool,
                start,
                points,
            } => {
                if points.len() <= 2 && distance(*start, world) * self.viewport.zoom() < 2. {
                    self.preview = None;
                    self.commands.clear();
                    return;
                }
                let mut end = world;
                if constrain && !matches!(tool, Tool::Freedraw) {
                    let dx = world.x() - start.x();
                    let dy = world.y() - start.y();
                    if matches!(tool, Tool::Line | Tool::Arrow) {
                        let angle = (dy.atan2(dx) / std::f64::consts::FRAC_PI_4).round()
                            * std::f64::consts::FRAC_PI_4;
                        end = Point::new(
                            start.x() + dx.hypot(dy) * angle.cos(),
                            start.y() + dx.hypot(dy) * angle.sin(),
                        );
                    } else {
                        let side = dx.abs().max(dy.abs());
                        end = Point::new(
                            start.x() + side * dx.signum(),
                            start.y() + side * dy.signum(),
                        );
                    }
                }
                if *tool == Tool::Freedraw {
                    if distance(*points.last().unwrap(), end) * self.viewport.zoom() >= 1.
                        && points.len() < 20_000
                    {
                        points.push(end);
                    }
                } else {
                    points.truncate(1);
                    points.push(end);
                }
                vec![Command::Insert {
                    elements: vec![drawing(id, *tool, *start, end, points)],
                    files: Default::default(),
                }]
            }
            Gesture::Resize { element, corner } => {
                let g = element.geometry().unwrap();
                let local = g.world_to_local(world);
                let anchor = match *corner {
                    0 => Point::new(g.width(), g.height()),
                    1 => Point::new(0., g.height()),
                    2 => Point::new(0., 0.),
                    _ => Point::new(g.width(), 0.),
                };
                let mut dx = local.x() - anchor.x();
                let mut dy = local.y() - anchor.y();
                if constrain && g.height() > 0. {
                    let ratio = g.width() / g.height();
                    if dx.abs() > dy.abs() * ratio {
                        dy = dx.abs() / ratio * dy.signum();
                    } else {
                        dx = dy.abs() * ratio * dx.signum();
                    }
                }
                let center =
                    g.local_to_world(Point::new(anchor.x() + dx / 2., anchor.y() + dy / 2.));
                let geometry = Geometry::new(
                    center.x() - dx.abs() / 2.,
                    center.y() - dy.abs() / 2.,
                    dx.abs().max(1.),
                    dy.abs().max(1.),
                    g.angle(),
                )
                .unwrap();
                vec![
                    if matches!(element.kind(), ElementKind::Frame | ElementKind::MagicFrame) {
                        Command::ResizeFrame {
                            id: element.id().into(),
                            geometry,
                        }
                    } else {
                        Command::Geometry {
                            id: element.id().into(),
                            geometry,
                        }
                    },
                ]
            }
            Gesture::Rotate { element, start } => {
                let g = element.geometry().unwrap();
                let center = g.center();
                let mut angle =
                    g.angle() + (world.y() - center.y()).atan2(world.x() - center.x()) - *start;
                if constrain {
                    angle = (angle / (std::f64::consts::PI / 12.)).round()
                        * (std::f64::consts::PI / 12.);
                }
                let geometry = Geometry::new(g.x(), g.y(), g.width(), g.height(), angle).unwrap();
                vec![Command::Geometry {
                    id: element.id().into(),
                    geometry,
                }]
            }
            Gesture::Vertex { element, index } => {
                let Ok(points) = serde_json::from_value::<Vec<Point>>(
                    element.field("points").cloned().unwrap_or(Value::Null),
                ) else {
                    return;
                };
                let g = element.geometry().unwrap();
                let b = bounds(&points).unwrap();
                let center = Point::new(g.x() + (b[0] + b[2]) / 2., g.y() + (b[1] + b[3]) / 2.);
                let (sin, cos) = (-g.angle()).sin_cos();
                let dx = world.x() - center.x();
                let dy = world.y() - center.y();
                let local = Point::new(
                    center.x() + dx * cos - dy * sin - g.x(),
                    center.y() + dx * sin + dy * cos - g.y(),
                );
                vec![Command::MovePoints {
                    id: element.id().into(),
                    updates: vec![(*index, local)],
                }]
            }
        };
        let mut preview = Board::new(self.board.scene().clone(), 0);
        let _ = preview.edit_group(self.board.editing_group().map(str::to_owned));
        let result = preview
            .select(self.board.selected_ids().iter().cloned())
            .and_then(|_| preview.apply_batch(&commands, stamp()));
        match result {
            Ok(_) => {
                self.preview = Some(preview.scene().clone());
                self.commands = commands;
                self.error = None;
            }
            Err(e) => {
                self.preview = None;
                self.commands.clear();
                self.error = Some(format!("无法完成操作：{e}"));
            }
        }
    }
    pub fn finish(&mut self) -> bool {
        let commands = std::mem::take(&mut self.commands);
        self.gesture = None;
        self.preview = None;
        if !commands.is_empty() {
            self.execute(&commands)
        } else {
            false
        }
    }
}
pub(super) fn stamp() -> EditStamp {
    EditStamp::new(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        Uuid::new_v4().as_u128() as u32,
    )
}
pub(super) fn handles(e: &Element, zoom: f64) -> Vec<Point> {
    if is_path(e) {
        if e.field("elbowed") == Some(&json!(true)) {
            return vec![];
        }
        return e
            .world_points()
            .unwrap_or_default()
            .into_iter()
            .take(128)
            .collect();
    }
    if !matches!(
        e.kind(),
        ElementKind::Rectangle
            | ElementKind::Diamond
            | ElementKind::Ellipse
            | ElementKind::Image
            | ElementKind::Frame
            | ElementKind::MagicFrame
    ) {
        return vec![];
    }
    let Ok(g) = e.geometry() else {
        return vec![];
    };
    let mut p = g.corners().to_vec();
    if !matches!(e.kind(), ElementKind::Frame | ElementKind::MagicFrame) {
        p.push(g.local_to_world(Point::new(g.width() / 2., -24. / zoom)));
    }
    p
}
pub(super) fn drawing(id: &str, tool: Tool, start: Point, end: Point, points: &[Point]) -> Value {
    let path = matches!(tool, Tool::Line | Tool::Arrow | Tool::Freedraw);
    let b = bounds(points).unwrap();
    let (x, y) = if path {
        (start.x(), start.y())
    } else {
        (start.x().min(end.x()), start.y().min(end.y()))
    };
    let mut value = json!({"id":id,"type":tool.type_name(),"x":x,"y":y,"width":b[2]-b[0],"height":b[3]-b[1],"angle":0,"strokeColor":"#1b1b1f","backgroundColor":"transparent","fillStyle":"solid","strokeStyle":"solid","strokeWidth":2,"roughness":1,"seed":id.bytes().fold(2166136261u32, |seed, byte| (seed ^ u32::from(byte)).wrapping_mul(16777619)),"opacity":100,"groupIds":[],"frameId":null,"boundElements":null,"isDeleted":false,"locked":false,"roundness":null});
    if path {
        value["points"] = json!(
            points
                .iter()
                .map(|p| Point::new(p.x() - x, p.y() - y))
                .collect::<Vec<_>>()
        );
    }
    if tool == Tool::Arrow {
        value["startArrowhead"] = Value::Null;
        value["endArrowhead"] = json!("arrow");
        value["startBinding"] = Value::Null;
        value["endBinding"] = Value::Null;
    }
    if tool == Tool::Freedraw {
        value["pressures"] = json!([]);
        value["simulatePressure"] = json!(true);
    }
    value
}
