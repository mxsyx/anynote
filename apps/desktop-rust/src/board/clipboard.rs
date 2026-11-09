use super::input::stamp;
use anynote_editor::board::{Board, Command, Point, Scene};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use uuid::Uuid;

pub(super) fn copy(board: &Board) -> Result<String, String> {
    let elements: Vec<_> = board
        .scene()
        .elements()
        .filter(|e| board.selected_ids().contains(e.id()))
        .map(|e| e.to_json())
        .collect();
    if elements.is_empty() {
        return Err("请先选择图形".into());
    }
    let mut files = Map::new();
    for e in &elements {
        if let Some(id) = e.get("fileId").and_then(Value::as_str) {
            let file = board
                .scene()
                .field("files")
                .and_then(|f| f.get(id))
                .ok_or("图片文件缺失")?;
            files.insert(id.into(), file.clone());
        }
    }
    let encoded = serde_json::to_string(
        &json!({"type":"excalidraw/clipboard","elements":elements,"files":files}),
    )
    .map_err(|e| e.to_string())?;
    if encoded.len() > 16 * 1024 * 1024 {
        return Err("白板剪贴板超过 16 MiB 上限".into());
    }
    Ok(encoded)
}
pub(super) fn duplicate(board: &Board, delta: Point) -> Command {
    let ids = board
        .selected_ids()
        .iter()
        .map(|id| (id.clone(), Uuid::new_v4().to_string()))
        .collect();
    let groups = board
        .scene()
        .elements()
        .filter(|e| board.selected_ids().contains(e.id()))
        .flat_map(|e| {
            e.field("groupIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(Value::as_str)
        .map(|id| (id.to_owned(), Uuid::new_v4().to_string()))
        .collect();
    Command::Duplicate { ids, groups, delta }
}
/// Remap IDs through RM22's duplicate operation, including bindings and groups.
/// File identities are fresh so pasting never overwrites the destination's resources.
pub(super) fn paste(source: &str, anchor: Point) -> Result<Command, String> {
    if source.len() > 16 * 1024 * 1024 {
        return Err("白板剪贴板超过 16 MiB 上限".into());
    }
    let mut value: Value = serde_json::from_str(source).map_err(|_| "剪贴板不是白板图形")?;
    if value.get("type").and_then(Value::as_str) != Some("excalidraw/clipboard") {
        return Err("剪贴板不是白板图形".into());
    }
    let scene = Scene::from_json(value.clone()).map_err(|e| e.to_string())?;
    if scene.elements().len() > 10_000 {
        return Err("一次最多粘贴 10000 个图形".into());
    }
    let mut board = Board::new(scene, 0);
    let ids: Vec<_> = board
        .scene()
        .elements()
        .filter(|e| !e.is_deleted())
        .map(|e| e.id().into())
        .collect();
    board.select(ids).map_err(|e| e.to_string())?;
    let b = super::geometry::bounds(
        &board
            .scene()
            .elements()
            .filter(|e| !e.is_deleted())
            .flat_map(super::geometry::outline)
            .collect::<Vec<_>>(),
    )
    .ok_or("剪贴板没有图形")?;
    let command = duplicate(&board, Point::new(anchor.x() - b[0], anchor.y() - b[1]));
    board.apply(command, stamp()).map_err(|e| e.to_string())?;
    let mut elements: Vec<_> = board
        .scene()
        .elements()
        .filter(|e| board.selected_ids().contains(e.id()))
        .map(|e| e.to_json())
        .collect();
    let mut files = Map::new();
    let mut remapped = BTreeMap::new();
    for e in &mut elements {
        if let Some(old) = e.get("fileId").and_then(Value::as_str).map(str::to_owned) {
            let new = remapped
                .entry(old.clone())
                .or_insert_with(|| Uuid::new_v4().to_string())
                .clone();
            let mut file = value
                .get_mut("files")
                .and_then(|f| f.get(&old))
                .cloned()
                .ok_or("图片文件缺失")?;
            file["id"] = json!(new);
            files.insert(new.clone(), file);
            e["fileId"] = json!(new);
        }
    }
    Ok(Command::Insert { elements, files })
}
