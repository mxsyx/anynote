use super::{BoardError, Element, ElementKind, Geometry, Point, Scene, path, scene::invalid};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};

fn frame_like(e: &Element) -> bool {
    matches!(e.kind(), ElementKind::Frame | ElementKind::MagicFrame)
}
fn contains(a: [f64; 4], b: [f64; 4]) -> bool {
    a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3]
}

fn outline(e: &Element) -> Result<Vec<Point>, BoardError> {
    let g = e.geometry()?;
    if matches!(
        e.kind(),
        ElementKind::Line | ElementKind::Arrow | ElementKind::Freedraw
    ) {
        // Excalidraw frame intersection uses the control polygon even for curves;
        // full containment below uses the seeded Bezier extrema instead.
        return e.world_points();
    }
    if e.kind() == ElementKind::Unknown {
        return Err(invalid("frame membership requires known geometry"));
    }
    let mut points = if matches!(e.kind(), ElementKind::Diamond | ElementKind::Ellipse) {
        vec![
            Point(g.width() / 2.0, 0.0),
            Point(g.width(), g.height() / 2.0),
            Point(g.width() / 2.0, g.height()),
            Point(0.0, g.height() / 2.0),
        ]
        .into_iter()
        .map(|p| g.local_to_world(p))
        .collect::<Vec<_>>()
    } else {
        g.corners().to_vec()
    };
    points.push(points[0]);
    Ok(points)
}
fn crosses(a: &[Point], b: &[Point]) -> bool {
    let side = |a: Point, b: Point, p: Point| (b.0 - a.0) * (p.1 - a.1) - (b.1 - a.1) * (p.0 - a.0);
    a.windows(2).any(|a| {
        b.windows(2).any(|b| {
            let aa = path::bounds(a);
            let bb = path::bounds(b);
            aa[0] <= bb[2]
                && aa[2] >= bb[0]
                && aa[1] <= bb[3]
                && aa[3] >= bb[1]
                && side(a[0], a[1], b[0]) * side(a[0], a[1], b[1]) <= 0.0
                && side(b[0], b[1], a[0]) * side(b[0], b[1], a[1]) <= 0.0
        })
    })
}

pub(super) fn resize(scene: &mut Scene, id: &str, geometry: Geometry) -> Result<(), BoardError> {
    geometry.validate()?;
    let frame = scene.element(id).ok_or_else(|| invalid("missing frame"))?;
    if !frame_like(frame) || geometry.angle() != 0.0 || frame.geometry()?.angle() != 0.0 {
        return Err(invalid("requires an unrotated frame"));
    }
    geometry.write(scene.edit(id)?);
    let frame = scene.element(id).unwrap();
    let frame_outline = outline(frame)?;
    let frame_bounds = path::bounds(&frame_outline);
    let excluded_groups: BTreeSet<_> = scene
        .elements()
        .filter(|e| !e.is_deleted() && frame_like(e))
        .flat_map(Element::group_ids)
        .collect();
    let candidates: Vec<_> = scene
        .elements()
        .filter(|e| !e.is_deleted() && !frame_like(e) && e.reference("containerId").is_none())
        .collect();
    let mut complete = BTreeSet::new();
    let mut intersect = BTreeSet::new();
    let mut extents = BTreeMap::new();
    let mut keep_groups = BTreeSet::new();
    let mut next = BTreeSet::new();
    for e in &candidates {
        let points = outline(e)?;
        let b = super::geometry::element_bounds(e)?;
        extents.insert(e.id(), b);
        let existing = e.reference("frameId") == Some(id);
        let eligible = e.reference("frameId").is_none_or(|frame| frame == id)
            && !e.group_ids().iter().any(|g| excluded_groups.contains(g));
        if eligible && (contains(frame_bounds, b) || existing && contains(b, frame_bounds)) {
            complete.insert(e.id());
        }
        if existing && crosses(&points, &frame_outline) {
            intersect.insert(e.id());
        }
        if existing {
            next.insert(e.id());
        }
    }
    for e in &candidates {
        if complete.contains(e.id()) || intersect.contains(e.id()) {
            keep_groups.extend(e.group_ids());
        }
    }
    for e in &candidates {
        if !complete.contains(e.id())
            && e.reference("frameId") == Some(id)
            && (e.group_ids().is_empty() && !intersect.contains(e.id())
                || !e.group_ids().is_empty()
                    && !e.group_ids().iter().any(|g| keep_groups.contains(g)))
        {
            next.remove(e.id());
        }
        if complete.contains(e.id()) {
            if let Some(group) = e.group_ids().last() {
                let members: Vec<_> = candidates
                    .iter()
                    .filter(|e| e.group_ids().contains(group))
                    .collect();
                if members
                    .iter()
                    .all(|e| contains(frame_bounds, extents[e.id()]))
                {
                    next.extend(members.iter().map(|e| e.id()));
                }
            } else {
                next.insert(e.id());
            }
        }
    }
    let updates: Vec<_> = scene
        .elements()
        .filter(|e| !e.is_deleted() && !frame_like(e))
        .filter_map(|e| {
            let owner = e.reference("containerId").unwrap_or(e.id());
            let target = if next.contains(owner) {
                Some(id)
            } else if e.reference("frameId") == Some(id) {
                None
            } else {
                return None;
            };
            (e.reference("frameId") != target)
                .then(|| (e.id().to_owned(), target.map(str::to_owned)))
        })
        .collect();
    for (id, frame) in updates {
        scene
            .edit(&id)?
            .fields
            .insert("frameId".into(), json!(frame));
    }
    Ok(())
}
