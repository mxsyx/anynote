//! Connector geometry follows the pinned Excalidraw focus/intersection rules.
//! See EXCALIDRAW-LICENSE. Unsupported labels/elbows fail the entire transaction.
use super::{BoardError, Element, ElementKind, Point, Scene, path, scene::invalid};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

fn sub(a: Point, b: Point) -> Point {
    Point(a.0 - b.0, a.1 - b.1)
}
fn add(a: Point, b: Point) -> Point {
    Point(a.0 + b.0, a.1 + b.1)
}
fn scale(a: Point, s: f64) -> Point {
    Point(a.0 * s, a.1 * s)
}
fn cross(a: Point, b: Point) -> f64 {
    a.0 * b.1 - a.1 * b.0
}
fn length(a: Point) -> f64 {
    a.0.hypot(a.1)
}

pub(super) fn reconcile(before: &Scene, scene: &mut Scene) -> Result<(), BoardError> {
    let changed: Vec<_> = scene
        .elements()
        .filter(|e| !e.is_deleted())
        .filter_map(|e| {
            let old = before.element(e.id())?;
            (old.geometry().ok() != e.geometry().ok()).then(|| e.id().to_owned())
        })
        .collect();
    if changed.is_empty() {
        return Ok(());
    }
    let arrows: Vec<_> = scene
        .elements()
        .filter(|e| !e.is_deleted() && e.kind() == ElementKind::Arrow)
        .map(|e| e.id().to_owned())
        .collect();
    let directly_changed: BTreeSet<_> = arrows
        .iter()
        .filter(|id| {
            let arrow = scene.element(id).unwrap();
            before.element(id).is_some_and(|old| {
                old.geometry().ok() != arrow.geometry().ok()
                    || old.field("points") != arrow.field("points")
            })
        })
        .cloned()
        .collect();
    // Upstream visits changed targets in scene order. Reusing the updated arrow
    // for the next target matters when both targets move without the connector.
    for changed_id in changed {
        for id in &arrows {
            if directly_changed.contains(id) {
                continue;
            }
            let arrow = scene.element(id).unwrap();
            let bindings: Vec<_> = ["startBinding", "endBinding"]
                .into_iter()
                .map(|key| arrow.field(key).cloned().unwrap_or(Value::Null))
                .collect();
            let targets: Vec<_> = bindings
                .iter()
                .map(|b| b.get("elementId").and_then(Value::as_str))
                .collect();
            if !targets.iter().flatten().any(|id| *id == changed_id) {
                continue;
            }
            if arrow
                .field("boundElements")
                .and_then(Value::as_array)
                .is_some_and(|v| v.iter().any(|b| b["type"] == "text"))
            {
                return Err(invalid("connector label requires measured text layout"));
            }
            let world = arrow.world_points()?;
            if world.len() < 2 {
                return Err(invalid("connector needs two points"));
            }
            let mut updates = BTreeMap::new();
            for (end, binding) in bindings.iter().enumerate() {
                let Some(target) = targets[end] else {
                    continue;
                };
                let target = scene
                    .element(target)
                    .filter(|e| !e.is_deleted())
                    .ok_or_else(|| invalid("missing binding target"))?;
                // The opposite end follows too, unless the targets overlap.
                if target.id() != changed_id
                    && targets
                        .iter()
                        .flatten()
                        .filter_map(|id| scene.element(id))
                        .any(|other| other.id() != target.id() && intersects_bounds(target, other))
                {
                    continue;
                }
                let index = if end == 0 { 0 } else { world.len() - 1 };
                let adjacent = if end == 0 { 1 } else { world.len() - 2 };
                let point = endpoint(target, binding, world[adjacent], world[index])?;
                updates.insert(index, path::from_world(arrow, point)?);
            }
            path::move_points(scene.edit(id)?, &updates)?;
        }
    }
    Ok(())
}

fn intersects_bounds(a: &Element, b: &Element) -> bool {
    let (Ok(a), Ok(b)) = (
        super::geometry::element_bounds(a),
        super::geometry::element_bounds(b),
    ) else {
        return false;
    };
    a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
}

