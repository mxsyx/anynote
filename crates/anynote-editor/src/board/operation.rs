use super::command::Snapshot;
use super::{
    Alignment, Axis, BoardError, Command, Element, ElementKind, Geometry, Layer, Point, Scene,
    scene::invalid,
};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

pub(super) fn active<'a>(scene: &'a Scene, id: &str) -> Result<&'a Element, BoardError> {
    scene
        .element(id)
        .filter(|e| !e.is_deleted())
        .ok_or_else(|| invalid(format!("missing live element: {id}")))
}
fn editable<'a>(scene: &'a Scene, id: &str) -> Result<&'a Element, BoardError> {
    let element = active(scene, id)?;
    if element.is_locked() {
        return Err(invalid(format!("element is locked: {id}")));
    }
    if element.kind() == ElementKind::Unknown {
        return Err(invalid(format!("unknown element is preserve-only: {id}")));
    }
    Ok(element)
}
pub(super) fn selectable_groups<'a>(element: &'a Element, editing: Option<&str>) -> Vec<&'a str> {
    let groups = element.group_ids();
    let end = editing
        .and_then(|id| groups.iter().position(|group| *group == id))
        .unwrap_or(groups.len());
    groups[..end].to_vec()
}
pub(super) fn expand_selection(
    scene: &Scene,
    mut selected: BTreeSet<String>,
    editing: Option<&str>,
) -> BTreeSet<String> {
    loop {
        let old_len = selected.len();
        let groups: BTreeSet<_> = scene
            .elements()
            .filter(|e| selected.contains(e.id()))
            .flat_map(|e| selectable_groups(e, editing))
            .collect();
        for e in scene.elements().filter(|e| !e.is_deleted()) {
            if e.group_ids().iter().any(|group| groups.contains(group))
                || ["containerId", "frameId"]
                    .iter()
                    .any(|name| e.reference(name).is_some_and(|id| selected.contains(id)))
            {
                selected.insert(e.id().to_owned());
            }
        }
        if old_len == selected.len() {
            return selected;
        }
    }
}
fn set(scene: &mut Scene, id: &str, name: &str, value: Value) -> Result<(), BoardError> {
    scene.edit(id)?.fields.insert(name.into(), value);
    Ok(())
}
pub(super) fn execute(state: &mut Snapshot, command: &Command) -> Result<(), BoardError> {
    let selected = state.selected.clone();
    let editing = state.editing_group.as_deref();
    let before_geometry = matches!(
        command,
        Command::Translate { .. }
            | Command::Geometry { .. }
            | Command::CropImage { .. }
            | Command::ResizePath { .. }
            | Command::MovePoints { .. }
            | Command::AddPoints { .. }
            | Command::DeletePoints { .. }
            | Command::Points { .. }
    )
    .then(|| state.scene.clone());
    let scene = &mut state.scene;
    if !matches!(
        command,
        Command::Lock { .. }
            | Command::View { .. }
            | Command::Insert { .. }
            | Command::Paste { .. }
            | Command::Geometry { .. }
            | Command::ResizePath { .. }
            | Command::CropImage { .. }
            | Command::Text { .. }
            | Command::Points { .. }
            | Command::MovePoints { .. }
            | Command::AddPoints { .. }
            | Command::DeletePoints { .. }
            | Command::ResizeFrame { .. }
            | Command::BindText { .. }
            | Command::BindArrow { .. }
    ) {
        for id in &selected {
            editable(scene, id)?;
        }
    }
    match command {
        Command::Paste {
            clipboard,
            ids,
            delta,
        } => {
            let insert = clipboard.insert(scene, ids, *delta)?;
            execute(state, &insert)?;
            state.editing_group = None;
            return Ok(());
        }
        Command::Insert { elements, files } => {
            let mut new_ids = BTreeSet::new();
            for value in elements {
                let element = Element::from_json(value.clone())?;
                if element.kind() == ElementKind::Unknown
                    || scene.element(element.id()).is_some()
                    || !new_ids.insert(element.id().to_owned())
                {
                    return Err(invalid("insert requires fresh known element IDs"));
                }
                scene.elements.push(Arc::new(element));
            }
            let target = Arc::make_mut(&mut scene.fields)
                .entry("files")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or_else(|| invalid("invalid files"))?;
            for (id, file) in files {
                if target.get(id).is_some_and(|existing| existing != file) {
                    return Err(invalid("file ID collision"));
                }
                if !file.is_object() {
                    return Err(invalid("file must be an object"));
                }
                target.insert(id.clone(), file.clone());
            }
            for id in &new_ids {
                let e = active(scene, id)?;
                if let Some(file) = e.reference("fileId")
                    && scene
                        .field("files")
                        .and_then(|files| files.get(file))
                        .is_none()
                {
                    return Err(invalid("missing image file"));
                }
            }
            state.selected = new_ids;
            reindex(scene)?;
        }
        Command::Translate { delta } => {
            delta.validate()?;
            if *delta == Point(0.0, 0.0) {
                return Ok(());
            }
            require_closed_text_bindings(scene, &selected)?;
            for id in &selected {
                let geometry = editable(scene, id)?.geometry()?.translated(*delta)?;
                geometry.write(scene.edit(id)?);
            }
        }
        Command::Align { axis, alignment } => {
            let bounds = transform_groups(scene, &selected, editing)?;
            if bounds.len() < 2 {
                return Ok(());
            }
            let dimension = if matches!(axis, Axis::X) { 0 } else { 1 };
            let min = bounds
                .iter()
                .map(|(_, b)| b[dimension])
                .fold(f64::INFINITY, f64::min);
            let max = bounds
                .iter()
                .map(|(_, b)| b[dimension + 2])
                .fold(f64::NEG_INFINITY, f64::max);
            for (ids, bounds) in bounds {
                let delta = match alignment {
                    Alignment::Start => min - bounds[dimension],
                    Alignment::End => max - bounds[dimension + 2],
                    Alignment::Center => {
                        (min + max - bounds[dimension] - bounds[dimension + 2]) / 2.0
                    }
                };
                for id in ids {
                    move_on_axis(scene, &id, *axis, delta)?;
                }
            }
        }
        Command::Distribute { axis } => {
            let mut bounds = transform_groups(scene, &selected, editing)?;
            if bounds.len() < 2 {
                return Ok(());
            }
            let dimension = if matches!(axis, Axis::X) { 0 } else { 1 };
            bounds.sort_by(|(_, a), (_, b)| {
                (a[dimension] + a[dimension + 2]).total_cmp(&(b[dimension] + b[dimension + 2]))
            });
            let min = bounds
                .iter()
                .map(|(_, b)| b[dimension])
                .fold(f64::INFINITY, f64::min);
            let max = bounds
                .iter()
                .map(|(_, b)| b[dimension + 2])
                .fold(f64::NEG_INFINITY, f64::max);
            let total: f64 = bounds
                .iter()
                .map(|(_, b)| b[dimension + 2] - b[dimension])
                .sum();
            let gap = (max - min - total) / (bounds.len() - 1) as f64;
            if gap < 0.0 {
                let first = bounds
                    .iter()
                    .position(|(_, b)| b[dimension] == min)
                    .unwrap();
                let last = bounds
                    .iter()
                    .position(|(_, b)| b[dimension + 2] == max)
                    .unwrap();
                let center = |b: &[f64; 4]| (b[dimension] + b[dimension + 2]) / 2.0;
                let step = (center(&bounds[last].1) - center(&bounds[first].1))
                    / (bounds.len() - 1) as f64;
                let mut cursor = center(&bounds[first].1);
                for (index, (ids, b)) in bounds.into_iter().enumerate() {
                    if index != first && index != last {
                        cursor += step;
                        for id in ids {
                            move_on_axis(scene, &id, *axis, cursor - center(&b))?;
                        }
                    }
                }
            } else {
                let mut cursor = min;
                for (ids, b) in bounds {
                    for id in ids {
                        move_on_axis(scene, &id, *axis, cursor - b[dimension])?;
                    }
                    cursor += b[dimension + 2] - b[dimension] + gap;
                }
            }
        }

        Command::Flip { axis } => {
            if !selected.is_empty()
                && selected.iter().all(|id| {
                    scene.element(id).is_some_and(|e| {
                        e.kind() == ElementKind::Arrow
                            && ["startBinding", "endBinding"]
                                .iter()
                                .any(|key| e.field(key).is_some_and(|v| !v.is_null()))
                    })
                })
            {
                for id in &selected {
                    let e = active(scene, id)?;
                    let start = e.field("startArrowhead").cloned().unwrap_or(Value::Null);
                    let end = e.field("endArrowhead").cloned().unwrap_or(Value::Null);
                    set(scene, id, "startArrowhead", end)?;
                    set(scene, id, "endArrowhead", start)?;
                }
                return Ok(());
            }
            let bounds = independent_bounds(scene, &selected, false)?;
            if bounds.is_empty() {
                return Ok(());
            }
            let dimension = if matches!(axis, Axis::X) { 0 } else { 1 };
            let min = bounds
                .iter()
                .map(|(_, b)| b[dimension])
                .fold(f64::INFINITY, f64::min);
            let max = bounds
                .iter()
                .map(|(_, b)| b[dimension + 2])
                .fold(f64::NEG_INFINITY, f64::max);
            let center = Point(
                (bounds
                    .iter()
                    .map(|(_, b)| b[0])
                    .fold(f64::INFINITY, f64::min)
                    + bounds
                        .iter()
                        .map(|(_, b)| b[2])
                        .fold(f64::NEG_INFINITY, f64::max))
                    / 2.0,
                (bounds
                    .iter()
                    .map(|(_, b)| b[1])
                    .fold(f64::INFINITY, f64::min)
                    + bounds
                        .iter()
                        .map(|(_, b)| b[3])
                        .fold(f64::NEG_INFINITY, f64::max))
                    / 2.0,
            );
            let mut transformed_path = false;
            for (id, _) in bounds {
                let element = active(scene, &id)?;
                if element.kind() == ElementKind::Text {
                    return Err(invalid("text flip requires text layout"));
                }
                let g = element.geometry()?;
                if matches!(
                    element.kind(),
                    ElementKind::Line | ElementKind::Arrow | ElementKind::Freedraw
                ) {
                    let mut points = super::path::points(element)?;
                    let extents = super::path::bounds(&points);
                    let sx = if extents[2] == extents[0] {
                        1.0
                    } else {
                        g.width() / (extents[2] - extents[0])
                    };
                    let sy = if extents[3] == extents[1] {
                        1.0
                    } else {
                        g.height() / (extents[3] - extents[1])
                    };
                    transformed_path = true;
                    for point in &mut points {
                        point.0 *= sx;
                        point.1 *= sy;
                        if dimension == 0 {
                            point.0 = -point.0;
                        } else {
                            point.1 = -point.1;
                        }
                    }
                    Geometry::new(
                        if dimension == 0 {
                            min + max - g.x()
                        } else {
                            g.x()
                        },
                        if dimension == 1 {
                            min + max - g.y()
                        } else {
                            g.y()
                        },
                        g.width(),
                        g.height(),
                        (-g.angle()).rem_euclid(std::f64::consts::TAU),
                    )?
                    .write(scene.edit(&id)?);
                    set(scene, &id, "points", json!(points))?;
                    continue;
                }
                let next = Geometry::new(
                    if dimension == 0 {
                        min + max - g.x() - g.width()
                    } else {
                        g.x()
                    },
                    if dimension == 1 {
                        min + max - g.y() - g.height()
                    } else {
                        g.y()
                    },
                    g.width(),
                    g.height(),
                    (-g.angle()).rem_euclid(std::f64::consts::TAU),
                )?;
                if element.kind() == ElementKind::Image {
                    let mut scale = element
                        .field("scale")
                        .and_then(Value::as_array)
                        .cloned()
                        .ok_or_else(|| invalid("missing image scale"))?;
                    if scale.len() != 2 {
                        return Err(invalid("invalid image scale"));
                    }
                    let value = scale[dimension]
                        .as_f64()
                        .filter(|value| value.abs() == 1.0)
                        .ok_or_else(|| invalid("invalid image scale"))?;
                    scale[dimension] = json!(-value);
                    set(scene, &id, "scale", json!(scale))?;
                }
                next.write(scene.edit(&id)?);
            }
            if transformed_path {
                let next = independent_bounds(scene, &selected, false)?;
                let dx = center.0
                    - (next.iter().map(|(_, b)| b[0]).fold(f64::INFINITY, f64::min)
                        + next
                            .iter()
                            .map(|(_, b)| b[2])
                            .fold(f64::NEG_INFINITY, f64::max))
                        / 2.0;
                let dy = center.1
                    - (next.iter().map(|(_, b)| b[1]).fold(f64::INFINITY, f64::min)
                        + next
                            .iter()
                            .map(|(_, b)| b[3])
                            .fold(f64::NEG_INFINITY, f64::max))
                        / 2.0;
                for id in &selected {
                    active(scene, id)?
                        .geometry()?
                        .translated(Point(dx, dy))?
                        .write(scene.edit(id)?);
                }
            }
        }
        Command::CropImage {
            id,
            handle,
            natural_width,
            natural_height,
            pointer,
            aspect_ratio,
        } => {
            let element = editable(scene, id)?;
            if element.kind() != ElementKind::Image {
                return Err(invalid("not an image"));
            }
            require_no_text_layout(element)?;
            super::crop::crop_image(
                scene.edit(id)?,
                *handle,
                *natural_width,
                *natural_height,
                *pointer,
                *aspect_ratio,
            )?;
        }
        Command::ResizePath { id, geometry } => {
            geometry.validate()?;
            let element = editable(scene, id)?;
            require_no_text_layout(element)?;
            if !matches!(
                element.kind(),
                ElementKind::Line | ElementKind::Arrow | ElementKind::Freedraw
            ) || element.field("elbowed") == Some(&json!(true))
            {
                return Err(invalid("requires a non-elbow path"));
            }
            let mut points: Vec<Point> = serde_json::from_value(
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
            let bounds = super::path::bounds(&points);
            let width = bounds[2] - bounds[0];
            let height = bounds[3] - bounds[1];
            if (width == 0.0 && geometry.width() != 0.0)
                || (height == 0.0 && geometry.height() != 0.0)
            {
                return Err(invalid("cannot expand a degenerate path dimension"));
            }
            let sx = if width == 0.0 {
                1.0
            } else {
                geometry.width() / width
            };
            let sy = if height == 0.0 {
                1.0
            } else {
                geometry.height() / height
            };
            for point in &mut points {
                *point = Point(point.x() * sx, point.y() * sy);
                point.validate()?;
            }
            set(scene, id, "points", json!(points))?;
            geometry.write(scene.edit(id)?);
        }
        Command::Geometry { id, geometry } => {
            geometry.validate()?;
            let e = editable(scene, id)?;
            require_no_text_layout(e)?;
            if matches!(
                e.kind(),
                ElementKind::Text
                    | ElementKind::Line
                    | ElementKind::Arrow
                    | ElementKind::Freedraw
                    | ElementKind::Frame
                    | ElementKind::MagicFrame
            ) {
                return Err(invalid(
                    "geometry change requires text/path/frame-specific layout",
                ));
            }
            geometry.write(scene.edit(id)?);
        }
        Command::Style { properties } => {
            validate_style(properties)?;
            for id in &selected {
                for (key, value) in properties {
                    if key == "strokeColor"
                        && matches!(
                            active(scene, id)?.kind(),
                            ElementKind::Image | ElementKind::Frame | ElementKind::MagicFrame
                        )
                    {
                        continue;
                    }
                    set(scene, id, key, value.clone())?;
                }
            }
        }
        Command::Roughness { value, seeds } => {
            if !value.is_finite()
                || *value < 0.0
                || seeds.keys().cloned().collect::<BTreeSet<_>>() != selected
            {
                return Err(invalid(
                    "roughness requires finite value and one seed per selected element",
                ));
            }
            for (id, seed) in seeds {
                set(scene, id, "roughness", json!(value))?;
                set(scene, id, "seed", json!(seed))?;
            }
        }
        Command::Text { id, text, geometry } => {
            geometry.validate()?;
            let element = editable(scene, id)?;
            if element.kind() != ElementKind::Text {
                return Err(invalid("not a text element"));
            }
            require_unbound(element)?;
            set(scene, id, "text", json!(text))?;
            set(scene, id, "originalText", json!(text))?;
            geometry.write(scene.edit(id)?);
        }
        Command::Points {
            id,
            points,
            pressures,
        } => {
            let e = editable(scene, id)?;
            if !matches!(
                e.kind(),
                ElementKind::Line | ElementKind::Arrow | ElementKind::Freedraw
            ) {
                return Err(invalid("not a path"));
            }
            require_no_text_layout(e)?;
            if e.field("elbowed") == Some(&json!(true)) {
                return Err(invalid("elbow routing not implemented"));
            }
            if points.len() < 2 || points[0] != Point(0.0, 0.0) {
                return Err(invalid("path needs two points and a local zero origin"));
            }
            for point in points {
                point.validate()?;
            }
            if let Some(pressures) = pressures {
                if e.kind() != ElementKind::Freedraw
                    || pressures.len() != points.len()
                    || pressures
                        .iter()
                        .any(|p| !p.is_finite() || !(0.0..=1.0).contains(p))
                {
                    return Err(invalid("invalid stroke pressures"));
                }
            } else if e.kind() == ElementKind::Freedraw
                && e.field("simulatePressure") != Some(&json!(true))
            {
                return Err(invalid("pressure samples required"));
            }
            let min_x = points.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
            let max_x = points.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max);
            let min_y = points.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
            let max_y = points.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
            set(scene, id, "points", json!(points))?;
            set(scene, id, "width", json!(max_x - min_x))?;
            set(scene, id, "height", json!(max_y - min_y))?;
            if let Some(pressures) = pressures {
                set(scene, id, "pressures", json!(pressures))?;
            }
        }
        Command::MovePoints { id, updates } => {
            require_no_text_layout(editable(scene, id)?)?;
            let points: BTreeMap<_, _> = updates.iter().copied().collect();
            if points.len() != updates.len() {
                return Err(invalid("duplicate point index"));
            }
            super::path::move_points(scene.edit(id)?, &points)?;
        }
        Command::AddPoints { id, points } => {
            require_no_text_layout(editable(scene, id)?)?;
            super::path::add_points(scene.edit(id)?, points)?;
        }
        Command::DeletePoints { id, indices } => {
            require_no_text_layout(editable(scene, id)?)?;
            super::path::delete_points(scene.edit(id)?, indices)?;
        }
        Command::Group { id } => {
            if selected.len() < 2 {
                return Ok(());
            }
            if id.is_empty()
                || scene
                    .elements()
                    .any(|e| e.group_ids().contains(&id.as_str()))
            {
                return Err(invalid("group ID must be fresh"));
            }
            if selected.iter().any(|id| {
                matches!(
                    scene.element(id).map(Element::kind),
                    Some(ElementKind::Frame | ElementKind::MagicFrame)
                )
            }) {
                return Err(invalid("frame grouping requires frame reconciliation"));
            }
            let frames: BTreeSet<_> = selected
                .iter()
                .map(|id| {
                    scene
                        .element(id)
                        .and_then(|e| e.reference("frameId"))
                        .map(str::to_owned)
                })
                .collect();
            for element_id in &selected {
                let mut groups: Vec<_> = active(scene, element_id)?
                    .group_ids()
                    .into_iter()
                    .map(str::to_owned)
                    .collect();
                let position = editing
                    .and_then(|id| groups.iter().position(|group| group == id))
                    .unwrap_or(groups.len());
                groups.insert(position, id.clone());
                set(scene, element_id, "groupIds", json!(groups))?;
                if frames.len() > 1 {
                    set(scene, element_id, "frameId", Value::Null)?;
                }
            }
            let last = scene
                .elements
                .iter()
                .rposition(|e| selected.contains(e.id()))
                .ok_or_else(|| invalid("empty group"))?;
            let mut before = Vec::new();
            let mut group = Vec::new();
            let mut after = Vec::new();
            for (ix, e) in scene.elements.drain(..).enumerate() {
                if selected.contains(e.id()) {
                    group.push(e);
                } else if ix < last {
                    before.push(e);
                } else {
                    after.push(e);
                }
            }
            before.extend(group);
            before.extend(after);
            scene.elements = before;
            reindex(scene)?;
        }
        Command::Ungroup { id } => {
            let ids: Vec<_> = scene
                .elements()
                .filter(|e| !e.is_deleted() && e.group_ids().contains(&id.as_str()))
                .map(|e| e.id().to_owned())
                .collect();
            for element_id in ids {
                editable(scene, &element_id)?;
                let groups: Vec<_> = active(scene, &element_id)?
                    .group_ids()
                    .into_iter()
                    .filter(|group| *group != id)
                    .map(str::to_owned)
                    .collect();
                set(scene, &element_id, "groupIds", json!(groups))?;
            }
        }
        Command::Layer { layer } => {
            reorder(scene, &selected, *layer, editing)?;
        }
        Command::Delete => {
            for id in &selected {
                set(scene, id, "isDeleted", json!(true))?;
            }
            detach_references(scene, &selected)?;
            state.selected.clear();
        }
        Command::Duplicate {
            ids,
            groups,
            seeds,
            delta,
        } => {
            delta.validate()?;
            if ids.keys().cloned().collect::<BTreeSet<_>>() != selected
                || seeds.keys().cloned().collect::<BTreeSet<_>>() != selected
            {
                return Err(invalid(
                    "duplicate requires IDs and seeds for the expanded selection",
                ));
            }
            let mut fresh = BTreeSet::new();
            for id in ids.values() {
                if id.is_empty() || scene.element(id).is_some() || !fresh.insert(id) {
                    return Err(invalid("duplicate ID collision"));
                }
            }
            let old_groups: BTreeSet<_> = selected
                .iter()
                .flat_map(|id| {
                    scene
                        .element(id)
                        .into_iter()
                        .flat_map(|e| selectable_groups(e, editing))
                })
                .map(str::to_owned)
                .collect();
            if groups.keys().cloned().collect::<BTreeSet<_>>() != old_groups {
                return Err(invalid("duplicate requires group ID mapping"));
            }
            let mut fresh_groups = BTreeSet::new();
            for id in groups.values() {
                if id.is_empty()
                    || !fresh_groups.insert(id)
                    || scene
                        .elements()
                        .any(|e| e.group_ids().contains(&id.as_str()))
                {
                    return Err(invalid("duplicate group ID collision"));
                }
            }
            let cluster = |element: &Element| {
                if let Some(group) = selectable_groups(element, editing).last() {
                    return format!("group:{group}");
                }
                if let Some(frame) = element
                    .reference("frameId")
                    .filter(|id| selected.contains(*id))
                {
                    return format!("element:{frame}");
                }
                if let Some(container) = element
                    .reference("containerId")
                    .filter(|id| selected.contains(*id))
                {
                    return format!("element:{container}");
                }
                format!("element:{}", element.id())
            };
            let slots: BTreeMap<_, _> = scene
                .elements
                .iter()
                .enumerate()
                .filter(|(_, e)| selected.contains(e.id()))
                .map(|(ix, e)| (cluster(e), ix))
                .collect();
            let mut copies: BTreeMap<usize, Vec<Arc<Element>>> = BTreeMap::new();
            for element in &scene.elements {
                if ids.contains_key(element.id()) {
                    let mut copy = super::transfer::remap(element, ids, groups, *delta, true)?;
                    copy.fields
                        .insert("seed".into(), json!(seeds[element.id()]));
                    copies
                        .entry(slots[&cluster(element)])
                        .or_default()
                        .push(Arc::new(copy));
                }
            }
            let mut result = Vec::with_capacity(scene.elements.len() + selected.len());
            for (ix, element) in scene.elements.iter().enumerate() {
                result.push(element.clone());
                if let Some(copies) = copies.remove(&ix) {
                    result.extend(copies);
                }
            }
            scene.elements = result;
            state.selected = ids.values().cloned().collect();
            reindex(scene)?;
        }
        Command::Lock { locked } => {
            for id in &selected {
                if active(scene, id)?.kind() == ElementKind::Unknown {
                    return Err(invalid("unknown element is preserve-only"));
                }
                set(scene, id, "locked", json!(locked))?;
            }
        }
        Command::Frame { id } => {
            if let Some(id) = id {
                let frame = editable(scene, id)?;
                if !matches!(frame.kind(), ElementKind::Frame | ElementKind::MagicFrame)
                    || selected.contains(id)
                {
                    return Err(invalid("invalid frame target"));
                }
            }
            for element_id in &selected {
                if matches!(
                    active(scene, element_id)?.kind(),
                    ElementKind::Frame | ElementKind::MagicFrame
                ) {
                    return Err(invalid("nested frames unsupported"));
                }
                set(scene, element_id, "frameId", json!(id))?;
            }
        }
        Command::ResizeFrame { id, geometry } => {
            editable(scene, id)?;
            let before = scene.clone();
            super::frame::resize(scene, id, *geometry)?;
            super::binding::reconcile(&before, scene)?;
            if selected.contains(id) {
                let roots = selected
                    .into_iter()
                    .filter(|selected| {
                        before
                            .element(selected)
                            .is_none_or(|e| e.reference("frameId") != Some(id))
                    })
                    .collect();
                state.selected = expand_selection(scene, roots, editing);
            }
        }
        Command::BindText { text, container } => bind_text(scene, text, container.as_deref())?,
        Command::BindArrow {
            arrow,
            end,
            binding,
        } => bind_arrow(scene, arrow, *end, binding.as_ref())?,
        Command::View { properties } => {
            for (key, value) in properties {
                let valid = match key.as_str() {
                    "viewBackgroundColor" => value.is_string(),
                    "scrollX" | "scrollY" => value.as_f64().is_some_and(f64::is_finite),
                    "zoom" => value
                        .get("value")
                        .and_then(Value::as_f64)
                        .is_some_and(|v| v.is_finite() && v > 0.0),
                    _ => false,
                };
                if !valid {
                    return Err(invalid("invalid persistent view property"));
                }
            }
            let app = Arc::make_mut(&mut scene.fields)
                .entry("appState")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or_else(|| invalid("invalid appState"))?;
            app.extend(properties.clone());
        }
    }
    if let Some(before) = before_geometry {
        super::binding::reconcile(&before, scene)?;
    }
    if state.editing_group.as_ref().is_some_and(|id| {
        !scene
            .elements()
            .any(|e| !e.is_deleted() && e.group_ids().contains(&id.as_str()))
    }) {
        state.editing_group = None;
    }
    Ok(())
}

