use anynote_editor::board::{Element, ElementKind, Point, Scene};

#[derive(Clone, Copy, Debug)]
pub struct Viewport {
    zoom: f64,
    pan: Point,
}
impl Default for Viewport {
    fn default() -> Self {
        Self {
            zoom: 1.,
            pan: Point::new(0., 0.),
        }
    }
}
impl Viewport {
    pub fn from_scene(scene: &Scene) -> Self {
        let app = scene.field("appState");
        let zoom = app
            .and_then(|a| a.get("zoom")?.get("value")?.as_f64())
            .filter(|n| n.is_finite())
            .unwrap_or(1.)
            .clamp(0.1, 8.);
        let scroll = |key| {
            app.and_then(|a| a.get(key)?.as_f64())
                .filter(|n| n.is_finite())
                .unwrap_or(0.)
        };
        Self {
            zoom,
            pan: Point::new(scroll("scrollX") * zoom, scroll("scrollY") * zoom),
        }
    }
    pub fn zoom(&self) -> f64 {
        self.zoom
    }
    pub fn to_screen(&self, p: Point) -> Point {
        Point::new(
            p.x() * self.zoom + self.pan.x(),
            p.y() * self.zoom + self.pan.y(),
        )
    }
    pub fn to_world(&self, p: Point) -> Point {
        Point::new(
            (p.x() - self.pan.x()) / self.zoom,
            (p.y() - self.pan.y()) / self.zoom,
        )
    }
    pub fn pan_by(&mut self, delta: Point) {
        if delta.x().is_finite() && delta.y().is_finite() {
            self.pan = Point::new(self.pan.x() + delta.x(), self.pan.y() + delta.y());
        }
    }
    pub fn zoom_at(&mut self, factor: f64, anchor: Point) {
        if !factor.is_finite() || factor <= 0. || !anchor.x().is_finite() || !anchor.y().is_finite()
        {
            return;
        }
        let world = self.to_world(anchor);
        self.zoom = (self.zoom * factor).clamp(0.1, 8.);
        self.pan = Point::new(
            anchor.x() - world.x() * self.zoom,
            anchor.y() - world.y() * self.zoom,
        );
    }
}

pub(super) fn number(e: &Element, key: &str, default: f64) -> f64 {
    e.field(key)
        .and_then(serde_json::Value::as_f64)
        .filter(|n| n.is_finite())
        .unwrap_or(default)
}
pub(super) fn is_path(e: &Element) -> bool {
    matches!(
        e.kind(),
        ElementKind::Line | ElementKind::Arrow | ElementKind::Freedraw
    )
}
/// Shared ideal outline for paint, selection and hit testing. Rough strokes are decorative.
pub(super) fn outline(e: &Element) -> Vec<Point> {
    if is_path(e) {
        return e.world_points().unwrap_or_default();
    }
    let Ok(g) = e.geometry() else {
        return vec![];
    };
    let w = g.width();
    let h = g.height();
    let local = match e.kind() {
        ElementKind::Ellipse => (0..=64)
            .map(|i| {
                let a = i as f64 * std::f64::consts::TAU / 64.;
                Point::new(w * (1. + a.cos()) / 2., h * (1. + a.sin()) / 2.)
            })
            .collect(),
        ElementKind::Diamond => vec![
            Point::new(w / 2., 0.),
            Point::new(w, h / 2.),
            Point::new(w / 2., h),
            Point::new(0., h / 2.),
            Point::new(w / 2., 0.),
        ],
        _ => vec![
            Point::new(0., 0.),
            Point::new(w, 0.),
            Point::new(w, h),
            Point::new(0., h),
            Point::new(0., 0.),
        ],
    };
    local.into_iter().map(|p| g.local_to_world(p)).collect()
}
pub(super) fn bounds(points: &[Point]) -> Option<[f64; 4]> {
    let first = points.first()?;
    Some(
        points
            .iter()
            .fold([first.x(), first.y(), first.x(), first.y()], |b, p| {
                [
                    b[0].min(p.x()),
                    b[1].min(p.y()),
                    b[2].max(p.x()),
                    b[3].max(p.y()),
                ]
            }),
    )
}
pub(super) fn distance(a: Point, b: Point) -> f64 {
    (a.x() - b.x()).hypot(a.y() - b.y())
}
fn segment_distance(p: Point, a: Point, b: Point) -> f64 {
    let dx = b.x() - a.x();
    let dy = b.y() - a.y();
    let length = dx * dx + dy * dy;
    let t = if length == 0. {
        0.
    } else {
        ((p.x() - a.x()) * dx + (p.y() - a.y()) * dy) / length
    }
    .clamp(0., 1.);
    distance(p, Point::new(a.x() + t * dx, a.y() + t * dy))
}
pub(super) fn inside(p: Point, polygon: &[Point]) -> bool {
    let mut inside = false;
    for pair in polygon.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        if (a.y() > p.y()) != (b.y() > p.y())
            && p.x() < (b.x() - a.x()) * (p.y() - a.y()) / (b.y() - a.y()) + a.x()
        {
            inside = !inside;
        }
    }
    inside
}
pub fn hit_test(scene: &Scene, world: Point, zoom: f64) -> Option<String> {
    let mut hit = None;
    for e in scene
        .elements()
        .filter(|e| !e.is_deleted() && !e.is_locked())
    {
        let points = outline(e);
        let tolerance = 6. / zoom.clamp(0.1, 8.) + number(e, "strokeWidth", 1.) / 2.;
        let filled = matches!(e.kind(), ElementKind::Text | ElementKind::Image)
            || e.field("backgroundColor")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|s| s != "transparent");
        if points
            .windows(2)
            .any(|p| segment_distance(world, p[0], p[1]) <= tolerance)
            || (points.len() == 1 && distance(world, points[0]) <= tolerance)
            || (!is_path(e) && filled && inside(world, &points))
        {
            hit = Some(e.id().to_owned());
        }
    }
    hit
}