fn focus_point(element: &Element, focus: f64, adjacent: Point) -> Result<Point, BoardError> {
    let g = element.geometry()?;
    let center = g.center();
    if focus == 0.0 {
        return Ok(center);
    }
    let local = if element.kind() == ElementKind::Diamond {
        [
            Point(0.0, g.height() / 2.0),
            Point(g.width() / 2.0, 0.0),
            Point(g.width(), g.height() / 2.0),
            Point(g.width() / 2.0, g.height()),
        ]
    } else {
        [
            Point(0.0, 0.0),
            Point(g.width(), 0.0),
            Point(g.width(), g.height()),
            Point(0.0, g.height()),
        ]
    };
    let c = local.map(|p| add(center, scale(sub(g.local_to_world(p), center), focus.abs())));
    let side = |i: usize| cross(sub(adjacent, c[i]), sub(c[(i + 1) % 4], c[i]));
    let selected = (0..3)
        .find(|i| {
            side(*i) > 0.0
                && side(if focus > 0.0 {
                    (i + 1) % 4
                } else {
                    (i + 3) % 4
                }) < 0.0
        })
        .unwrap_or(3);
    Ok(c[if focus > 0.0 {
        (selected + 1) % 4
    } else {
        selected
    }])
}

fn endpoint(
    element: &Element,
    binding: &Value,
    adjacent: Point,
    old: Point,
) -> Result<Point, BoardError> {
    let focus = binding
        .get("focus")
        .and_then(Value::as_f64)
        .filter(|n| (-1.0..=1.0).contains(n))
        .ok_or_else(|| invalid("invalid binding focus"))?;
    let gap = binding
        .get("gap")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.0)
        .ok_or_else(|| invalid("invalid binding gap"))?;
    let focus = focus_point(element, focus, adjacent)?;
    if gap == 0.0 {
        return Ok(focus);
    }
    let g = element.geometry()?;
    let vector = sub(focus, adjacent);
    if length(vector) == 0.0 {
        return Ok(old);
    }
    let reach = length(sub(adjacent, old))
        + length(sub(adjacent, g.center()))
        + g.width().max(g.height()) * 2.0;
    let far = add(adjacent, scale(vector, reach / length(vector)));
    let mut intersections = intersections(element, adjacent, far, gap)?;
    intersections.sort_by(|a, b| length(sub(*a, adjacent)).total_cmp(&length(sub(*b, adjacent))));
    Ok(match intersections.len() {
        0 => old,
        1 => focus,
        _ => intersections[0],
    })
}

fn radius(element: &Element, size: f64) -> f64 {
    match element
        .field("roundness")
        .and_then(|r| r.get("type"))
        .and_then(Value::as_u64)
    {
        Some(1 | 2) => size * 0.25,
        Some(3) => (size * 0.25).min(
            element
                .field("roundness")
                .and_then(|r| r.get("value"))
                .and_then(Value::as_f64)
                .unwrap_or(32.0),
        ),
        _ => 0.0,
    }
}

