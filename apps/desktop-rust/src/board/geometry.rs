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
    pub fn fit(&mut self, bounds: [f64; 4], size: Point) {
        if !bounds.iter().all(|v| v.is_finite())
            || !size.x().is_finite()
            || !size.y().is_finite()
            || size.x() <= 0.
            || size.y() <= 0.
            || bounds[0] > bounds[2]
            || bounds[1] > bounds[3]
        {
            return;
        }
        self.zoom = ((size.x() - 64.).max(1.) / (bounds[2] - bounds[0]).max(1.))
            .min((size.y() - 64.).max(1.) / (bounds[3] - bounds[1]).max(1.))
            .clamp(0.1, 8.);
        self.pan = Point::new(
            size.x() / 2. - (bounds[0] + bounds[2]) / 2. * self.zoom,
            size.y() / 2. - (bounds[1] + bounds[3]) / 2. * self.zoom,
        );
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
/// Flatten the kernel's seeded cubic strokes once for both painters and hit testing.
/// The subdivision budget is bounded by path length and never depends on viewport zoom.
pub(super) fn strokes(e: &Element) -> Vec<Vec<Point>> {
    if let Ok(curves) = anynote_editor::board::linear_strokes(e) {
        return curves
            .into_iter()
            .map(|[a, b, c, d]| {
                let steps = ((distance(a, b) + distance(b, c) + distance(c, d)) / 4.)
                    .ceil()
                    .clamp(8., 96.) as usize;
                (0..=steps)
                    .map(|i| {
                        let t = i as f64 / steps as f64;
                        let u = 1. - t;
                        Point::new(
                            u.powi(3) * a.x()
                                + 3. * u * u * t * b.x()
                                + 3. * u * t * t * c.x()
                                + t.powi(3) * d.x(),
                            u.powi(3) * a.y()
                                + 3. * u * u * t * b.y()
                                + 3. * u * t * t * c.y()
                                + t.powi(3) * d.y(),
                        )
                    })
                    .collect()
            })
            .collect();
    }
    let points = outline(e);
    let mut paths = vec![points.clone()];
    if matches!(
        e.kind(),
        ElementKind::Rectangle | ElementKind::Diamond | ElementKind::Ellipse
    ) && let Some(rough) = rough_outline(e, &points)
    {
        paths.push(rough);
    }
    paths
}
pub(super) fn frame_clip(scene: &Scene, e: &Element) -> Option<[f64; 4]> {
    if scene
        .field("appState")
        .and_then(|v| v.get("frameRendering"))
        .is_some_and(|v| {
            v.get("enabled") == Some(&serde_json::json!(false))
                || v.get("clip") == Some(&serde_json::json!(false))
        })
    {
        return None;
    }
    let id = e.field("frameId")?.as_str()?;
    let frame = scene.element(id).filter(|f| {
        !f.is_deleted() && matches!(f.kind(), ElementKind::Frame | ElementKind::MagicFrame)
    })?;
    bounds(&outline(frame))
}
pub(super) fn visible_bounds(e: &Element) -> Option<[f64; 4]> {
    let points: Vec<_> = strokes(e)
        .into_iter()
        .flatten()
        .chain(
            arrowheads(e, &outline(e))
                .into_iter()
                .flat_map(|h| h.points),
        )
        .collect();
    bounds(&points)
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
        if frame_clip(scene, e).is_some_and(|b| {
            world.x() < b[0] || world.y() < b[1] || world.x() > b[2] || world.y() > b[3]
        }) {
            continue;
        }
        let points = outline(e);
        let tolerance = 6. / zoom.clamp(0.1, 8.) + number(e, "strokeWidth", 1.) / 2.;
        let filled = matches!(e.kind(), ElementKind::Text | ElementKind::Image)
            || e.field("backgroundColor")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|s| s != "transparent");
        let heads = arrowheads(e, &points);
        if strokes(e).iter().any(|path| {
            path.windows(2)
                .any(|p| segment_distance(world, p[0], p[1]) <= tolerance)
        }) || heads.iter().any(|head| {
            (head.filled && inside(world, &head.points))
                || head
                    .points
                    .windows(2)
                    .any(|p| segment_distance(world, p[0], p[1]) <= tolerance)
        }) || (points.len() == 1 && distance(world, points[0]) <= tolerance)
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
pub(super) struct Arrowhead {
    pub points: Vec<Point>,
    pub filled: bool,
}
pub(super) fn arrowheads(e: &Element, points: &[Point]) -> Vec<Arrowhead> {
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
        let Some(kind) = e.field(key).and_then(serde_json::Value::as_str) else {
            continue;
        };
        let angle = (head.y() - tail.y()).atan2(head.x() - tail.x());
        let length = 20f64.min(distance(head, tail) / 3.);
        let local = |x: f64, y: f64| {
            Point::new(
                head.x() + x * angle.cos() - y * angle.sin(),
                head.y() + x * angle.sin() + y * angle.cos(),
            )
        };
        let filled = matches!(kind, "triangle" | "dot" | "diamond");
        let points = match kind {
            "bar" => vec![local(0., -length / 2.), local(0., length / 2.)],
            "dot" | "circle" | "circle_outline" => (0..=32)
                .map(|i| {
                    let a = i as f64 * std::f64::consts::TAU / 32.;
                    local(-length / 2. + a.cos() * length / 2., a.sin() * length / 2.)
                })
                .collect(),
            "diamond" | "diamond_outline" => vec![
                head,
                local(-length / 2., length / 2.),
                local(-length, 0.),
                local(-length / 2., -length / 2.),
                head,
            ],
            "triangle" | "triangle_outline" => vec![
                local(-length, -length / 2.),
                head,
                local(-length, length / 2.),
                local(-length, -length / 2.),
            ],
            _ => vec![
                local(-length * 0.5f64.cos(), -length * 0.5f64.sin()),
                head,
                local(-length * 0.5f64.cos(), length * 0.5f64.sin()),
            ],
        };
        paths.push(Arrowhead { points, filled });
    }
    paths
}
