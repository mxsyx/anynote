use super::*;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashSet,
    path::Path,
    sync::LazyLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub(crate) const SAFE_INTEGER: i64 = 9_007_199_254_740_991;
pub(crate) fn input(ok: bool, message: &str) -> ReadResult<()> {
    if ok {
        Ok(())
    } else {
        Err(ReadError::new(ReadErrorKind::InvalidInput, message))
    }
}
pub(crate) fn conflict(ok: bool) -> ReadResult<()> {
    if ok {
        Ok(())
    } else {
        Err(ReadError::new(
            ReadErrorKind::Conflict,
            "版本冲突，请保留草稿并重新加载",
        ))
    }
}
pub(crate) fn text_limit(text: &str, min: usize, max: usize) -> ReadResult<()> {
    input(
        (min..=max).contains(&text.encode_utf16().count()),
        "文本长度无效",
    )
}
pub(crate) fn now() -> ReadResult<i64> {
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ReadError::new(ReadErrorKind::InvalidInput, "系统时间无效"))?
        .as_millis();
    input(time <= SAFE_INTEGER as u128, "系统时间超限")?;
    Ok(time as i64)
}
pub(crate) fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CreateNode {
    pub title: String,
    pub parent_id: Option<String>,
    pub kind: NodeKind,
    pub note_type: Option<NoteType>,
    #[serde(default)]
    pub body: String,
    pub primary_resource_id: Option<String>,
    pub source_uri: Option<String>,
}
impl CreateNode {
    pub fn note(title: impl Into<String>, body: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            body: body.into(),
            parent_id: None,
            kind: NodeKind::Note,
            note_type: Some(NoteType::Markdown),
            primary_resource_id: None,
            source_uri: None,
        }
    }
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NotePatch {
    pub title: Option<String>,
    pub body: Option<String>,
    pub tags: Option<Vec<String>>,
    pub favorite: Option<bool>,
}
impl NotePatch {
    fn validate(&self) -> ReadResult<()> {
        if let Some(s) = &self.title {
            text_limit(s.trim(), 1, 240)?;
        }
        if let Some(s) = &self.body {
            text_limit(s, 0, 2_000_000)?;
        }
        if let Some(tags) = &self.tags {
            input(tags.len() <= 30, "标签数量超限")?;
            for tag in tags {
                text_limit(tag, 1, 40)?;
            }
        }
        Ok(())
    }
}

