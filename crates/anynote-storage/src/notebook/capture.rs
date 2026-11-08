use super::*;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const ACTIVE: &str = "WITH RECURSIVE active(id) AS (SELECT id FROM nodes WHERE parent_id IS NULL AND deleted_at IS NULL UNION SELECT n.id FROM nodes n JOIN active a ON n.parent_id=a.id WHERE n.deleted_at IS NULL)";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedCapture {
    pub capture_id: String,
    pub digest: String,
    pub note_id: String,
    pub applied_seq: u64,
}

impl ReadonlyNotebook {
    pub fn capture_receipt(&self, id: &str) -> ReadResult<Option<AppliedCapture>> {
        self.check_path()?;
        uuid(id)?;
        let receipt = self.db.query_row(
            "SELECT capture_id,digest,note_id,applied_seq FROM capture_receipts WHERE capture_id=?",
            [id],
            |r| Ok(AppliedCapture { capture_id:r.get(0)?, digest:r.get(1)?, note_id:r.get(2)?, applied_seq:r.get(3)? }),
        ).optional()?;
        if let Some(r) = &receipt {
            uuid(&r.note_id)?;
            assets::check_hash(&r.digest)?;
            let seq: u64 = self
                .db
                .query_row("SELECT content_seq FROM notebook_meta", [], |r| r.get(0))?;
            require(
                r.applied_seq <= seq && seq <= write::SAFE_INTEGER as u64,
                "采集回执序列无效",
            )?;
        }
        Ok(receipt)
    }

    /// Bounded metadata only; bodies are loaded one at a time from this same snapshot.
    pub fn browse_nodes(&self) -> ReadResult<Vec<Value>> {
        self.check_path()?;
        let rows = model::rows(
            &self.db,
            &format!(
                "{ACTIVE} SELECT n.id,n.parent_id AS parentId,n.kind,n.title,s.note_type AS noteType FROM nodes n JOIN active a ON a.id=n.id LEFT JOIN notes s ON s.node_id=n.id ORDER BY n.parent_id,n.sort_key,n.id LIMIT 30001"
            ),
            [],
        )?;
        require(rows.len() <= 30000, "浏览目录超过预算")?;
        Ok(rows)
    }

    pub fn browse_note(&self, id: &str) -> ReadResult<Value> {
        self.check_path()?;
        uuid(id)?;
        let mut note = model::rows(&self.db, &format!("{ACTIVE} SELECT n.id,n.title,s.note_type AS noteType,s.head_revision_id AS revisionId,COALESCE(r.body,'') AS body,s.primary_resource_id AS primaryResourceId FROM nodes n JOIN active a ON a.id=n.id JOIN notes s ON s.node_id=n.id LEFT JOIN note_revisions r ON r.id=s.head_revision_id WHERE n.id=?"), [id])?
            .pop().ok_or_else(|| ReadError::new(ReadErrorKind::NotFound, "笔记不存在"))?;
        note["resources"] = serde_json::to_value(model::rows(
            &self.db,
            "SELECT p.resource_id AS id,p.asset_hash AS hash,a.size,a.mime,r.original_name AS name FROM revision_resources p JOIN resources r ON r.id=p.resource_id JOIN assets a ON a.hash=p.asset_hash WHERE p.revision_id=?1 UNION SELECT r.id,r.asset_hash,a.size,a.mime,r.original_name FROM resources r JOIN assets a ON a.hash=r.asset_hash WHERE r.id=?2 AND NOT EXISTS(SELECT 1 FROM revision_resources WHERE revision_id=?1 AND resource_id=r.id)",
            rusqlite::params![
                note["revisionId"].as_str(),
                note["primaryResourceId"].as_str()
            ],
        )?)?;
        Ok(note)
    }
}

impl WritableNotebook {
    pub fn validate_capture_target(&self, parent: Option<&str>) -> ReadResult<()> {
        self.parent(parent, None)
    }
}
