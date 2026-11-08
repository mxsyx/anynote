use super::path::{FileIdentity, local_path};
use super::*;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::Duration,
};

pub struct ReadonlyNotebook {
    pub(crate) db: Connection,
    pub(crate) root: PathBuf,
    identity: FileIdentity,
    pub(crate) writable: bool,
    wal_identity: Option<FileIdentity>,
    pub(crate) meta: NotebookMeta,
    pub(crate) tracker: Option<BackupRevision>,
}
impl ReadonlyNotebook {
    pub fn open(root: &Path, expected_id: Option<&str>) -> ReadResult<Self> {
        if let Some(id) = expected_id {
            uuid(id)?;
        }
        if local_path(root, ".backup")?.exists() {
            return Err(ReadError::new(
                ReadErrorKind::UnsafePath,
                "备份目录不能直接打开，请恢复到新的工作目录",
            ));
        }
        let file = local_path(root, "notebook.sqlite")?;
        for suffix in ["-wal", "-shm", "-journal"] {
            local_path(root, &format!("notebook.sqlite{suffix}"))?;
        }
        let wal = local_path(root, "notebook.sqlite-wal")?;
        let wal_identity = if wal.exists() {
            Some(FileIdentity::open(&wal)?)
        } else {
            None
        };
        // Missing WAL shared memory requires SQLite recovery, which creates source files.
        // Readonly inspection leaves that recovery to an explicit writable open.
        if wal_identity.is_some() && !local_path(root, "notebook.sqlite-shm")?.exists() {
            return Err(ReadError::new(
                ReadErrorKind::Busy,
                "WAL 缺少共享内存，请先通过原存储实例恢复后关闭",
            ));
        }
        let identity = FileIdentity::open(&file)?;
        let db = Connection::open_with_flags(
            &file,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        db.busy_timeout(Duration::from_millis(100))?;
        db.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN;")?;
        let (meta, tracker) = schema::validate(&db, expected_id)?;
        let book = Self {
            db,
            root: root.to_path_buf(),
            identity,
            writable: false,
            wal_identity,
            meta,
            tracker,
        };
        book.check_path()?;
        book.verify_assets()?;
        book.verify_revision_closure()?;
        book.db.execute_batch("ROLLBACK")?;
        Ok(book)
    }
    pub(crate) fn from_writer(db: Connection, root: &Path, id: &str) -> ReadResult<Self> {
        let identity = FileIdentity::open(&local_path(root, "notebook.sqlite")?)?;
        let (meta, tracker) = schema::validate(&db, Some(id))?;
        let book = Self {
            db,
            root: root.into(),
            identity,
            writable: true,
            wal_identity: None,
            meta,
            tracker,
        };
        book.check_path()?;
        book.verify_assets()?;
        book.verify_revision_closure()?;
        Ok(book)
    }
    pub fn metadata(&self) -> &NotebookMeta {
        &self.meta
    }
    pub fn backup_revision(&self) -> Option<&BackupRevision> {
        self.tracker.as_ref()
    }
    pub(crate) fn check_path(&self) -> ReadResult<()> {
        let path = local_path(&self.root, "notebook.sqlite")?;
        for suffix in ["-wal", "-shm", "-journal"] {
            local_path(&self.root, &format!("notebook.sqlite{suffix}"))?;
        }
        if self.writable {
            return require(
                self.identity.same_file(&path)?,
                "写租约的数据库文件已被替换",
            );
        }
        let wal = local_path(&self.root, "notebook.sqlite-wal")?;
        let wal_matches = match &self.wal_identity {
            Some(identity) => identity.matches(&wal)?,
            None => !wal.exists(),
        };
        if !self.identity.matches(&path)? || !wal_matches {
            return Err(ReadError::new(
                ReadErrorKind::IdentityConflict,
                "Notebook 文件在读取后被替换或改变，请重新打开",
            ));
        }
        Ok(())
    }
    pub fn nodes(&self) -> ReadResult<Vec<Node>> {
        self.check_path()?;
        model::rows(&self.db, "SELECT n.*,t.note_type FROM nodes n LEFT JOIN notes t ON t.node_id=n.id ORDER BY n.sort_key,n.id", [])?.into_iter().map(|v| Ok(serde_json::from_value(model::node_value(v)?)?)).collect()
    }
    pub fn trash(&self) -> ReadResult<Vec<Node>> {
        Ok(self
            .nodes()?
            .into_iter()
            .filter(|n| n.deleted_at.is_some())
            .collect())
    }
    pub fn note(&self, id: &str) -> ReadResult<Note> {
        self.check_path()?;
        uuid(id)?;
        let mut rows = model::rows(
            &self.db,
            "SELECT n.*,t.note_type,CASE WHEN n.kind='folder' THEN '' ELSE r.body END body,t.primary_resource_id,t.head_revision_id,t.source_uri FROM nodes n LEFT JOIN notes t ON t.node_id=n.id LEFT JOIN note_revisions r ON r.id=t.head_revision_id WHERE n.id=?",
            [id],
        )?;
        let value = rows
            .pop()
            .ok_or_else(|| ReadError::new(ReadErrorKind::NotFound, "笔记不存在"))?;
        let note: Note = serde_json::from_value(model::node_value(value)?)?;
        for id in [&note.head_revision_id, &note.primary_resource_id]
            .into_iter()
            .flatten()
        {
            uuid(id)?;
        }
        Ok(note)
    }
    /// The default history view matches TS's latest-100 limit; all_revisions retains the entire history.
    pub fn history(&self, id: &str) -> ReadResult<Vec<Revision>> {
        self.revisions(id, true)
    }
    pub fn all_revisions(&self, id: &str) -> ReadResult<Vec<Revision>> {
        self.revisions(id, false)
    }
    fn revisions(&self, id: &str, limited: bool) -> ReadResult<Vec<Revision>> {
        self.check_path()?;
        uuid(id)?;
        let sql = format!(
            "SELECT * FROM note_revisions WHERE note_id=? ORDER BY created_at DESC,rowid DESC{}",
            if limited { " LIMIT 100" } else { "" }
        );
        model::rows(&self.db, &sql, [id])?.into_iter().map(|mut row| {
            let rid = row["id"].as_str().ok_or_else(|| ReadError::new(ReadErrorKind::Corrupt,"修订 ID 无效"))?;
            uuid(rid)?;
            let metadata: Option<String> = self.db.query_row("SELECT value_json FROM extension_data WHERE extension_id='anynote.core.revision-meta' AND key=?", [rid], |r| r.get(0)).optional()?;
            row["metadata"] = metadata.and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok()).filter(|v| valid_revision_metadata(v, id)).unwrap_or_default();
            let revision: Revision = serde_json::from_value(row)?;
            require((0..=9_007_199_254_740_991).contains(&revision.created_at), "修订时间无效")?;
            Ok(revision)
        }).collect()
    }
    pub fn annotations(&self, id: &str, include_deleted: bool) -> ReadResult<Vec<Annotation>> {
        self.check_path()?;
        self.note(id)?;
        let sql = format!(
            "SELECT * FROM annotations WHERE note_id=? {} ORDER BY page,created_at",
            if include_deleted {
                ""
            } else {
                "AND deleted_at IS NULL"
            }
        );
        model::rows(&self.db, &sql, [id])?
            .into_iter()
            .map(|mut row| {
                let raw = row["selector_json"]
                    .as_str()
                    .ok_or_else(|| ReadError::new(ReadErrorKind::Corrupt, "批注 selector 无效"))?;
                row["selector"] = serde_json::from_str(raw)?;
                let a: Annotation = serde_json::from_value(row)?;
                uuid(&a.id)?;
                uuid(&a.note_id)?;
                assets::check_hash(&a.target_asset_hash)?;
                require(
                    a.page >= 1 && a.page <= 100000 && a.revision > 0,
                    "批注页码或版本无效",
                )?;
                require(
                    a.selector.as_array().is_some_and(|s| {
                        s.len() <= 100
                            && s.iter().all(|r| {
                                ["x", "y", "width", "height"].iter().all(|k| {
                                    r[k].as_f64().is_some_and(|n| (0.0..=1.0).contains(&n))
                                })
                            })
                    }),
                    "批注几何无效",
                )?;
                Ok(a)
            })
            .collect()
    }
    /// JSON text remains byte-for-byte intact, including unknown extension records.
    pub fn extension_records(&self) -> ReadResult<Vec<ExtensionRecord>> {
        self.check_path()?;
        model::rows(
            &self.db,
            "SELECT * FROM extension_data ORDER BY extension_id,key",
            [],
        )?
        .into_iter()
        .map(|v| Ok(serde_json::from_value(v)?))
        .collect()
    }
    pub fn revision_resources(&self) -> ReadResult<Vec<RevisionResource>> {
        self.check_path()?;
        model::rows(
            &self.db,
            "SELECT * FROM revision_resources ORDER BY revision_id,resource_id",
            [],
        )?
        .into_iter()
        .map(|v| {
            let r: RevisionResource = serde_json::from_value(v)?;
            uuid(&r.revision_id)?;
            uuid(&r.resource_id)?;
            assets::check_hash(&r.asset_hash)?;
            Ok(r)
        })
        .collect()
    }
    pub fn folder_path(&self, parent_id: Option<&str>) -> ReadResult<String> {
        self.check_path()?;
        let mut parts = Vec::new();
        let mut seen = HashSet::new();
        let mut parent = parent_id.map(str::to_owned);
        while let Some(id) = parent.as_deref() {
            if !seen.insert(id.to_owned()) || seen.len() > 1000 {
                break;
            }
            let folder: Option<(String, Option<String>)> = self
                .db
                .query_row("SELECT title,parent_id FROM nodes WHERE id=?", [id], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .optional()?;
            let Some((title, next)) = folder else { break };
            parts.push(title);
            parent = next;
        }
        parts.reverse();
        Ok(format!(
            "{}{}",
            if parent.is_some() { "… / " } else { "" },
            if parts.is_empty() {
                "根目录".into()
            } else {
                parts.join(" / ")
            }
        ))
    }
}
pub(crate) fn valid_revision_metadata(v: &serde_json::Value, id: &str) -> bool {
    v.as_object().is_some_and(|m| m.len() == 4)
        && v["noteId"] == id
        && v["title"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.encode_utf16().count() <= 240)
        && v["favorite"].as_i64().is_some_and(|n| matches!(n, 0 | 1))
        && v["tags"].as_array().is_some_and(|a| {
            a.len() <= 30
                && a.iter()
                    .all(|s| s.as_str().is_some_and(|s| s.encode_utf16().count() <= 40))
        })
}
