use super::*;
use rusqlite::Connection;
use std::collections::{HashMap, HashSet};

pub(crate) fn validate(
    db: &Connection,
    expected_id: Option<&str>,
) -> ReadResult<(NotebookMeta, Option<BackupRevision>)> {
    let metas = model::rows(db, "SELECT * FROM notebook_meta", [])?;
    require(metas.len() == 1, "Notebook 元数据无效")?;
    let meta: NotebookMeta = serde_json::from_value(metas[0].clone())?;
    uuid(&meta.id)?;
    require(
        !meta.name.trim().is_empty()
            && meta.name.trim().encode_utf16().count() <= 240
            && meta.content_seq >= 0,
        "Notebook 元数据无效",
    )?;
    if expected_id.is_some_and(|id| id != meta.id) {
        return Err(ReadError::new(
            ReadErrorKind::IdentityConflict,
            "Notebook 身份已改变",
        ));
    }
    if meta.schema_version != 5 {
        return Err(ReadError::new(
            ReadErrorKind::UnsupportedVersion,
            "不支持的数据库版本",
        ));
    }
    let reference = Connection::open_in_memory()?;
    reference.execute_batch(SCHEMA_V5)?;
    let has_tracker: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='_backup_revision')",
        [],
        |r| r.get(0),
    )?;
    if has_tracker {
        reference.execute_batch(BACKUP_REVISION_SQL)?;
    }
    let query = "SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name";
    if model::rows(db, query, [])? != model::rows(&reference, query, [])? {
        return Err(ReadError::new(
            ReadErrorKind::IncompatibleSchema,
            "数据库结构或备份版本标记不兼容",
        ));
    }
    let integrity: String = db.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    require(
        integrity == "ok" && model::rows(db, "PRAGMA foreign_key_check", [])?.is_empty(),
        "数据库完整性检查失败",
    )?;
    let tracker = if has_tracker {
        let rows = model::rows(
            db,
            "SELECT id,format,lineage_id,CAST(storage_epoch AS TEXT) AS storage_epoch,typeof(storage_epoch) AS epoch_type FROM _backup_revision",
            [],
        )?;
        require(
            rows.len() == 1
                && rows[0]["id"] == 1
                && rows[0]["format"] == 1
                && rows[0]["epoch_type"] == "integer",
            "备份版本标记数据无效",
        )?;
        let lineage = rows[0]["lineage_id"]
            .as_str()
            .ok_or_else(|| ReadError::new(ReadErrorKind::Corrupt, "备份 lineage 无效"))?;
        uuid(lineage)?;
        let epoch = rows[0]["storage_epoch"].as_str().unwrap_or("");
        require(epoch.parse::<u64>().is_ok(), "备份 epoch 无效")?;
        Some(BackupRevision {
            lineage_id: lineage.into(),
            content_seq: meta.content_seq.to_string(),
            storage_epoch: epoch.into(),
        })
    } else {
        None
    };
    validate_tree(db)?;
    require(model::rows(db, "SELECT t.node_id FROM notes t JOIN nodes n ON n.id=t.node_id LEFT JOIN note_revisions r ON r.id=t.head_revision_id WHERE n.kind<>'note' OR r.note_id IS NOT t.node_id UNION SELECT n.id FROM nodes n LEFT JOIN notes t ON t.node_id=n.id WHERE n.kind='note' AND t.node_id IS NULL", [])?.is_empty(), "正文或当前修订归属无效")?;
    Ok((meta, tracker))
}
fn validate_tree(db: &Connection) -> ReadResult<()> {
    let mut nodes = HashMap::new();
    for value in model::rows(
        db,
        "SELECT n.*,t.note_type FROM nodes n LEFT JOIN notes t ON t.node_id=n.id",
        [],
    )? {
        let node: Node = serde_json::from_value(model::node_value(value)?)?;
        nodes.insert(node.id.clone(), node);
    }
    let mut done = HashSet::new();
    for node in nodes.values() {
        let mut current = node;
        let mut chain = HashSet::new();
        while !done.contains(&current.id) {
            require(chain.insert(current.id.clone()), "目录包含循环")?;
            let Some(parent) = &current.parent_id else {
                break;
            };
            current = nodes
                .get(parent)
                .ok_or_else(|| ReadError::new(ReadErrorKind::Corrupt, "目录父节点缺失"))?;
            require(current.kind == NodeKind::Folder, "目录父节点不是文件夹")?;
        }
        done.extend(chain);
    }
    Ok(())
}
