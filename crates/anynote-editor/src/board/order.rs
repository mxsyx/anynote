use super::{Element, ElementKind, Layer, Scene};
use std::collections::{BTreeMap, BTreeSet};

fn frame_like(element: &Element) -> bool {
    matches!(element.kind(), ElementKind::Frame | ElementKind::MagicFrame)
}
fn in_frame(element: &Element, frame: &str) -> bool {
    element.id() == frame || element.reference("frameId") == Some(frame)
}
fn indices(scene: &Scene, selected: &BTreeSet<String>) -> Vec<usize> {
    let mut result = Vec::new();
    let mut deleted = Vec::new();
    let mut next_deleted = None;
    for (i, element) in scene.elements.iter().enumerate() {
        if selected.contains(element.id()) {
            result.append(&mut deleted);
            result.push(i);
            next_deleted = Some(i + 1);
        } else if element.is_deleted() && next_deleted == Some(i) {
            deleted.push(i);
            next_deleted = Some(i + 1);
        } else {
            deleted.clear();
        }
    }
    result
}
fn binding_boundary(scene: &Scene, index: usize, forward: bool) -> usize {
    let element = &scene.elements[index];
    let target = element.reference("containerId").or_else(|| {
        element
            .field("boundElements")?
            .as_array()?
            .iter()
            .find(|b| b.get("type").and_then(|v| v.as_str()) != Some("arrow"))?
            .get("id")?
            .as_str()
    });
    let paired = target.and_then(|id| scene.elements.iter().position(|e| e.id() == id));
    paired.map_or(index, |paired| {
        if forward {
            index.max(paired)
        } else {
            index.min(paired)
        }
    })
}
fn target_index(
    scene: &Scene,
    boundary: usize,
    forward: bool,
    frame: Option<&str>,
    editing: Option<&str>,
) -> Option<usize> {
    let eligible = |i: &usize| {
        let e = &scene.elements[*i];
        !e.is_deleted()
            && frame.map_or_else(
                || editing.is_none_or(|group| e.group_ids().contains(&group)),
                |frame| e.reference("frameId") == Some(frame),
            )
    };
    let candidate = if forward {
        (boundary + 1..scene.elements.len()).find(eligible)
    } else {
        (0..boundary).rev().find(eligible)
    }?;
    let element = &scene.elements[candidate];
    if frame.is_none() && (element.reference("frameId").is_some() || frame_like(element)) {
        let frame = element.reference("frameId").unwrap_or(element.id());
        return if forward {
            scene.elements.iter().rposition(|e| in_frame(e, frame))
        } else {
            scene.elements.iter().position(|e| in_frame(e, frame))
        };
    }
    if let Some(group) = super::operation::selectable_groups(element, editing).last() {
        if forward {
            scene
                .elements
                .iter()
                .rposition(|e| e.group_ids().contains(group))
        } else {
            scene
                .elements
                .iter()
                .position(|e| e.group_ids().contains(group))
        }
    } else {
        Some(binding_boundary(scene, candidate, forward))
    }
}
fn shift_one(scene: &mut Scene, selected: &BTreeSet<String>, forward: bool, editing: Option<&str>) {
    let selected_indices = indices(scene, selected);
    let selected_frames: BTreeSet<_> = selected_indices
        .iter()
        .map(|i| &scene.elements[*i])
        .filter(|e| frame_like(e))
        .map(|e| e.id().to_owned())
        .collect();
    let mut runs: Vec<(usize, usize)> = Vec::new();
    for i in selected_indices {
        if let Some((_, last)) = runs.last_mut().filter(|(_, last)| *last + 1 == i) {
            *last = i;
        } else {
            runs.push((i, i));
        }
    }
    if forward {
        runs.reverse();
    }
    for (first, last) in runs {
        let boundary = if forward { last } else { first };
        let moves_frame = scene.elements[first..=last].iter().any(|e| {
            e.reference("frameId")
                .is_some_and(|id| selected_frames.contains(id))
        });
        let frame = if moves_frame {
            None
        } else {
            scene.elements[boundary].reference("frameId")
        };
        let Some(target) = target_index(scene, boundary, forward, frame, editing) else {
            continue;
        };
        if forward && target > last {
            scene.elements[first..=target].rotate_left(last - first + 1);
        } else if !forward && target < first {
            scene.elements[target..=last].rotate_right(last - first + 1);
        }
    }
}
fn shift_end(
    scene: &mut Scene,
    selected: &BTreeSet<String>,
    frame: Option<&str>,
    forward: bool,
    editing: Option<&str>,
) {
    let selected_indices = indices(scene, selected);
    let (Some(first), Some(last)) = (selected_indices.first(), selected_indices.last()) else {
        return;
    };
    let start = if forward {
        *first
    } else {
        frame
            .and_then(|id| scene.elements.iter().position(|e| in_frame(e, id)))
            .or_else(|| {
                editing.and_then(|id| {
                    scene
                        .elements
                        .iter()
                        .position(|e| e.group_ids().contains(&id))
                })
            })
            .unwrap_or(0)
    };
    let end = if !forward {
        *last
    } else {
        frame
            .and_then(|id| scene.elements.iter().rposition(|e| in_frame(e, id)))
            .or_else(|| {
                editing.and_then(|id| {
                    scene
                        .elements
                        .iter()
                        .rposition(|e| e.group_ids().contains(&id))
                })
            })
            .unwrap_or(scene.elements.len() - 1)
    };
    let moved: BTreeSet<_> = selected_indices
        .into_iter()
        .map(|i| scene.elements[i].id().to_owned())
        .collect();
    scene.elements[start..=end].sort_by_key(|e| moved.contains(e.id()) == forward);
}

pub(super) fn reorder(
    scene: &mut Scene,
    selected: &BTreeSet<String>,
    layer: Layer,
    editing: Option<&str>,
) {
    match layer {
        Layer::Backward | Layer::Forward => {
            shift_one(scene, selected, matches!(layer, Layer::Forward), editing)
        }
        Layer::Back | Layer::Front => {
            let forward = matches!(layer, Layer::Front);
            let frames: BTreeSet<_> = scene
                .elements()
                .filter(|e| selected.contains(e.id()) && frame_like(e))
                .map(|e| e.id().to_owned())
                .collect();
            let mut children: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
            let mut frame_order = Vec::new();
            let mut regular = BTreeSet::new();
            for element in scene.elements().filter(|e| selected.contains(e.id())) {
                if let Some(frame) = element
                    .reference("frameId")
                    .filter(|frame| !frames.contains(*frame))
                {
                    if !children.contains_key(frame) {
                        frame_order.push(frame.to_owned());
                    }
                    children
                        .entry(frame.to_owned())
                        .or_default()
                        .insert(element.id().to_owned());
                } else {
                    regular.insert(element.id().to_owned());
                }
            }
            // In 0.18 each partial frame is reordered from the original array,
            // so only the final frame's permutation survives before regular items.
            if let Some(frame) = frame_order.pop() {
                shift_end(scene, &children[&frame], Some(&frame), forward, editing);
            }
            shift_end(scene, &regular, None, forward, editing);
        }
    }
}
