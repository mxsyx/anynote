use super::{path::local_path, write::new_id, *};
use rusqlite::{
    Connection,
    backup::{Backup, StepResult},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

pub const SNAPSHOT_BYTES: u64 = 20 * 1024 * 1024 * 1024;
pub(crate) const RESOURCE_ROOTS: &str = "SELECT asset_hash FROM resources UNION SELECT asset_hash FROM revision_resources UNION SELECT target_asset_hash FROM annotations UNION SELECT asset_hash FROM note_text";

#[derive(Clone, Default)]
pub struct Cancellation(Arc<AtomicBool>);
impl Cancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub fn check(&self) -> ReadResult<()> {
        if self.0.load(Ordering::Acquire) {
            Err(ReadError::new(ReadErrorKind::Cancelled, "任务已取消"))
        } else {
            Ok(())
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SnapshotMode {
    Full,
    Current,
    Preservation,
}

/// Owns the private cut and the source lease; never reuse across process/lease changes.
pub struct FrozenSnapshot {
    directory: tempfile::TempDir,
    _pin: NotebookPin,
    revision: BackupRevision,
    notebook_id: String,
    prepared: Option<SnapshotMode>,
    pruned: bool,
}
impl FrozenSnapshot {
    pub fn path(&self) -> &Path {
        self.directory.path()
    }
    pub fn revision(&self) -> &BackupRevision {
        &self.revision
    }
    pub fn notebook_id(&self) -> &str {
        &self.notebook_id
    }
    pub fn preserves_unpruned_evidence(&self) -> bool {
        !self.pruned
    }
    pub fn mode(&self) -> Option<SnapshotMode> {
        self.prepared
    }
    /// Run on the service worker after capture has left the write queue.
    pub fn prepare(&mut self, mode: SnapshotMode, cancel: &Cancellation) -> ReadResult<()> {
        cancel.check()?;
        require(
            self.prepared.is_none() && !self.pruned,
            "快照已处理或处理失败",
        )?;
        self.pruned = mode != SnapshotMode::Preservation;
        let db = Connection::open(self.path().join("notebook.sqlite"))?;
        db.execute_batch(
            "PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE;",
        )?;
        if mode == SnapshotMode::Current {
            current_content(&db)?;
        }
        if mode == SnapshotMode::Full {
            let epoch: String = db.query_row(
                "SELECT CAST(storage_epoch AS TEXT) FROM _backup_revision WHERE id=1",
                [],
                |r| r.get(0),
            )?;
            db.execute_batch(&format!(
                "BEGIN; DELETE FROM assets WHERE hash NOT IN ({RESOURCE_ROOTS});"
            ))?;
            db.execute(
                "UPDATE _backup_revision SET storage_epoch=? WHERE id=1",
                [epoch],
            )?;
            db.execute_batch("COMMIT")?;
        }
        drop(db);
        cancel.check()?;
        let book = ReadonlyNotebook::open(self.path(), Some(&self.notebook_id))?;
        book.integrity_check()?;
        drop(book);
        cancel.check()?;
        self.prepared = Some(mode);
        Ok(())
    }
}
impl WriteCatalog {
    pub fn capture_snapshot(
        &mut self,
        id: &str,
        temporary_root: &Path,
        cancel: &Cancellation,
    ) -> ReadResult<FrozenSnapshot> {
        cancel.check()?;
        local_path(temporary_root, "probe")?;
        let pin = self.pin(id)?;
        let book = self.notebook(id)?;
        book.view.check_path()?;
        let revision = book.lease_revision()?;
        let directory = tempfile::Builder::new()
            .prefix("anynote.snapshot.")
            .tempdir_in(temporary_root)?;
        let mut db = Connection::open(directory.path().join("notebook.sqlite"))?;
        {
            let backup = Backup::new(&book.view.db, &mut db)?;
            loop {
                cancel.check()?;
                match backup.step(256)? {
                    StepResult::Done => break,
                    StepResult::More => (),
                    _ => return Err(ReadError::new(ReadErrorKind::Busy, "捕获切面被占用")),
                }
            }
        }
        db.execute_batch("PRAGMA journal_mode=DELETE;")?;
        let mut total = fs::metadata(directory.path().join("notebook.sqlite"))?.len();
        for asset in asset_list(&db)? {
            cancel.check()?;
            total = total
                .checked_add(asset.size)
                .ok_or_else(|| ReadError::new(ReadErrorKind::InvalidInput, "快照超限"))?;
            require(total <= SNAPSHOT_BYTES, "快照超过 20GiB")?;
            let relative = asset_relative_path(&asset.hash)?;
            let source = local_path(&book.view.root, &relative)?;
            let identity = path::FileIdentity::open(&source)?;
            require(
                fs::metadata(&source)?.len() == asset.size,
                "快照附件大小错误",
            )?;
            let target = directory.path().join(&relative);
            fs::create_dir_all(target.parent().unwrap())?;
            if let Err(error) = fs::hard_link(&source, &target) {
                if !matches!(
                    error.kind(),
                    std::io::ErrorKind::CrossesDevices
                        | std::io::ErrorKind::PermissionDenied
                        | std::io::ErrorKind::Unsupported
                ) {
                    return Err(error.into());
                }
                let mut input = fs::File::open(&source)?;
                let mut output = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&target)?;
                let mut buffer = vec![0; MAX_RANGE_BYTES];
                let mut copied = 0;
                loop {
                    cancel.check()?;
                    let n = input.read(&mut buffer)?;
                    if n == 0 {
                        break;
                    }
                    copied += n as u64;
                    require(copied <= asset.size, "附件在捕获时变化")?;
                    output.write_all(&buffer[..n])?;
                }
                require(copied == asset.size, "附件在捕获时变化")?;
                output.sync_all()?;
            }
            require(
                identity.matches(&local_path(&book.view.root, &relative)?)?,
                "附件在捕获时变化",
            )?;
        }
        require(total <= SNAPSHOT_BYTES, "快照超过 20GiB")?;
        book.view.check_path()?;
        drop(db);
        cancel.check()?;
        Ok(FrozenSnapshot {
            directory,
            _pin: pin,
            revision,
            notebook_id: id.into(),
            prepared: None,
            pruned: false,
        })
    }
}

pub fn asset_relative_path(hash: &str) -> ReadResult<String> {
    assets::check_hash(hash)?;
    Ok(format!("assets/sha256/{}/{hash}.bin", &hash[..2]))
}
fn asset_list(db: &Connection) -> ReadResult<Vec<AssetInfo>> {
    let values = model::rows(db, "SELECT hash,size,mime FROM assets ORDER BY hash", [])?;
    require(values.len() <= 100000, "附件数量超限")?;
    values
        .into_iter()
        .map(|v| Ok(serde_json::from_value(v)?))
        .collect()
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct BlockRequirement {
    pub r#type: String,
    pub version: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct DataRequirement {
    pub extension_id: String,
    pub schema_version: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContentRequirements {
    pub blocks: Vec<BlockRequirement>,
    pub data: Vec<DataRequirement>,
}
impl ReadonlyNotebook {
    pub fn assets(&self) -> ReadResult<Vec<AssetInfo>> {
        self.check_path()?;
        asset_list(&self.db)
    }
    pub fn asset_by_hash(&self, hash: &str) -> ReadResult<VerifiedAsset> {
        self.check_path()?;
        self.asset(hash)
    }
    pub fn integrity_check(&self) -> ReadResult<NotebookMeta> {
        self.check_path()?;
        schema::validate(&self.db, Some(&self.meta.id))?;
        self.verify_assets()?;
        self.verify_revision_closure()?;
        Ok(self.meta.clone())
    }
    pub fn content_requirements(&self) -> ReadResult<ContentRequirements> {
        self.check_path()?;
        let mut blocks = BTreeSet::new();
        let mut stmt = self.db.prepare("SELECT body FROM note_revisions")?;
        for body in stmt.query_map([], |r| r.get::<_, String>(0))? {
            for block in anynote_core::protocol::markdown::parse_blocks(&body?) {
                if let Some(d) = block.directive() {
                    blocks.insert(BlockRequirement {
                        r#type: d
                            .attrs()
                            .get("type")
                            .filter(|s| !s.is_empty())
                            .cloned()
                            .unwrap_or("unknown".into()),
                        version: d
                            .attrs()
                            .get("version")
                            .filter(|s| !s.is_empty())
                            .cloned()
                            .unwrap_or("unknown".into()),
                    });
                }
            }
        }
        let data = model::rows(&self.db,"SELECT DISTINCT extension_id AS extensionId,schema_version AS schemaVersion FROM extension_data ORDER BY extension_id,schema_version",[])?
            .into_iter().map(serde_json::from_value).collect::<Result<Vec<DataRequirement>,_>>()?;
        require(
            data.iter()
                .all(|r| r.schema_version > 0 && r.schema_version <= write::SAFE_INTEGER as u64),
            "内容 schema 版本无效",
        )?;
        Ok(ContentRequirements {
            blocks: blocks.into_iter().collect(),
            data,
        })
    }
    pub fn assert_current_content(&self) -> ReadResult<()> {
        for sql in [
            "SELECT count(*) FROM nodes WHERE deleted_at IS NOT NULL",
            "SELECT count(*) FROM annotations WHERE deleted_at IS NOT NULL",
            "SELECT count(*) FROM note_revisions WHERE id NOT IN (SELECT head_revision_id FROM notes)",
            "SELECT count(*) FROM extension_data WHERE extension_id <> 'anynote.core.revision-meta'",
            "SELECT count(*) FROM changes",
        ] {
            let n: i64 = self.db.query_row(sql, [], |r| r.get(0))?;
            require(n == 0, "当前归档声明与内容不符")?;
        }
        Ok(())
    }
}

/// Only call on a private, fully validated extraction. Publication is owned by the service.
pub fn remap_imported_notebook(directory: &Path, expected_id: &str) -> ReadResult<NotebookMeta> {
    let mut book = WritableNotebook::open(directory, expected_id)?;
    let id = new_id();
    let mut units = 0;
    let name: String = book
        .view
        .meta
        .name
        .chars()
        .take_while(|ch| {
            units += ch.len_utf16();
            units <= 236
        })
        .collect();
    book.view.db.execute_batch("BEGIN IMMEDIATE")?;
    book.view.db.execute(
        "UPDATE notebook_meta SET id=?,name=?",
        rusqlite::params![id, format!("{name}（导入）")],
    )?;
    book.view.db.execute(
        "UPDATE note_revisions SET body=replace(body,?,?)",
        [
            format!("anynote://notebook/{expected_id}/"),
            format!("anynote://notebook/{id}/"),
        ],
    )?;
    book.view.db.execute(
        "UPDATE _backup_revision SET lineage_id=?,storage_epoch=0 WHERE id=1",
        [new_id()],
    )?;
    book.view.meta.id = id.clone();
    for node in book.view.nodes()? {
        book.index(&node.id)?;
    }
    book.view.db.execute_batch("COMMIT")?;
    let (meta, _) = schema::validate(&book.view.db, Some(&id))?;
    drop(book);
    Ok(meta)
}

fn current_content(db: &Connection) -> ReadResult<()> {
    let fts: String = db.query_row(
        "SELECT sql FROM sqlite_master WHERE name='fts_notes'",
        [],
        |r| r.get(0),
    )?;
    db.execute_batch(&format!("PRAGMA secure_delete=ON; BEGIN; PRAGMA defer_foreign_keys=ON;
CREATE TEMP TABLE removed AS WITH RECURSIVE trash(id) AS (SELECT id FROM nodes WHERE deleted_at IS NOT NULL UNION SELECT n.id FROM nodes n JOIN trash t ON n.parent_id=t.id) SELECT id FROM trash;
DELETE FROM annotations WHERE deleted_at IS NOT NULL OR note_id IN (SELECT id FROM removed);
DELETE FROM note_text WHERE note_id IN (SELECT id FROM removed);
DELETE FROM import_reports WHERE note_id IN (SELECT id FROM removed);
DELETE FROM note_links WHERE source_note_id IN (SELECT id FROM removed);
DELETE FROM notes WHERE node_id IN (SELECT id FROM removed);
DELETE FROM revision_resources WHERE revision_id NOT IN (SELECT head_revision_id FROM notes WHERE head_revision_id IS NOT NULL);
DELETE FROM note_revisions WHERE id NOT IN (SELECT head_revision_id FROM notes WHERE head_revision_id IS NOT NULL);
DELETE FROM nodes WHERE id IN (SELECT id FROM removed);
DELETE FROM extension_data WHERE extension_id != 'anynote.core.revision-meta' OR key NOT IN (SELECT id FROM note_revisions);
DELETE FROM resources WHERE id NOT IN (SELECT resource_id FROM revision_resources UNION SELECT primary_resource_id FROM notes WHERE primary_resource_id IS NOT NULL);
CREATE TEMP TABLE current_assets(resource_id TEXT PRIMARY KEY,asset_hash TEXT NOT NULL);
INSERT INTO current_assets SELECT p.resource_id,p.asset_hash FROM revision_resources p JOIN (SELECT resource_id,MIN(revision_id) AS revision_id FROM revision_resources GROUP BY resource_id) c USING(resource_id,revision_id);
UPDATE resources SET asset_hash=COALESCE((SELECT asset_hash FROM current_assets WHERE resource_id=resources.id),asset_hash);
DROP TABLE current_assets;
DELETE FROM assets WHERE hash NOT IN ({RESOURCE_ROOTS});
DELETE FROM changes;
DROP TABLE fts_notes;
{fts};
INSERT INTO fts_notes(note_id,title,body) SELECT n.id,n.title,COALESCE(r.body,t.body,'') FROM nodes n JOIN notes s ON s.node_id=n.id LEFT JOIN note_revisions r ON r.id=s.head_revision_id LEFT JOIN note_text t ON t.note_id=n.id;
DROP TABLE removed; COMMIT; VACUUM;"))?;
    Ok(())
}

pub fn checked_local_path(root: &Path, relative: &str) -> ReadResult<PathBuf> {
    local_path(root, relative)
}
pub fn sync_directory(directory: &Path) -> ReadResult<()> {
    write_assets::sync_directory(directory)
}
