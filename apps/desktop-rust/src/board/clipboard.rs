use anynote_editor::board::{Board, Clipboard, Command, Point, Scene, TransferIds};
use serde_json::Value;
use uuid::Uuid;

pub(super) fn copy(board: &Board) -> Result<String, String> {
    if board.selected_ids().is_empty() {
        return Err("请先选择图形".into());
    }
    Clipboard::from_board(board)
        .and_then(|fragment| fragment.serialize())
        .map_err(|e| e.to_string())
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
                .filter_map(Value::as_str)
                .take_while(|id| Some(*id) != board.editing_group())
        })
        .map(|id| (id.to_owned(), Uuid::new_v4().to_string()))
        .collect();
    let seeds = board
        .selected_ids()
        .iter()
        .map(|id| {
            (
                id.clone(),
                ((Uuid::new_v4().as_u128() as u32) & 0x7fff_ffff).max(1),
            )
        })
        .collect();
    Command::Duplicate {
        ids,
        groups,
        seeds,
        delta,
    }
}

pub(super) fn paste(source: &str, anchor: Point) -> Result<Command, String> {
    let fragment = Clipboard::parse(source).map_err(|e| e.to_string())?;
    let scene = Scene::from_json(serde_json::json!({"elements":fragment.elements()}))
        .map_err(|e| e.to_string())?;
    let bounds = super::geometry::bounds(
        &scene
            .elements()
            .flat_map(super::geometry::outline)
            .collect::<Vec<_>>(),
    )
    .ok_or("剪贴板没有图形")?;
    let ids = TransferIds::new(
        scene
            .elements()
            .map(|e| (e.id().to_owned(), Uuid::new_v4().to_string()))
            .collect(),
        scene
            .elements()
            .flat_map(|e| {
                e.field("groupIds")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
            })
            .filter_map(Value::as_str)
            .map(|id| (id.to_owned(), Uuid::new_v4().to_string()))
            .collect(),
        scene
            .elements()
            .filter_map(|e| e.field("fileId").and_then(Value::as_str))
            .map(|id| (id.to_owned(), Uuid::new_v4().to_string()))
            .collect(),
    )
    .with_seeds(
        scene
            .elements()
            .map(|e| {
                (
                    e.id().to_owned(),
                    ((Uuid::new_v4().as_u128() as u32) & 0x7fff_ffff).max(1),
                )
            })
            .collect(),
    );
    Ok(fragment.paste(
        ids,
        Point::new(anchor.x() - bounds[0], anchor.y() - bounds[1]),
    ))
}
