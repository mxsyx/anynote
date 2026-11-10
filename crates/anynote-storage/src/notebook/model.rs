use super::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Folder,
    Note,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NoteType {
    Markdown,
    Pdf,
    Image,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[non_exhaustive]
pub struct NotebookMeta {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub cover_color: String,
    pub schema_version: i64,
    pub content_seq: i64,
    pub created_at: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[non_exhaustive]
pub struct BackupRevision {
    pub lineage_id: String,
    pub content_seq: String,
    pub storage_epoch: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[non_exhaustive]
pub struct Node {
    pub id: String,
    pub parent_id: Option<String>,
    pub kind: NodeKind,
    pub title: String,
    pub sort_key: serde_json::Number,
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    pub deleted_by: Option<String>,
    pub favorite: i64,
    pub tags: Vec<String>,
    pub note_type: Option<NoteType>,
}
impl Node {
    pub(crate) fn validate(&self) -> ReadResult<()> {
        uuid(&self.id)?;
        if let Some(id) = &self.parent_id {
            uuid(id)?;
        }
        if let Some(id) = &self.deleted_by {
            uuid(id)?;
        }
        require(
            self.revision > 0 && matches!(self.favorite, 0 | 1),
            "节点版本或收藏无效",
        )?;
        require(
            self.tags.len() <= 30 && self.tags.iter().all(|s| s.encode_utf16().count() <= 40),
            "标签无效",
        )?;
        require(
            self.sort_key.as_f64().is_some_and(f64::is_finite),
            "排序键无效",
        )?;
        require(
            [self.revision, self.created_at, self.updated_at]
                .into_iter()
                .chain(self.deleted_at)
                .all(|n| (0..=9_007_199_254_740_991).contains(&n)),
            "节点时间或版本超出安全整数范围",
        )
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[non_exhaustive]
pub struct Note {
    #[serde(flatten)]
    pub node: Node,
    pub body: String,
    pub primary_resource_id: Option<String>,
    pub head_revision_id: Option<String>,
    pub source_uri: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[non_exhaustive]
pub struct RevisionSummary {
    pub id: String,
    pub created_at: i64,
    pub actor: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[non_exhaustive]
pub struct Revision {
    pub id: String,
    pub note_id: String,
    pub body: String,
    pub created_at: i64,
    pub actor: String,
    pub metadata: Option<Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[non_exhaustive]
pub struct Annotation {
    pub id: String,
    pub note_id: String,
    pub target_asset_hash: String,
    pub page: i64,
    pub selector_json: String,
    pub quote: String,
    pub body: String,
    pub color: String,
    pub revision: i64,
    pub created_at: i64,
    pub deleted_at: Option<i64>,
    pub selector: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ExtensionRecord {
    pub extension_id: String,
    pub key: String,
    pub value_json: String,
    pub schema_version: i64,
    pub revision: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[non_exhaustive]
pub struct RevisionResource {
    pub revision_id: String,
    pub resource_id: String,
    pub asset_hash: String,
}

pub(crate) fn rows(
    db: &rusqlite::Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> ReadResult<Vec<Value>> {
    rows_bounded(db, sql, params, &mut { usize::MAX })
}

pub(crate) fn rows_bounded(
    db: &rusqlite::Connection,
    sql: &str,
    params: impl rusqlite::Params,
    remaining: &mut usize,
) -> ReadResult<Vec<Value>> {
    let mut stmt = db.prepare(sql)?;
    let columns = stmt
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut cursor = stmt.query(params)?;
    let mut result = Vec::new();
    while let Some(row) = cursor.next()? {
        let mut fields = serde_json::Map::new();
        for (ix, name) in columns.iter().enumerate() {
            use rusqlite::types::ValueRef;
            let value = match row.get_ref(ix)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => Value::from(n),
                ValueRef::Real(n) => Value::from(n),
                ValueRef::Text(s) => Value::String(
                    std::str::from_utf8(s)
                        .map_err(|_| ReadError::new(ReadErrorKind::Corrupt, "无效 UTF-8"))?
                        .into(),
                ),
                ValueRef::Blob(_) => {
                    return Err(ReadError::new(
                        ReadErrorKind::Corrupt,
                        "文本字段不允许 BLOB",
                    ));
                }
            };
            fields.insert(name.clone(), value);
        }
        let value = Value::Object(fields);
        if *remaining != usize::MAX {
            let length = serde_json::to_vec(&value)?.len() + 1;
            *remaining = remaining
                .checked_sub(length)
                .ok_or_else(|| ReadError::new(ReadErrorKind::InvalidInput, "记录超过预算"))?;
        }
        result.push(value);
    }
    Ok(result)
}
pub(crate) fn node_value(mut value: Value) -> ReadResult<Value> {
    let raw = value["tags"]
        .as_str()
        .ok_or_else(|| ReadError::new(ReadErrorKind::Corrupt, "标签不是 JSON 文本"))?;
    value["tags"] = serde_json::from_str(raw)?;
    let node: Node = serde_json::from_value(value.clone())?;
    node.validate()?;
    Ok(value)
}
