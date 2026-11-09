use super::write::{SAFE_INTEGER, conflict, input, new_id, now, text_limit};
use super::*;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AnnotationInput {
    pub asset_hash: String,
    pub page: i64,
    pub selector: Vec<Rectangle>,
    pub quote: String,
    pub body: String,
    pub color: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Rectangle {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    pub note_id: String,
    pub expected_revision: i64,
    pub before: String,
    pub after: String,
    pub reason: String,
    pub created_at: i64,
    pub status: ProposalStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_revision: Option<i64>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProposalStatus {
    Proposed,
    Applied,
    Undone,
}
impl Proposal {
    fn validate(&self) -> ReadResult<()> {
        uuid(&self.id)?;
        uuid(&self.note_id)?;
        input(
            (1..SAFE_INTEGER).contains(&self.expected_revision)
                && (0..=SAFE_INTEGER).contains(&self.created_at),
            "提案数值无效",
        )?;
        text_limit(&self.before, 0, 2_000_000)?;
        text_limit(&self.after, 1, 2_000_000)?;
        text_limit(&self.reason, 0, 1000)?;
        input(
            match self.status {
                ProposalStatus::Proposed => self.applied_revision.is_none(),
                _ => self
                    .applied_revision
                    .is_some_and(|n| (1..=SAFE_INTEGER).contains(&n)),
            },
            "提案状态无效",
        )
    }
}
impl WritableNotebook {
    /// Embedded images have no primary resource; authorize against the pinned current revision.
    pub fn add_image_annotation(
        &mut self,
        note_id: &str,
        revision: &str,
        resource: &str,
        request: &AnnotationInput,
    ) -> ReadResult<String> {
        let note = self.active(note_id, None)?;
        conflict(note.head_revision_id.as_deref() == Some(revision))?;
        let asset = self.view.resource(
            resource,
            Some(ResourceScope::note(note_id).with_revision(revision)),
        )?;
        conflict(asset.info().hash == request.asset_hash)?;
        input(
            asset.info().mime.starts_with("image/")
                && request.page == 1
                && request.selector.len() == 1,
            "图片批注目标无效",
        )?;
        let r = &request.selector[0];
        input(
            [r.x, r.y, r.width, r.height]
                .into_iter()
                .all(|v| v.is_finite() && (0.0..=1.0).contains(&v))
                && r.width > 0.
                && r.height > 0.
                && r.x + r.width <= 1.0000001
                && r.y + r.height <= 1.0000001,
            "图片批注范围无效",
        )?;
        text_limit(&request.body, 0, 10000)?;
        let id = new_id();
        self.transaction(&id, "annotation", |book| {
            book.view.db.execute("INSERT INTO annotations(id,note_id,target_asset_hash,page,selector_json,quote,body,color,created_at) VALUES(?,?,?,1,?,'',?,'yellow',?)", params![id,note_id,request.asset_hash,serde_json::to_string(&request.selector)?,request.body,now()?])?;
            book.index(note_id)?;
            Ok(())
        })?;
        Ok(id)
    }
    pub fn set_core_setting(
        &mut self,
        namespace: &str,
        key: &str,
        enabled: bool,
    ) -> ReadResult<bool> {
        let (revision, mut preferences) = self.view.builtin_preferences()?;
        match (namespace, key) {
            ("anynote.whiteboard", "enabled") => preferences.whiteboard = enabled,
            ("anynote.video", "enabled") => preferences.video = enabled,
            ("anynote.html-import", "enabled") => preferences.html = enabled,
            ("anynote.video", "remoteEmbed") => preferences.remote_embed = enabled,
            _ => return Err(ReadError::invalid_input("未知内置配置")),
        }
        self.set_builtin_preferences(revision, &preferences)?;
        Ok(enabled)
    }
    pub fn propose(
        &mut self,
        id: &str,
        expected: i64,
        after: &str,
        reason: Option<&str>,
    ) -> ReadResult<Proposal> {
        let note = self.active(id, Some(expected))?;
        input(note.node.kind == NodeKind::Note, "只能为笔记创建提案")?;
        let proposal = Proposal {
            id: new_id(),
            note_id: id.into(),
            expected_revision: expected,
            before: note.body,
            after: after.into(),
            reason: reason
                .filter(|s| !s.is_empty())
                .unwrap_or("用户授权的整理提案")
                .into(),
            created_at: now()?,
            status: ProposalStatus::Proposed,
            applied_revision: None,
        };
        proposal.validate()?;
        self.view.check_path()?;
        // Matches TS: staging a proposal changes storage_epoch but not content_seq.
        self.view.db.execute("INSERT INTO extension_data(extension_id,key,value_json) VALUES('anynote.ai.proposals',?,?)",params![proposal.id,serde_json::to_string(&proposal)?])?;
        self.refresh_after_state()?;
        Ok(proposal)
    }
    fn refresh_after_state(&mut self) -> ReadResult<()> {
        if let Some(tracker) = self.view.tracker.as_mut() {
            tracker.storage_epoch = self.view.db.query_row(
                "SELECT CAST(storage_epoch AS TEXT) FROM _backup_revision WHERE id=1",
                [],
                |r| r.get(0),
            )?;
        }
        Ok(())
    }
    pub fn apply_proposal(&mut self, id: &str, proposal_id: &str) -> ReadResult<Note> {
        self.change_proposal(id, proposal_id, false)
    }
    pub fn undo_proposal(&mut self, id: &str, proposal_id: &str) -> ReadResult<Note> {
        self.change_proposal(id, proposal_id, true)
    }
    fn change_proposal(&mut self, id: &str, proposal_id: &str, undo: bool) -> ReadResult<Note> {
        uuid(proposal_id)?;
        let note = self.active(id, None)?;
        let raw: String = self.view.db.query_row("SELECT value_json FROM extension_data WHERE extension_id='anynote.ai.proposals' AND key=?",[proposal_id],|r|r.get(0)).optional()?.ok_or_else(||ReadError::new(ReadErrorKind::NotFound,"提案不存在"))?;
        let value: Value = serde_json::from_str(&raw)?;
        input(
            value["status"] != "proposed" || value.get("appliedRevision").is_none(),
            "提案状态字段无效",
        )?;
        let mut proposal: Proposal = serde_json::from_value(value)?;
        proposal.validate()?;
        input(
            proposal.id == proposal_id && proposal.note_id == id,
            "提案目标不匹配",
        )?;
        if !undo && proposal.status == ProposalStatus::Applied {
            return Ok(note);
        }
        conflict(if undo {
            proposal.status == ProposalStatus::Applied
                && Some(note.node.revision) == proposal.applied_revision
        } else {
            proposal.status == ProposalStatus::Proposed
                && note.node.revision == proposal.expected_revision
        })?;
        input(note.node.revision < SAFE_INTEGER, "版本计数已耗尽")?;
        let body = if undo {
            &proposal.before
        } else {
            &proposal.after
        }
        .clone();
        self.transaction(id,"update",|book| {
            let saved = book.save_inside(&note,&NotePatch {body:Some(body),..Default::default()},&[],if undo {"ai-undo"} else {"ai-proposal"})?;
            proposal.status = if undo {ProposalStatus::Undone} else {ProposalStatus::Applied};
            if !undo {proposal.applied_revision=Some(saved.node.revision);}
            book.view.db.execute("UPDATE extension_data SET value_json=?,revision=revision+1 WHERE extension_id='anynote.ai.proposals' AND key=?",params![serde_json::to_string(&proposal)?,proposal_id])?;
            Ok(saved)
        })
    }
    pub fn add_annotation(
        &mut self,
        note_id: &str,
        request: &AnnotationInput,
    ) -> ReadResult<String> {
        assets::check_hash(&request.asset_hash)?;
        input(
            (1..=100000).contains(&request.page) && request.selector.len() <= 100,
            "批注页码或数量无效",
        )?;
        for r in &request.selector {
            input(
                [r.x, r.y, r.width, r.height]
                    .iter()
                    .all(|n| (0.0..=1.0).contains(n)),
                "批注几何无效",
            )?;
        }
        text_limit(&request.quote, 0, 10000)?;
        text_limit(&request.body, 0, 10000)?;
        input(
            matches!(request.color.as_str(), "yellow" | "green" | "blue"),
            "批注颜色无效",
        )?;
        let note = self.active(note_id, None)?;
        let hash: Option<String> = self
            .view
            .db
            .query_row(
                "SELECT asset_hash FROM resources WHERE id=?",
                [&note.primary_resource_id],
                |r| r.get(0),
            )
            .optional()?;
        conflict(hash.as_deref() == Some(&request.asset_hash))?;
        self.view.asset(&request.asset_hash)?;
        let id = new_id();
        self.transaction(&id,"annotation",|book| {
            book.view.db.execute("INSERT INTO annotations(id,note_id,target_asset_hash,page,selector_json,quote,body,color,created_at) VALUES(?,?,?,?,?,?,?,?,?)",params![id,note_id,request.asset_hash,request.page,serde_json::to_string(&request.selector)?,request.quote,request.body,request.color,now()?])?;
            book.index(note_id)?;
            Ok(json!({"id":id}))
        })?;
        Ok(id)
    }
    pub fn delete_annotation(&mut self, id: &str) -> ReadResult<bool> {
        uuid(id)?;
        let note: String = self
            .view
            .db
            .query_row(
                "SELECT note_id FROM annotations WHERE id=? AND deleted_at IS NULL",
                [id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| ReadError::new(ReadErrorKind::NotFound, "批注不存在"))?;
        self.transaction(id, "annotation-delete", |book| {
            book.view.db.execute(
                "UPDATE annotations SET deleted_at=?,revision=revision+1 WHERE id=?",
                params![now()?, id],
            )?;
            book.index(&note)?;
            Ok(true)
        })
    }
    pub fn reanchor_annotations(&mut self, id: &str, hash: &str) -> ReadResult<Value> {
        assets::check_hash(hash)?;
        let note = self.active(id, None)?;
        let current: Option<String> = self
            .view
            .db
            .query_row(
                "SELECT asset_hash FROM resources WHERE id=?",
                [&note.primary_resource_id],
                |r| r.get(0),
            )
            .optional()?;
        conflict(current.as_deref() == Some(hash))?;
        self.view.asset(hash)?;
        self.transaction(id,"annotation-reanchor",|book| {
            let count = book.view.db.execute("UPDATE annotations SET target_asset_hash=?,revision=revision+1 WHERE note_id=? AND deleted_at IS NULL AND target_asset_hash<>?",params![hash,id,hash])?;
            book.index(id)?;
            Ok(json!({"reanchored":count}))
        })
    }
}
