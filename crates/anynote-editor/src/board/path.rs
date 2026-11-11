use super::{BoardError, Element, ElementKind, Geometry, Point, scene::invalid};
use serde_json::json;
use std::collections::BTreeMap;

pub(super) fn points(element: &Element) -> Result<Vec<Point>, BoardError> {
    if !matches!(
        element.kind(),
        ElementKind::Line | ElementKind::Arrow | ElementKind::Freedraw
    ) || element.field("elbowed") == Some(&json!(true))
    {
        return Err(invalid("requires a non-elbow path"));
    }
    let points: Vec<Point> = serde_json::from_value(
        element
            .field("points")
            .cloned()
            .ok_or_else(|| invalid("missing points"))?,
    )?;
    if points.len() < 2 {
        return Err(invalid("path needs two points"));
    }
    for point in &points {
        point.validate()?;
    }
    Ok(points)
}

pub(super) fn bounds(points: &[Point]) -> [f64; 4] {
    [
        points.iter().map(|p| p.0).fold(f64::INFINITY, f64::min),
        points.iter().map(|p| p.1).fold(f64::INFINITY, f64::min),
        points.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max),
        points.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max),
    ]
}

/// LinearElementEditor.movePoints normalizes the first point and compensates
/// for the changed rotation center so untouched vertices stay in world space.
pub(super) fn move_points(
    element: &mut Element,
    updates: &BTreeMap<usize, Point>,
) -> Result<(), BoardError> {
    let old = points(element)?;
    if old.len() > 2 && element.field("roundness").is_some_and(|v| !v.is_null()) {
        return Err(invalid("curved path control points require curve bounds"));
    }
    if updates.is_empty() {
        return Ok(());
    }
    for (index, point) in updates {
        if *index >= old.len() {
            return Err(invalid("point index out of bounds"));
        }
        point.validate()?;
    }
    let first = updates.get(&0).copied().unwrap_or(old[0]);
    let offset = Point(first.0 - old[0].0, first.1 - old[0].1);
    let next: Vec<_> = old
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let p = updates.get(&i).unwrap_or(p);
            Point(p.0 - offset.0, p.1 - offset.1)
        })
        .collect();
    let a = super::rough_path::bounds(element, &old, false)?;
    let b = super::rough_path::bounds(element, &next, false)?;
    let size = bounds(&next);
    let center_delta = Point(
        (a[0] + a[2] - b[0] - b[2]) / 2.0,
        (a[1] + a[3] - b[1] - b[3]) / 2.0,
    );
    let g = element.geometry()?;
    let shift = offset.rotate(center_delta, g.angle());
    Geometry::new(
        g.x() + shift.0,
        g.y() + shift.1,
        size[2] - size[0],
        size[3] - size[1],
        g.angle(),
    )?
    .write(element);
    element.fields.insert("points".into(), json!(next));
    Ok(())
}

pub(super) fn from_world(element: &Element, point: Point) -> Result<Point, BoardError> {
    let b = bounds(&points(element)?);
    let g = element.geometry()?;
    let point = point.rotate(
        Point(g.x() + (b[0] + b[2]) / 2.0, g.y() + (b[1] + b[3]) / 2.0),
        -g.angle(),
    );
    Ok(Point(point.0 - g.x(), point.1 - g.y()))
}