fn intersections(
    element: &Element,
    a: Point,
    b: Point,
    gap: f64,
) -> Result<Vec<Point>, BoardError> {
    let g = element.geometry()?;
    let a = g.world_to_local(a);
    let b = g.world_to_local(b);
    let d = sub(b, a);
    let w = g.width();
    let h = g.height();
    let mut found = Vec::new();
    if element.kind() == ElementKind::Ellipse {
        let p = sub(a, Point(w / 2.0, h / 2.0));
        let rx = w / 2.0 + gap;
        let ry = h / 2.0 + gap;
        let aa = (d.0 / rx).powi(2) + (d.1 / ry).powi(2);
        let bb = 2.0 * (p.0 * d.0 / rx.powi(2) + p.1 * d.1 / ry.powi(2));
        let cc = (p.0 / rx).powi(2) + (p.1 / ry).powi(2) - 1.0;
        let disc = bb * bb - 4.0 * aa * cc;
        if disc >= 0.0 && aa > 0.0 {
            for sign in [-1.0, 1.0] {
                found.push(add(a, scale(d, (-bb + sign * disc.sqrt()) / (2.0 * aa))));
            }
        }
    } else {
        let mut corners: Vec<[Point; 4]> = Vec::new();
        let mut sides = Vec::new();
        if element.kind() == ElementKind::Diamond {
            let tx = (w / 2.0).floor() + 1.0;
            let ry = (h / 2.0).floor() + 1.0;
            let vr = radius(element, tx);
            let hr = radius(element, ry);
            let vertices = [Point(w, ry), Point(tx, h), Point(0.0, ry), Point(tx, 0.0)];
            let starts = [
                Point(w - vr, ry - hr),
                Point(tx + vr, h - hr),
                Point(vr, ry + hr),
                Point(tx - vr, hr),
            ];
            let ends = [
                Point(w - vr, ry + hr),
                Point(tx - vr, h - hr),
                Point(vr, ry - hr),
                Point(tx + vr, hr),
            ];
            for i in 0..4 {
                let direction = sub(vertices[i], Point(w / 2.0, h / 2.0));
                let offset = if vr == 0.0 && hr == 0.0 {
                    [
                        Point(gap, 0.0),
                        Point(0.0, gap),
                        Point(-gap, 0.0),
                        Point(0.0, -gap),
                    ][i]
                } else {
                    scale(direction, gap / length(direction))
                };
                corners
                    .push([starts[i], vertices[i], vertices[i], ends[i]].map(|p| add(p, offset)));
            }
        } else {
            if !matches!(
                element.kind(),
                ElementKind::Rectangle
                    | ElementKind::Image
                    | ElementKind::Text
                    | ElementKind::Frame
                    | ElementKind::MagicFrame
                    | ElementKind::Iframe
                    | ElementKind::Embeddable
            ) {
                return Err(invalid("unsupported binding target"));
            }
            let r = radius(element, w.min(h));
            if r == 0.0 {
                let vertices = [
                    Point(-gap, -gap),
                    Point(w + gap, -gap),
                    Point(w + gap, h + gap),
                    Point(-gap, h + gap),
                ];
                for i in 0..4 {
                    sides.push((vertices[i], vertices[(i + 1) % 4]));
                }
            } else {
                let vertices = [Point(0.0, 0.0), Point(w, 0.0), Point(w, h), Point(0.0, h)];
                let starts = [
                    Point(0.0, r),
                    Point(w - r, 0.0),
                    Point(w, h - r),
                    Point(r, h),
                ];
                let ends = [
                    Point(r, 0.0),
                    Point(w, r),
                    Point(w - r, h),
                    Point(0.0, h - r),
                ];
                for i in 0..4 {
                    let direction = sub(
                        add(
                            vertices[i],
                            [
                                Point(-gap, -gap),
                                Point(gap, -gap),
                                Point(gap, gap),
                                Point(-gap, gap),
                            ][i],
                        ),
                        Point(w / 2.0, h / 2.0),
                    );
                    let offset = scale(direction, gap / length(direction));
                    corners.push(
                        [
                            starts[i],
                            add(starts[i], scale(sub(vertices[i], starts[i]), 2.0 / 3.0)),
                            add(ends[i], scale(sub(vertices[i], ends[i]), 2.0 / 3.0)),
                            ends[i],
                        ]
                        .map(|p| add(p, offset)),
                    );
                }
            }
        }
        for i in 0..corners.len() {
            sides.push((corners[i][3], corners[(i + 1) % corners.len()][0]));
        }
        for (p, q) in sides {
            let e = sub(q, p);
            let divisor = cross(d, e);
            if divisor.abs() > 1e-12 {
                let t = cross(sub(p, a), e) / divisor;
                let u = cross(sub(p, a), d) / divisor;
                if (0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&u) {
                    found.push(add(a, scale(d, t)));
                }
            }
        }
        for curve in corners {
            let evaluate = |t: f64| {
                add(
                    add(
                        scale(curve[0], (1.0 - t).powi(3)),
                        scale(curve[1], 3.0 * (1.0 - t).powi(2) * t),
                    ),
                    add(
                        scale(curve[2], 3.0 * (1.0 - t) * t * t),
                        scale(curve[3], t.powi(3)),
                    ),
                )
            };
            // Keep the upstream Newton solver's tolerance and iteration cap:
            // converging farther changes the stored endpoint, not just accuracy.
            for guess in [0.5, 0.2, 0.8] {
                let (mut t, mut u) = (guess, 0.0);
                let f = |t: f64, u: f64| sub(evaluate(t), add(a, scale(d, u)));
                let mut converged = false;
                for _ in 0..10 {
                    let value = f(t, u);
                    let dt = scale(sub(f(t + 1e-6, u), f(t - 1e-6, u)), 1.0 / (2e-6));
                    let du = scale(sub(f(t, u + 1e-6), f(t, u - 1e-6)), 1.0 / (2e-6));
                    let det = cross(dt, du);
                    if det == 0.0 {
                        break;
                    }
                    t += (du.1 / det) * (-value.0) + (-du.0 / det) * (-value.1);
                    u += (-dt.1 / det) * (-value.0) + (dt.0 / det) * (-value.1);
                    let error = f(t, u);
                    if error.0.abs().max(error.1.abs()) < 1e-3 {
                        converged = true;
                        break;
                    }
                }
                if converged && (0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&u) {
                    found.push(evaluate(t));
                    break;
                }
            }
        }
    }
    let mut unique = Vec::new();
    for p in found {
        if !unique.iter().any(|q| length(sub(p, *q)) < 1e-6) {
            unique.push(p);
        }
    }
    Ok(unique.into_iter().map(|p| g.local_to_world(p)).collect())
}
