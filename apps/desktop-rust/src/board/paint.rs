use super::{
    assets::Assets,
    geometry::{bounds, is_path, number, outline},
    input::{BoardInput, handles},
};
use anynote_editor::board::{ElementKind, Point as BoardPoint};
use gpui_kit::{component::ActiveTheme, *};
use serde_json::Value;

fn color(value: Option<&Value>, fallback: Hsla, dark: bool) -> Hsla {
    let Some(value) = value.and_then(Value::as_str) else {
        return fallback;
    };
    if value == "transparent" {
        return fallback.opacity(0.);
    }
    let Ok(mut rgba) = Rgba::try_from(value) else {
        return fallback;
    };
    // Scene colors are document data. Dark presentation never rewrites the scene.
    if dark {
        rgba.r = 1. - rgba.r;
        rgba.g = 1. - rgba.g;
        rgba.b = 1. - rgba.b;
    }
    rgba.into()
}
fn path(
    points: &[Point<Pixels>],
    width: f32,
    fill: bool,
    dash: &[Pixels],
    window: &mut Window,
    color: Hsla,
) {
    if points.is_empty() || color.a == 0. || (!fill && width <= 0.) {
        return;
    }
    let mut path = if fill {
        PathBuilder::fill()
    } else {
        PathBuilder::stroke(px(width.max(0.1)))
    };
    if !fill && !dash.is_empty() {
        path = path.dash_array(dash);
    }
    path.move_to(points[0]);
    for p in &points[1..] {
        path.line_to(*p);
    }
    if fill {
        path.close();
    }
    if let Ok(path) = path.build() {
        window.paint_path(path, color);
    }
}
pub(super) fn paint(
    input: &BoardInput,
    assets: &Assets,
    canvas: Bounds<Pixels>,
    window: &mut Window,
    cx: &mut App,
) {
    let viewport = input.viewport();
    let zoom = viewport.zoom();
    let screen = |p: BoardPoint| {
        let p = viewport.to_screen(p);
        point(
            canvas.left() + px(p.x() as f32),
            canvas.top() + px(p.y() as f32),
        )
    };
    let dark = cx.theme().mode.is_dark();
    for e in input.scene().elements().filter(|e| !e.is_deleted()) {
        let points = outline(e);
        let Some(b) = bounds(&points) else {
            continue;
        };
        let origin = screen(BoardPoint::new(b[0], b[1]));
        let end = screen(BoardPoint::new(b[2], b[3]));
        let extent = Bounds::new(
            origin,
            size(
                (end.x - origin.x).max(px(1.)),
                (end.y - origin.y).max(px(1.)),
            ),
        );
        if !canvas.intersects(&extent) {
            continue;
        }
        let opacity = (number(e, "opacity", 100.) / 100.).clamp(0., 1.) as f32;
        let stroke = color(e.field("strokeColor"), cx.theme().foreground, dark).opacity(opacity);
        let fill_color = color(
            e.field("backgroundColor"),
            cx.theme().background.opacity(0.),
            dark,
        )
        .opacity(opacity);
        let screen_points: Vec<_> = points.iter().copied().map(screen).collect();
        if e.kind() == ElementKind::Text {
            if let Some(layout) = assets.texts.get(e.id()) {
                let g = e.geometry().unwrap();
                let alignment = match e.field("textAlign").and_then(Value::as_str) {
                    Some("center") => 0.5,
                    Some("right") => 1.,
                    _ => 0.,
                };
                let offset = (g.width() - layout.width) * alignment;
                let convert = |p: resvg::tiny_skia::Point| {
                    screen(g.local_to_world(BoardPoint::new(p.x as f64 + offset, p.y as f64)))
                };
                for glyph in &layout.paths {
                    let mut builder = PathBuilder::fill();
                    for segment in glyph.segments() {
                        use resvg::tiny_skia::PathSegment;
                        match segment {
                            PathSegment::MoveTo(p) => builder.move_to(convert(p)),
                            PathSegment::LineTo(p) => builder.line_to(convert(p)),
                            PathSegment::QuadTo(a, b) => builder.curve_to(convert(b), convert(a)),
                            PathSegment::CubicTo(a, b, c) => {
                                builder.cubic_bezier_to(convert(c), convert(a), convert(b))
                            }
                            PathSegment::Close => builder.close(),
                        }
                    }
                    if let Ok(path) = builder.build() {
                        window.paint_path(path, stroke);
                    }
                }
            }
        } else if e.kind() == ElementKind::Image {
            if let Some(image) = assets.images.get(e.id()) {
                let _ =
                    window.paint_image(canvas, extent, Corners::default(), image.clone(), 0, false);
            } else {
                path(
                    &screen_points,
                    1.,
                    false,
                    &[px(4.), px(4.)],
                    window,
                    cx.theme().muted_foreground,
                );
                path(
                    &[screen_points[0], screen_points[2]],
                    1.,
                    false,
                    &[],
                    window,
                    cx.theme().muted_foreground,
                );
            }
        } else {
            if !is_path(e) && fill_color.a > 0. {
                if e.field("fillStyle")
                    .and_then(Value::as_str)
                    .unwrap_or("solid")
                    == "solid"
                {
                    path(&screen_points, 0., true, &[], window, fill_color);
                } else {
                    hatch(&points, zoom, &screen, window, fill_color, false);
                    if e.field("fillStyle").and_then(Value::as_str) == Some("cross-hatch") {
                        hatch(&points, zoom, &screen, window, fill_color, true);
                    }
                }
            }
            let width = number(e, "strokeWidth", 1.).clamp(0., 100.) as f32 * zoom as f32;
            let dash = match e.field("strokeStyle").and_then(Value::as_str) {
                Some("dashed") => vec![px(width * 5.), px(width * 3.)],
                Some("dotted") => vec![px(width), px(width * 3.)],
                _ => vec![],
            };
            path(&screen_points, width, false, &dash, window, stroke);
            if let Some(points) = super::geometry::rough_outline(e, &points) {
                path(
                    &points.into_iter().map(screen).collect::<Vec<_>>(),
                    width * 0.65,
                    false,
                    &dash,
                    window,
                    stroke.opacity(0.65),
                );
            }
            for head in super::geometry::arrowheads(e, &points) {
                path(&head.map(screen), width, false, &[], window, stroke);
            }
        }
        if input.board().selected_ids().contains(e.id()) {
            let mut selection = if is_path(e) {
                points.clone()
            } else {
                e.geometry()
                    .map(|g| g.corners().to_vec())
                    .unwrap_or_default()
            };
            if !is_path(e)
                && let Some(first) = selection.first().copied()
            {
                selection.push(first);
            }
            path(
                &selection.into_iter().map(screen).collect::<Vec<_>>(),
                1.,
                false,
                &[px(4.), px(3.)],
                window,
                cx.theme().primary,
            );
            if input.board().selected_ids().len() == 1 && !e.is_locked() {
                for p in handles(e, zoom) {
                    window.paint_quad(fill(
                        Bounds::new(screen(p) - point(px(3.), px(3.)), size(px(6.), px(6.))),
                        cx.theme().primary,
                    ));
                }
            }
        }
    }
    if let Some([start, end]) = input.marquee() {
        let b = bounds(&[start, end]).unwrap();
        let a = screen(BoardPoint::new(b[0], b[1]));
        let z = screen(BoardPoint::new(b[2], b[3]));
        let rect = Bounds::new(a, size(z.x - a.x, z.y - a.y));
        window.paint_quad(fill(rect, cx.theme().primary.opacity(0.1)));
        window.paint_quad(gpui_kit::outline(
            rect,
            cx.theme().primary,
            BorderStyle::Solid,
        ));
    }
}
fn hatch(
    points: &[BoardPoint],
    zoom: f64,
    screen: &impl Fn(BoardPoint) -> Point<Pixels>,
    window: &mut Window,
    color: Hsla,
    cross: bool,
) {
    super::geometry::hatch_lines(points, cross, |pair| {
        path(&pair.map(screen), zoom as f32, false, &[], window, color);
    });
}