/// An exclusive SQLite lease. Obtain it through WriteCatalog on the storage queue.
/// No raw connection or arbitrary SQL escapes this boundary.
pub struct WritableNotebook {
    pub(crate) view: ReadonlyNotebook,
    lease_id: String,
}
impl Drop for WritableNotebook {
    fn drop(&mut self) {
        if self.view.check_path().is_ok() {
            let _ = self.view.db.execute_batch("PRAGMA journal_mode=DELETE;");
        }
    }
}
impl WritableNotebook {
    pub(crate) fn open(root: &Path, id: &str) -> ReadResult<Self> {
        let mut book = Self::open_for_preservation(root, id)?;
        book.begin_writing()?;
        Ok(book)
    }
    pub(crate) fn open_for_preservation(root: &Path, id: &str) -> ReadResult<Self> {
        uuid(id)?;
        input(
            !path::local_path(root, ".backup")?.exists(),
            "备份目录必须先恢复",
        )?;
        let file = path::local_path(root, "notebook.sqlite")?;
        let identity = path::FileIdentity::open(&file)?;
        for suffix in ["-wal", "-shm", "-journal"] {
            path::local_path(root, &format!("notebook.sqlite{suffix}"))?;
        }
        let db = Connection::open_with_flags(
            &file,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        db.busy_timeout(Duration::ZERO)?;
        db.execute_batch(
            "PRAGMA trusted_schema=OFF; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;",
        )?;
        require(identity.same_file(&file)?, "打开期间数据库被替换")?;
        // Validate before adding the existing optional tracker or switching journal modes.
        let book = Self {
            view: ReadonlyNotebook::from_writer(db, root, id)?,
            lease_id: new_id(),
        };
        book.view
            .db
            .execute_batch("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;")?;
        Ok(book)
    }
    pub(crate) fn begin_writing(&mut self) -> ReadResult<()> {
        self.view.db.execute_batch(
            "PRAGMA journal_mode=DELETE; PRAGMA journal_mode=WAL; BEGIN EXCLUSIVE; COMMIT;",
        )?;
        if self.view.tracker.is_none() {
            let tx = self.view.db.transaction()?;
            tx.execute_batch(BACKUP_REVISION_SQL)?;
            tx.execute("INSERT INTO _backup_revision VALUES(1,1,?,0)", [new_id()])?;
            tx.commit()?;
        }
        self.refresh_metadata()
    }
    pub fn read(&self) -> &ReadonlyNotebook {
        &self.view
    }
    pub fn lease_revision(&self) -> ReadResult<BackupRevision> {
        self.view.check_path()?;
        let mut revision = self
            .view
            .tracker
            .clone()
            .ok_or_else(|| ReadError::new(ReadErrorKind::Corrupt, "备份版本缺失"))?;
        revision.lineage_id = self.lease_id.clone();
        Ok(revision)
    }
    fn refresh_metadata(&mut self) -> ReadResult<()> {
        self.view.meta = serde_json::from_value(
            model::rows(&self.view.db, "SELECT * FROM notebook_meta", [])?.remove(0),
        )?;
        let (lineage_id, storage_epoch) = self.view.db.query_row(
            "SELECT lineage_id,CAST(storage_epoch AS TEXT) FROM _backup_revision WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        self.view.tracker = Some(BackupRevision {
            lineage_id,
            storage_epoch,
            content_seq: self.view.meta.content_seq.to_string(),
        });
        Ok(())
    }
    pub(crate) fn transaction<T: Serialize>(
        &mut self,
        id: &str,
        operation: &str,
        action: impl FnOnce(&Self) -> ReadResult<T>,
    ) -> ReadResult<T> {
        self.view.check_path()?;
        self.view.db.execute_batch("BEGIN IMMEDIATE")?;
        // RAII rollback also covers unwinding; no partially published proposal or revision.
        struct Rollback<'a>(&'a Connection);
        impl Drop for Rollback<'_> {
            fn drop(&mut self) {
                if !self.0.is_autocommit() {
                    let _ = self.0.execute_batch("ROLLBACK");
                }
            }
        }
        let guard = Rollback(&self.view.db);
        let result = action(self)?;
        self.view.check_path()?;
        self.view.db.execute(
            "INSERT INTO changes(entity_id,operation,payload_json,created_at) VALUES(?,?,?,?)",
            params![id, operation, serde_json::to_string(&result)?, now()?],
        )?;
        let updated = self.view.db.execute(
            "UPDATE notebook_meta SET content_seq=content_seq+1 WHERE content_seq<?",
            [SAFE_INTEGER],
        )?;
        require(updated == 1, "内容计数已耗尽")?;
        self.view.db.execute_batch("COMMIT")?;
        drop(guard);
        self.refresh_metadata()?;
        Ok(result)
    }
    pub(crate) fn active(&self, id: &str, expected: Option<i64>) -> ReadResult<Note> {
        let note = self.view.note(id)?;
        if note.node.deleted_at.is_some() {
            return Err(ReadError::new(ReadErrorKind::NotFound, "条目已在回收站"));
        }
        if let Some(revision) = expected {
            input((1..SAFE_INTEGER).contains(&revision), "节点版本无效或耗尽")?;
            conflict(note.node.revision == revision)?;
        }
        Ok(note)
    }
    pub(crate) fn parent(&self, parent: Option<&str>, source: Option<&str>) -> ReadResult<()> {
        let mut current = parent.map(str::to_owned);
        let mut seen = HashSet::new();
        while let Some(id) = current {
            input(
                Some(id.as_str()) != source && seen.insert(id.clone()),
                "不能将目录移入自身或子目录",
            )?;
            let node = self.active(&id, None)?;
            input(node.node.kind == NodeKind::Folder, "父节点必须是目录")?;
            current = node.node.parent_id;
        }
        Ok(())
    }
    pub fn create_node(
        &mut self,
        request: &CreateNode,
        resources: &[ResourceWrite],
    ) -> ReadResult<Note> {
        self.validate_create(request, resources)?;
        let id = new_id();
        self.transaction(&id, "create", |book| {
            book.create_inside(&id, request, resources)
        })
    }
    pub(crate) fn validate_create(
        &self,
        request: &CreateNode,
        resources: &[ResourceWrite],
    ) -> ReadResult<()> {
        text_limit(request.title.trim(), 1, 240)?;
        text_limit(&request.body, 0, 2_000_000)?;
        if let Some(uri) = &request.source_uri {
            text_limit(uri, 0, 4000)?;
        }
        input(
            request.kind != NodeKind::Folder
                || (resources.is_empty() && request.primary_resource_id.is_none()),
            "目录不能绑定资源",
        )?;
        if let Some(id) = &request.primary_resource_id {
            uuid(id)?;
        }
        self.parent(request.parent_id.as_deref(), None)?;
        Ok(())
    }
    pub(crate) fn create_inside(
        &self,
        id: &str,
        request: &CreateNode,
        resources: &[ResourceWrite],
    ) -> ReadResult<Note> {
        let book = self;
        book.bind_resources(resources)?;
        let time = now()?;
        book.view.db.execute("INSERT INTO nodes(id,parent_id,kind,title,sort_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", params![id, request.parent_id, if request.kind == NodeKind::Folder {"folder"} else {"note"}, request.title.trim(),time,time,time])?;
        if request.kind == NodeKind::Note {
            let kind = match request.note_type.as_ref().unwrap_or(&NoteType::Markdown) {
                NoteType::Markdown => "markdown",
                NoteType::Image => "image",
                NoteType::Pdf => "pdf",
            };
            book.view.db.execute("INSERT INTO notes(node_id,note_type,primary_resource_id,source_uri) VALUES(?,?,?,?)", params![id,kind,request.primary_resource_id,request.source_uri])?;
            book.append_revision(id, &request.body, "user", None, resources, None)?;
        }
        book.view.note(id)
    }
    pub fn save_note(
        &mut self,
        id: &str,
        expected: i64,
        patch: &NotePatch,
        resources: &[ResourceWrite],
    ) -> ReadResult<Note> {
        patch.validate()?;
        let note = self.active(id, Some(expected))?;
        input(
            note.node.kind == NodeKind::Note || resources.is_empty(),
            "目录不能绑定资源",
        )?;
        self.transaction(id, "update", |book| {
            book.save_inside(&note, patch, resources, "user")
        })
    }
    pub(crate) fn save_inside(
        &self,
        note: &Note,
        patch: &NotePatch,
        resources: &[ResourceWrite],
        actor: &str,
    ) -> ReadResult<Note> {
        self.bind_resources(resources)?;
        let id = &note.node.id;
        let tags = serde_json::to_string(patch.tags.as_ref().unwrap_or(&note.node.tags))?;
        self.view.db.execute("UPDATE nodes SET title=?,tags=?,favorite=?,revision=revision+1,updated_at=? WHERE id=?", params![patch.title.as_deref().map(str::trim).unwrap_or(&note.node.title),tags,patch.favorite.map(i64::from).unwrap_or(note.node.favorite),now()?,id])?;
        if note.node.kind == NodeKind::Note {
            self.append_revision(
                id,
                patch.body.as_deref().unwrap_or(&note.body),
                actor,
                note.head_revision_id.as_deref(),
                resources,
                None,
            )?;
        } else {
            self.index(id)?;
        }
        self.view.note(id)
    }
    fn append_revision(
        &self,
        id: &str,
        body: &str,
        actor: &str,
        previous: Option<&str>,
        resources: &[ResourceWrite],
        restore: Option<&str>,
    ) -> ReadResult<()> {
        let revision = new_id();
        self.view.db.execute(
            "INSERT INTO note_revisions(id,note_id,body,created_at,actor) VALUES(?,?,?,?,?)",
            params![revision, id, body, now()?, actor],
        )?;
        self.view.db.execute(
            "UPDATE notes SET head_revision_id=? WHERE node_id=?",
            params![revision, id],
        )?;
        if let Some(old) = restore {
            self.view.db.execute("INSERT INTO revision_resources SELECT ?,resource_id,asset_hash FROM revision_resources WHERE revision_id=?", params![revision,old])?;
        } else {
            let primary: Option<String> = self.view.db.query_row(
                "SELECT primary_resource_id FROM notes WHERE node_id=?",
                [id],
                |r| r.get(0),
            )?;
            self.capture(&revision, body, primary.as_deref(), previous, resources)?;
        }
        self.record_revision(&revision, id)?;
        self.index(id)
    }
    fn record_revision(&self, revision: &str, id: &str) -> ReadResult<()> {
        let node = self.view.note(id)?.node;
        self.view.db.execute("INSERT OR REPLACE INTO extension_data(extension_id,key,value_json) VALUES('anynote.core.revision-meta',?,?)", params![revision, json!({"noteId":id,"title":node.title,"tags":node.tags,"favorite":node.favorite}).to_string()])?;
        Ok(())
    }
    pub fn restore_revision(
        &mut self,
        id: &str,
        expected: i64,
        revision: &str,
    ) -> ReadResult<Note> {
        uuid(revision)?;
        let note = self.active(id, Some(expected))?;
        let body: String = self
            .view
            .db
            .query_row(
                "SELECT body FROM note_revisions WHERE id=? AND note_id=?",
                [revision, id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| ReadError::new(ReadErrorKind::NotFound, "历史版本不存在"))?;
        let meta: Option<String> = self.view.db.query_row("SELECT value_json FROM extension_data WHERE extension_id='anynote.core.revision-meta' AND key=?", [revision], |r| r.get(0)).optional()?;
        let meta = meta
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .filter(|v| read::valid_revision_metadata(v, id));
        self.transaction(id, "restore-revision", |book| {
            if let Some(meta) = meta {
                book.view.db.execute(
                    "UPDATE nodes SET title=?,tags=?,favorite=? WHERE id=?",
                    params![
                        meta["title"].as_str(),
                        meta["tags"].to_string(),
                        meta["favorite"].as_i64(),
                        id
                    ],
                )?;
            }
            book.view.db.execute(
                "UPDATE nodes SET revision=revision+1,updated_at=? WHERE id=?",
                params![now()?, id],
            )?;
            book.append_revision(
                id,
                &body,
                "restore",
                note.head_revision_id.as_deref(),
                &[],
                Some(revision),
            )?;
            book.view.note(id)
        })
    }
    pub fn move_node(&mut self, id: &str, parent: Option<&str>) -> ReadResult<Note> {
        self.active(id, None)?;
        self.parent(parent, Some(id))?;
        self.transaction(id,"move",|book| {
            let changed = book.view.db.execute("UPDATE nodes SET parent_id=?,revision=revision+1,updated_at=? WHERE id=? AND revision<?",params![parent,now()?,id,SAFE_INTEGER])?;
            input(changed == 1,"节点版本已耗尽")?;
            book.view.note(id)
        })
    }
    pub fn place_node(
        &mut self,
        id: &str,
        expected: i64,
        parent: Option<&str>,
        before: Option<&str>,
    ) -> ReadResult<Note> {
        self.active(id, Some(expected))?;
        self.parent(parent, Some(id))?;
        input(before != Some(id), "不能以自身作为排序锚点")?;
        let siblings: Vec<(String,f64)> = self.view.db.prepare("SELECT id,sort_key FROM nodes WHERE parent_id IS ? AND deleted_at IS NULL AND id<>? ORDER BY sort_key,id")?.query_map(params![parent,id],|r|Ok((r.get(0)?,r.get(1)?)))?.collect::<Result<_,_>>()?;
        let position = if let Some(before) = before {
            uuid(before)?;
            siblings
                .iter()
                .position(|n| n.0 == before)
                .ok_or_else(|| ReadError::new(ReadErrorKind::InvalidInput, "排序目标不在目录中"))?
        } else {
            siblings.len()
        };
        let left = if position > 0 {
            siblings[position - 1].1
        } else {
            0.0
        };
        let right = siblings.get(position).map(|n| n.1).unwrap_or(left + 2048.0);
        self.transaction(id,"place",|book| {
            let key = if right-left < 2.0 || right.fract()!=0.0 || right.abs() > SAFE_INTEGER as f64 || left < 0.0 {
                for (i,(sibling,_)) in siblings.iter().enumerate() { book.view.db.execute("UPDATE nodes SET sort_key=? WHERE id=?",params![(i as i64+1)*1024,sibling])?; }
                position as f64 * 1024.0 + 512.0
            } else { (left+(right-left)/2.0).floor() };
            book.view.db.execute("UPDATE nodes SET parent_id=?,sort_key=?,revision=revision+1,updated_at=? WHERE id=?", params![parent,key,now()?,id])?;
            book.view.note(id)
        })
    }
    pub fn trash_node(&mut self, id: &str) -> ReadResult<bool> {
        self.change_trash(id, false)
    }
    pub fn restore_node(&mut self, id: &str) -> ReadResult<bool> {
        self.change_trash(id, true)
    }
    fn change_trash(&mut self, id: &str, restore: bool) -> ReadResult<bool> {
        let note = self.view.note(id)?;
        self.transaction(id,if restore {"restoreNode"} else {"trashNode"},|book| {
            let affected: Vec<String> = if restore {
                if let Some(parent) = &note.node.parent_id
                    && book.view.note(parent)?.node.deleted_at.is_some() { book.view.db.execute("UPDATE nodes SET parent_id=NULL WHERE id=?",[id])?; }
                let ids = book.view.db.prepare("SELECT id FROM nodes WHERE deleted_by=?")?.query_map([&note.node.deleted_by],|r|r.get(0))?.collect::<Result<_,_>>()?;
                book.view.db.execute("UPDATE nodes SET deleted_at=NULL,deleted_by=NULL,revision=revision+1 WHERE deleted_by=?",[&note.node.deleted_by])?;
                ids
            } else {
                let ids = book.view.db.prepare("WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN tree t ON n.parent_id=t.id) SELECT id FROM tree")?.query_map([id],|r|r.get(0))?.collect::<Result<Vec<String>,_>>()?;
                let batch = new_id();
                for item in &ids { book.view.db.execute("UPDATE nodes SET deleted_at=?,deleted_by=?,revision=revision+1 WHERE id=? AND deleted_at IS NULL",params![now()?,batch,item])?; }
                ids
            };
            for id in affected { book.view.note(&id)?; book.index(&id)?; }
            Ok(true)
        })
    }
    pub(crate) fn rename(
        &mut self,
        title: &str,
        icon: Option<&str>,
        color: Option<&str>,
    ) -> ReadResult<NotebookMeta> {
        let title = title.trim();
        text_limit(title, 1, 240)?;
        if let Some(icon) = icon {
            text_limit(icon.trim(), 1, 16)?;
        }
        if let Some(color) = color {
            input(
                color.len() == 7
                    && color.starts_with('#')
                    && color[1..].bytes().all(|b| b.is_ascii_hexdigit()),
                "封面颜色无效",
            )?;
        }
        let id = self.view.meta.id.clone();
        self.transaction(&id,"rename",|book| {
            book.view.db.execute("UPDATE notebook_meta SET name=?,icon=COALESCE(?,icon),cover_color=COALESCE(?,cover_color)",params![title,icon.map(str::trim),color])?;
            Ok(serde_json::from_value(model::rows(&book.view.db,"SELECT * FROM notebook_meta",[])?.remove(0))?)
        })
    }
    pub(crate) fn index(&self, id: &str) -> ReadResult<()> {
        let db = &self.view.db;
        db.execute("DELETE FROM note_links WHERE source_note_id=?", [id])?;
        let source: String = db.query_row("SELECT r.body FROM notes t JOIN note_revisions r ON r.id=t.head_revision_id WHERE t.node_id=?",[id],|r|r.get(0)).optional()?.unwrap_or_default();
        static LINKS: LazyLock<regex::Regex> = LazyLock::new(|| {
            regex::Regex::new(
                r"(?i)anynote://notebook/([a-f0-9-]{36})/note/([a-f0-9-]{36})(?:#([^\s)]*))?",
            )
            .unwrap()
        });
        for m in LINKS.captures_iter(&source) {
            db.execute(
                "INSERT OR IGNORE INTO note_links VALUES(?,?,?,?)",
                params![
                    id,
                    &m[1],
                    &m[2],
                    m.get(3).map(|m| m.as_str()).filter(|s| !s.is_empty())
                ],
            )?;
        }
        db.execute("DELETE FROM fts_notes WHERE note_id=?", [id])?;
        let node = self.view.note(id)?;
        if node.node.kind == NodeKind::Note && node.node.deleted_at.is_none() {
            let mut parts = vec![
                source,
                db.query_row("SELECT body FROM note_text WHERE note_id=?", [id], |r| {
                    r.get::<_, String>(0)
                })
                .optional()?
                .unwrap_or_default(),
            ];
            parts.extend(
                db.prepare(
                    "SELECT quote,body FROM annotations WHERE note_id=? AND deleted_at IS NULL",
                )?
                .query_map([id], |r| {
                    Ok(format!(
                        "{}\n{}",
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?,
            );
            parts.push(serde_json::to_string(&node.node.tags)?);
            db.execute(
                "INSERT INTO fts_notes VALUES(?,?,?)",
                params![id, node.node.title, parts.join("\n")],
            )?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, process::Command};

    #[test]
    #[ignore = "subprocess fixture executed by process_exit_rolls_back_sql_and_releases_lease"]
    fn crash_child() {
        let Ok(root) = std::env::var("ANYNOTE_RM05_CRASH_ROOT") else {
            return;
        };
        let id = std::env::var("ANYNOTE_RM05_CRASH_ID").unwrap();
        let mut book = WritableNotebook::open(Path::new(&root), &id).unwrap();
        let node = book.read().nodes().unwrap().remove(0);
        let _ = book.transaction(&node.id, "crash", |book| -> ReadResult<bool> {
            book.view.db.execute(
                "UPDATE nodes SET title='uncommitted',revision=revision+1",
                [],
            )?;
            book.view
                .db
                .execute("UPDATE notebook_meta SET content_seq=content_seq+1", [])?;
            std::process::exit(86);
        });
        panic!("crash hook did not exit");
    }
    #[test]
    fn process_exit_rolls_back_sql_and_releases_lease() {
        let temp_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm05");
        fs::create_dir_all(&temp_root).unwrap();
        let dir = tempfile::tempdir_in(temp_root.canonicalize().unwrap()).unwrap();
        let q = WriteQueue::open(dir.path(), 1).unwrap();
        let (id, nid) = q
            .submit(|s| {
                let id = s.create_notebook("崩溃")?.id;
                let n = s
                    .notebook(&id)?
                    .create_node(&CreateNode::note("已提交", "保持"), &[])?;
                Ok((id, n.node.id))
            })
            .unwrap()
            .wait()
            .unwrap();
        drop(q);
        let root = dir.path().join(&id);
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "notebook::write::tests::crash_child",
                "--nocapture",
                "--ignored",
            ])
            .env("ANYNOTE_RM05_CRASH_ROOT", &root)
            .env("ANYNOTE_RM05_CRASH_ID", &id)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(86));
        let mut book = WritableNotebook::open(&root, &id).unwrap();
        assert_eq!(book.read().note(&nid).unwrap().node.title, "已提交");
        assert_eq!(book.read().metadata().content_seq, 1);
        book.save_note(
            &nid,
            1,
            &NotePatch {
                body: Some("恢复后".into()),
                ..Default::default()
            },
            &[],
        )
        .unwrap();
        drop(book);
        assert_eq!(
            ReadonlyNotebook::open(&root, Some(&id))
                .unwrap()
                .note(&nid)
                .unwrap()
                .body,
            "恢复后"
        );
    }
    #[test]
    fn failure_after_proposal_update_rolls_back_body_state_and_every_counter() {
        let temp_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm05");
        fs::create_dir_all(&temp_root).unwrap();
        let dir = tempfile::tempdir_in(temp_root.canonicalize().unwrap()).unwrap();
        let q = WriteQueue::open(dir.path(), 1).unwrap();
        q.submit(|s| {
            let id = s.create_notebook("失败注入")?.id;
            let b = s.notebook(&id)?;
            let n = b.create_node(&CreateNode::note("提案", "原文"), &[])?;
            let p = b.propose(&n.node.id, 1, "新文", None)?;
            let before = model::rows(&b.view.db, "SELECT * FROM _backup_revision", [])?;
            let seq = b.view.meta.content_seq;
            let failed = b.transaction(&n.node.id, "update", |book| -> ReadResult<bool> {
                book.save_inside(
                    &n,
                    &NotePatch {
                        body: Some("新文".into()),
                        ..Default::default()
                    },
                    &[],
                    "ai-proposal",
                )?;
                book.view.db.execute(
                    "UPDATE extension_data SET value_json='{}',revision=revision+1 WHERE key=?",
                    [&p.id],
                )?;
                Err(ReadError::new(
                    ReadErrorKind::Offline,
                    "injected storage failure",
                ))
            });
            assert!(failed.is_err());
            assert_eq!(b.view.note(&n.node.id)?.body, "原文");
            assert_eq!(b.view.history(&n.node.id)?.len(), 1);
            assert_eq!(
                model::rows(&b.view.db, "SELECT * FROM _backup_revision", [])?,
                before
            );
            assert_eq!(b.view.meta.content_seq, seq);
            let raw: String = b.view.db.query_row(
                "SELECT value_json FROM extension_data WHERE key=?",
                [&p.id],
                |r| r.get(0),
            )?;
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&raw)?["status"],
                "proposed"
            );
            b.apply_proposal(&n.node.id, &p.id)?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    }
}