pub(super) fn hatch_lines(points: &[Point], cross: bool, mut emit: impl FnMut([Point; 2])) {
    let sign = if cross { -1. } else { 1. };
    let min = points
        .iter()
        .map(|p| p.y() - p.x() * sign)
        .fold(f64::INFINITY, f64::min);
    let max = points
        .iter()
        .map(|p| p.y() - p.x() * sign)
        .fold(f64::NEG_INFINITY, f64::max);
    let step = 8f64.max((max - min) / 2000.);
    let mut intercept = (min / step).floor() * step;
    while intercept <= max {
        let mut crossings = vec![];
        for pair in points.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            let (ya, yb) = (a.y() - a.x() * sign, b.y() - b.x() * sign);
            if (ya > intercept) != (yb > intercept) {
                let t = (intercept - ya) / (yb - ya);
                crossings.push(Point::new(
                    a.x() + t * (b.x() - a.x()),
                    a.y() + t * (b.y() - a.y()),
                ));
            }
        }
        crossings.sort_by(|a, b| a.x().total_cmp(&b.x()));
        for pair in crossings.as_chunks::<2>().0 {
            emit(*pair);
        }
        intercept += step;
    }
}
pub(super) fn rough_outline(e: &Element, points: &[Point]) -> Option<Vec<Point>> {
    let rough = number(e, "roughness", 0.).clamp(0., 3.);
    if rough == 0. || matches!(e.kind(), ElementKind::Frame | ElementKind::MagicFrame) {
        return None;
    }
    let mut seed = e
        .field("seed")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(1) as u32;
    let mut random = || {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        (seed as f64 / u32::MAX as f64 - 0.5) * rough
    };
    Some(
        points
            .iter()
            .map(|p| Point::new(p.x() + random(), p.y() + random()))
            .collect(),
    )
}
pub(super) fn arrowheads(e: &Element, points: &[Point]) -> Vec<[Point; 3]> {
    if e.kind() != ElementKind::Arrow || points.len() < 2 {
        return vec![];
    }
    let mut paths = vec![];
    for (head, tail, key) in [
        (points[0], points[1], "startArrowhead"),
        (
            *points.last().unwrap(),
            points[points.len() - 2],
            "endArrowhead",
        ),
    ] {
        if e.field(key).is_some_and(|v| !v.is_null()) {
            let angle = (head.y() - tail.y()).atan2(head.x() - tail.x());
            let length = 20f64.min(distance(head, tail) / 3.);
            let wing = |side: f64| {
                Point::new(
                    head.x() - length * (angle + side * 0.5).cos(),
                    head.y() - length * (angle + side * 0.5).sin(),
                )
            };
            paths.push([wing(-1.), head, wing(1.)]);
        }
    }
    paths
}
