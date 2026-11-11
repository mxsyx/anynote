//! Seeded path bounds from RoughJS 4.6.4 (see ROUGHJS-LICENSE).
//! Shared seeded linear strokes for bounds and native rendering.
use super::{BoardError, Element, ElementKind, Point, path, scene::invalid};
use serde_json::Value;

struct Random(u32);

/// Cubic strokes in world coordinates, using the same seed and rotation centre
/// as the operation kernel. Elbow routes and freehand pressure use other geometry.
pub fn linear_strokes(element: &Element) -> Result<Vec<[Point; 4]>, BoardError> {
    if !matches!(element.kind(), ElementKind::Line | ElementKind::Arrow) {
        return Err(invalid("requires a line or arrow"));
    }
    let points = path::points(element)?;
    let b = path::bounds(&points);
    let g = element.geometry()?;
    let center = Point(g.x() + (b[0] + b[2]) / 2.0, g.y() + (b[1] + b[3]) / 2.0);
    Ok(curves(element, &points)?
        .into_iter()
        .map(|curve| curve.map(|p| Point(g.x() + p.0, g.y() + p.1).rotate(center, g.angle())))
        .collect())
}
impl Random {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(48271);
        f64::from(self.0 & 0x7fff_ffff) / 2147483648.0
    }
    fn offset(&mut self, amount: f64, roughness: f64, gain: f64) -> f64 {
        roughness * gain * (self.next() * (amount * 2.0) - amount)
    }
}

pub(super) fn curves(element: &Element, points: &[Point]) -> Result<Vec<[Point; 4]>, BoardError> {
    let g = element.geometry()?;
    let original = element
        .field("roughness")
        .and_then(Value::as_f64)
        .unwrap_or(1.0);
    if !original.is_finite() || original < 0.0 {
        return Err(invalid("invalid path roughness"));
    }
    let max = g.width().max(g.height());
    let min = g.width().min(g.height());
    let rounded = element.field("roundness").is_some_and(|v| !v.is_null());
    let roughness = if min >= 20.0 && max >= 50.0
        || min >= 15.0 && rounded
        || matches!(element.kind(), ElementKind::Line | ElementKind::Arrow) && max >= 50.0
    {
        original
    } else {
        (original / if max < 10.0 { 3.0 } else { 2.0 }).min(2.5)
    };
    let seed = element.field("seed").and_then(Value::as_u64).unwrap_or(0) as u32;
    if seed == 0 && roughness != 0.0 {
        return Err(invalid("rough path geometry requires a nonzero seed"));
    }
    let mut random = Random(seed);
    let preserve = original < 2.0;
    let overlays = if element
        .field("strokeStyle")
        .and_then(Value::as_str)
        .unwrap_or("solid")
        == "solid"
    {
        2
    } else {
        1
    };
    let mut curves = Vec::with_capacity(points.len().saturating_sub(1) * overlays);
    if rounded {
        for overlay in 0..overlays {
            let mut random = Random(seed.wrapping_add(overlay as u32));
            let offset = if overlay == 0 {
                1.0 + roughness * 0.2
            } else {
                1.5 * (1.0 + roughness * 0.22)
            };
            let mut jitter = |p: Point| {
                Point(
                    p.0 + random.offset(offset, roughness, 1.0),
                    p.1 + random.offset(offset, roughness, 1.0),
                )
            };
            let mut vertices = Vec::with_capacity(points.len() + 2);
            vertices.push(jitter(points[0]));
            vertices.extend(points.iter().copied().map(&mut jitter));
            vertices.push(jitter(*points.last().unwrap()));
            for p in vertices.windows(4) {
                curves.push([
                    p[1],
                    Point(
                        p[1].0 + (p[2].0 - p[0].0) / 6.0,
                        p[1].1 + (p[2].1 - p[0].1) / 6.0,
                    ),
                    Point(
                        p[2].0 + (p[1].0 - p[3].0) / 6.0,
                        p[2].1 + (p[1].1 - p[3].1) / 6.0,
                    ),
                    p[2],
                ]);
            }
        }
        return Ok(curves);
    }
    for segment in points.windows(2) {
        let [a, b] = [segment[0], segment[1]];
        for overlay in 0..overlays {
            let length_sq = (a.0 - b.0).powi(2) + (a.1 - b.1).powi(2);
            let length = length_sq.sqrt();
            let gain = if length < 200.0 {
                1.0
            } else if length > 500.0 {
                0.4
            } else {
                -0.0016668 * length + 1.233334
            };
            let offset = if 400.0 > length_sq {
                length / 10.0
            } else {
                2.0
            };
            let diverge = 0.2 + random.next() * 0.2;
            let mx = random.offset(2.0 * (b.1 - a.1) / 200.0, roughness, gain);
            let my = random.offset(2.0 * (a.0 - b.0) / 200.0, roughness, gain);
            let offset = if overlay == 1 { offset / 2.0 } else { offset };
            let mut jitter = || random.offset(offset, roughness, gain);
            let start = if preserve {
                a
            } else {
                Point(a.0 + jitter(), a.1 + jitter())
            };
            let first = Point(
                mx + a.0 + (b.0 - a.0) * diverge + jitter(),
                my + a.1 + (b.1 - a.1) * diverge + jitter(),
            );
            let second = Point(
                mx + a.0 + 2.0 * (b.0 - a.0) * diverge + jitter(),
                my + a.1 + 2.0 * (b.1 - a.1) * diverge + jitter(),
            );
            let end = if preserve {
                b
            } else {
                Point(b.0 + jitter(), b.1 + jitter())
            };
            curves.push([start, first, second, end]);
        }
    }
    Ok(curves)
}

pub(super) fn bounds(
    element: &Element,
    points: &[Point],
    world: bool,
) -> Result<[f64; 4], BoardError> {
    let g = element.geometry()?;
    let b = path::bounds(points);
    let center = Point(g.x() + (b[0] + b[2]) / 2.0, g.y() + (b[1] + b[3]) / 2.0);
    let mut bounds = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    for curve in curves(element, points)? {
        let curve = if world {
            curve.map(|p| Point(g.x() + p.0, g.y() + p.1).rotate(center, g.angle()))
        } else {
            curve
        };
        for axis in 0..2 {
            let values = curve.map(|p| if axis == 0 { p.0 } else { p.1 });
            let [p0, p1, p2, p3] = values;
            let (i, j, k) = (p1 - p0, p2 - p1, p3 - p2);
            let (a, b, c) = (3.0 * i - 6.0 * j + 3.0 * k, 6.0 * j - 6.0 * i, 3.0 * i);
            let disc = b * b - 4.0 * a * c;
            let mut min = p0.min(p3);
            let mut max = p0.max(p3);
            if disc >= 0.0 {
                for t in if a == 0.0 {
                    [-c / b, -c / b]
                } else {
                    [
                        (-b + disc.sqrt()) / (2.0 * a),
                        (-b - disc.sqrt()) / (2.0 * a),
                    ]
                } {
                    if (0.0..=1.0).contains(&t) {
                        let v = (1.0 - t).powi(3) * p0
                            + 3.0 * (1.0 - t).powi(2) * t * p1
                            + 3.0 * (1.0 - t) * t.powi(2) * p2
                            + t.powi(3) * p3;
                        min = min.min(v);
                        max = max.max(v);
                    }
                }
            }
            bounds[axis] = bounds[axis].min(min);
            bounds[axis + 2] = bounds[axis + 2].max(max);
        }
    }
    if !bounds.iter().all(|v| v.is_finite()) {
        return Err(invalid("nonfinite rough path bounds"));
    }
    Ok(bounds)
}