fn validate_style(properties: &Map<String, Value>) -> Result<(), BoardError> {
    for (key, value) in properties {
        let valid = match key.as_str() {
            "strokeColor" | "backgroundColor" => value.is_string(),
            "fillStyle" => matches!(
                value.as_str(),
                Some("solid" | "hachure" | "cross-hatch" | "zigzag")
            ),
            "strokeStyle" => matches!(value.as_str(), Some("solid" | "dashed" | "dotted")),
            "strokeWidth" => value.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0),
            "opacity" => value.as_f64().is_some_and(|n| (0.0..=100.0).contains(&n)),
            _ => false,
        };
        if !valid {
            return Err(invalid(format!("unsupported style: {key}")));
        }
    }
    Ok(())
}
fn require_unbound(element: &Element) -> Result<(), BoardError> {
    if ["containerId", "startBinding", "endBinding"]
        .iter()
        .any(|key| element.field(key).is_some_and(|v| !v.is_null()))
        || element
            .field("boundElements")
            .and_then(Value::as_array)
            .is_some_and(|v| !v.is_empty())
    {
        return Err(invalid("operation requires binding-aware layout"));
    }
    Ok(())
}
fn require_no_text_layout(element: &Element) -> Result<(), BoardError> {
    if element.reference("containerId").is_some()
        || element
            .field("boundElements")
            .and_then(Value::as_array)
            .is_some_and(|v| v.iter().any(|b| b["type"] == "text"))
    {
        return Err(invalid("operation requires measured text layout"));
    }
    Ok(())
}
fn require_closed_text_bindings(
    scene: &Scene,
    selected: &BTreeSet<String>,
) -> Result<(), BoardError> {
    for e in scene.elements().filter(|e| !e.is_deleted()) {
        for target in [e.reference("containerId")].into_iter().flatten() {
            if selected.contains(e.id()) != selected.contains(target) {
                return Err(invalid(
                    "moving an open binding requires connector/text layout",
                ));
            }
        }
    }
    Ok(())
}
fn detach_references(scene: &mut Scene, deleted: &BTreeSet<String>) -> Result<(), BoardError> {
    let ids: Vec<_> = scene
        .elements()
        .filter(|e| !e.is_deleted())
        .map(|e| e.id().to_owned())
        .collect();
    for id in ids {
        let old = active(scene, &id)?.clone();
        for key in ["containerId", "frameId"] {
            if old.reference(key).is_some_and(|id| deleted.contains(id)) {
                set(scene, &id, key, Value::Null)?;
            }
        }
        for key in ["startBinding", "endBinding"] {
            if old
                .field(key)
                .and_then(|v| v.get("elementId"))
                .and_then(Value::as_str)
                .is_some_and(|id| deleted.contains(id))
            {
                set(scene, &id, key, Value::Null)?;
            }
        }
        if let Some(bound) = old.field("boundElements").and_then(Value::as_array) {
            let retained: Vec<_> = bound
                .iter()
                .filter(|binding| {
                    !binding
                        .get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| deleted.contains(id))
                })
                .cloned()
                .collect();
            if retained.len() != bound.len() {
                set(scene, &id, "boundElements", json!(retained))?;
            }
        }
    }
    Ok(())
}
fn reverse_binding(
    scene: &mut Scene,
    target: &str,
    source: &str,
    kind: &str,
    add: bool,
) -> Result<(), BoardError> {
    let element = active(scene, target)?;
    let mut bindings = match element.field("boundElements") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(values)) => values.clone(),
        _ => return Err(invalid("invalid reverse bindings")),
    };
    bindings.retain(|b| b.get("id").and_then(Value::as_str) != Some(source));
    if add {
        bindings.push(json!({"id":source,"type":kind}));
    }
    set(scene, target, "boundElements", json!(bindings))
}
fn bind_text(scene: &mut Scene, text: &str, container: Option<&str>) -> Result<(), BoardError> {
    let element = editable(scene, text)?;
    if element.kind() != ElementKind::Text {
        return Err(invalid("not text"));
    }
    let previous = element.reference("containerId").map(str::to_owned);
    if previous.as_deref() == container {
        return Ok(());
    }
    if let Some(target) = container {
        if !matches!(
            editable(scene, target)?.kind(),
            ElementKind::Rectangle
                | ElementKind::Ellipse
                | ElementKind::Diamond
                | ElementKind::Arrow
        ) {
            return Err(invalid("invalid text container"));
        }
        if scene.elements().any(|e| {
            !e.is_deleted() && e.reference("containerId") == Some(target) && e.id() != text
        }) {
            return Err(invalid("container already has text"));
        }
    }
    if let Some(old) = previous {
        reverse_binding(scene, &old, text, "text", false)?;
    }
    if let Some(target) = container {
        reverse_binding(scene, target, text, "text", true)?;
    }
    set(scene, text, "containerId", json!(container))
}
fn bind_arrow(
    scene: &mut Scene,
    arrow: &str,
    end: bool,
    binding: Option<&Value>,
) -> Result<(), BoardError> {
    let element = editable(scene, arrow)?;
    if element.kind() != ElementKind::Arrow || element.field("elbowed") == Some(&json!(true)) {
        return Err(invalid("requires non-elbow arrow"));
    }
    let key = if end { "endBinding" } else { "startBinding" };
    let other = if end { "startBinding" } else { "endBinding" };
    let previous = element
        .field(key)
        .and_then(|v| v.get("elementId"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let other_target = element
        .field(other)
        .and_then(|v| v.get("elementId"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let target = if let Some(binding) = binding {
        let id = binding
            .get("elementId")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("binding requires target"))?;
        if !matches!(
            editable(scene, id)?.kind(),
            ElementKind::Rectangle
                | ElementKind::Ellipse
                | ElementKind::Diamond
                | ElementKind::Image
                | ElementKind::Text
                | ElementKind::Frame
                | ElementKind::Embeddable
                | ElementKind::Iframe
        ) {
            return Err(invalid("invalid arrow target"));
        }
        if !binding
            .get("focus")
            .and_then(Value::as_f64)
            .is_some_and(|n| (-1.0..=1.0).contains(&n))
            || !binding
                .get("gap")
                .and_then(Value::as_f64)
                .is_some_and(|n| n.is_finite() && n >= 0.0)
        {
            return Err(invalid("invalid focus/gap"));
        }
        Some(id.to_owned())
    } else {
        None
    };
    if let Some(old) = previous
        && Some(&old) != other_target.as_ref()
    {
        reverse_binding(scene, &old, arrow, "arrow", false)?;
    }
    if let Some(target) = target {
        reverse_binding(scene, &target, arrow, "arrow", true)?;
    }
    set(scene, arrow, key, binding.cloned().unwrap_or(Value::Null))
}
fn reorder(
    scene: &mut Scene,
    selected: &BTreeSet<String>,
    layer: Layer,
    editing: Option<&str>,
) -> Result<(), BoardError> {
    if selected.is_empty() {
        return Ok(());
    }
    let before: Vec<_> = scene.elements.iter().map(|e| e.id().to_owned()).collect();
    super::order::reorder(scene, selected, layer, editing);
    if !before.iter().eq(scene.elements.iter().map(|e| e.id())) {
        reindex(scene)?;
    }
    Ok(())
}
fn reindex(scene: &mut Scene) -> Result<(), BoardError> {
    // Positive integer portion of Excalidraw's base-62 fractional index format.
    // Reindex only after a structural edit; opening a scene never normalizes it.
    const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut digits = vec![0usize];
    let mut head = b'a';
    for element in &mut scene.elements {
        let key: String = std::iter::once(head as char)
            .chain(digits.iter().map(|d| DIGITS[*d] as char))
            .collect();
        if element.field("index").and_then(Value::as_str) != Some(&key) {
            Arc::make_mut(element)
                .fields
                .insert("index".into(), json!(key));
        }
        let mut carry = true;
        for digit in digits.iter_mut().rev() {
            *digit += 1;
            if *digit < 62 {
                carry = false;
                break;
            }
            *digit = 0;
        }
        if carry {
            head += 1;
            if head > b'z' {
                return Err(invalid("too many elements"));
            }
            digits.push(0);
        }
    }
    Ok(())
}

type TransformGroup = (Vec<String>, [f64; 4]);
fn transform_groups(
    scene: &Scene,
    selected: &BTreeSet<String>,
    editing: Option<&str>,
) -> Result<Vec<TransformGroup>, BoardError> {
    let bounds = independent_bounds(scene, selected, true)?;
    let mut groups: Vec<TransformGroup> = Vec::new();
    let mut indices = BTreeMap::new();
    // Preserve scene order when equally positioned groups are distributed.
    let bounds: BTreeMap<_, _> = bounds.into_iter().collect();
    for element in scene.elements().filter(|e| selected.contains(e.id())) {
        let b = bounds[element.id()];
        if let Some(group) = selectable_groups(element, editing).last() {
            let index = *indices.entry((*group).to_owned()).or_insert_with(|| {
                groups.push((Vec::new(), b));
                groups.len() - 1
            });
            let (ids, combined) = &mut groups[index];
            ids.push(element.id().to_owned());
            combined[0] = combined[0].min(b[0]);
            combined[1] = combined[1].min(b[1]);
            combined[2] = combined[2].max(b[2]);
            combined[3] = combined[3].max(b[3]);
        } else {
            groups.push((vec![element.id().to_owned()], b));
        }
    }
    Ok(groups)
}

fn independent_bounds(
    scene: &Scene,
    selected: &BTreeSet<String>,
    allow_groups: bool,
) -> Result<Vec<(String, [f64; 4])>, BoardError> {
    let mut result = Vec::new();
    for id in selected {
        let element = editable(scene, id)?;
        require_unbound(element)?;
        if (!allow_groups && !element.group_ids().is_empty())
            || element.reference("frameId").is_some()
        {
            return Err(invalid("group/frame transform policy not implemented"));
        }
        if matches!(element.kind(), ElementKind::Frame | ElementKind::MagicFrame) {
            return Err(invalid("frame transform policy not implemented"));
        }
        let bounds = super::geometry::element_bounds(element)?;
        result.push((id.clone(), bounds));
    }
    Ok(result)
}
fn move_on_axis(scene: &mut Scene, id: &str, axis: Axis, delta: f64) -> Result<(), BoardError> {
    if delta == 0.0 {
        return Ok(());
    }
    let delta = match axis {
        Axis::X => Point(delta, 0.0),
        Axis::Y => Point(0.0, delta),
    };
    active(scene, id)?
        .geometry()?
        .translated(delta)?
        .write(scene.edit(id)?);
    Ok(())
}
