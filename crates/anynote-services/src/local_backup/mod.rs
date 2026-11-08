//! Local backup v3. Synchronous entry points run on a service worker, never the UI thread.
mod io;
mod jobs;
pub use jobs::{JobContext, JobReceipt, LocalJob, job_receipt, prepare_job};
mod manifest;
pub mod volume;
use crate::archive::{copy_hash, sync_tree};
use anynote_storage::notebook::*;
use io::{BookDir, Session, token};
pub use io::{Target, TargetStatus, initialize_target};
pub use manifest::{Chunk, Database, Entry, Manifest, Revision};
use manifest::{Pending, valid_id};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
pub use volume::{NativeVolumes, VolumeInfo, VolumeProbe};

pub const CHUNK_BYTES: u64 = 1024 * 1024;
pub const MANIFEST_BYTES: u64 = 128 * 1024 * 1024;
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug)]
pub struct Error {
    pub code: String,
    pub message: String,
}
impl Error {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::new(
            if e.kind() == std::io::ErrorKind::StorageFull {
                "NO_SPACE"
            } else {
                "IO_FAILED"
            },
            e.to_string(),
        )
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Self::new("MANIFEST_INVALID", e.to_string())
    }
}
impl From<ReadError> for Error {
    fn from(e: ReadError) -> Self {
        Self::new(
            if e.kind() == ReadErrorKind::Cancelled {
                "CANCELLED"
            } else {
                "STORAGE_INVALID"
            },
            e.to_string(),
        )
    }
}
impl From<crate::archive::ArchiveError> for Error {
    fn from(e: crate::archive::ArchiveError) -> Self {
        match e {
            crate::archive::ArchiveError::Storage(e) => e.into(),
            crate::archive::ArchiveError::Io(e) => e.into(),
            e => Self::new("HASH_MISMATCH", e.to_string()),
        }
    }
}
fn require(ok: bool, code: &str, message: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(Error::new(code, message))
    }
}
fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn now() -> String {
    let t: chrono::DateTime<chrono::Utc> = std::time::SystemTime::now().into();
    t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Checkpoint {
    PendingWritten,
    BeforeFileWrite,
    FilesWritten,
    BeforeManifest,
    ManifestPublished,
    BeforeCleanup,
}
/// A host can report progress or inject I/O faults; returning an error before publication preserves the previous manifest.
pub trait Observer {
    fn checkpoint(&mut self, point: Checkpoint) -> Result<()>;
}
impl Observer for () {
    fn checkpoint(&mut self, _: Checkpoint) -> Result<()> {
        Ok(())
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub copied_files: usize,
    pub skipped_files: usize,
    pub copied_bytes: u64,
    pub capture_skipped: bool,
    pub pending_cleanup: bool,
    pub revision: Revision,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationIssue {
    pub path: String,
    pub code: String,
    pub message: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationReport {
    pub target_id: String,
    pub notebook_id: String,
    pub status: String,
    pub complete: bool,
    pub checked_files: usize,
    pub verified_files: usize,
    pub database_check: String,
    pub issues: Vec<VerificationIssue>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupResult {
    pub notebook_id: String,
    pub status: String,
    pub result: Option<BackupResult>,
    pub error: Option<String>,
}

pub struct LocalBackupService {
    session_id: String,
    successful: BTreeMap<(String, String), (Revision, String)>,
}
impl Default for LocalBackupService {
    fn default() -> Self {
        Self {
            session_id: new_id(),
            successful: BTreeMap::new(),
        }
    }
}
impl LocalBackupService {
    pub fn backup(
        &mut self,
        target: &Target,
        queue: &WriteQueue,
        id: &str,
        temporary_root: &Path,
        cancel: &Cancellation,
        probe: &dyn VolumeProbe,
    ) -> Result<BackupResult> {
        self.backup_observed(target, queue, id, temporary_root, cancel, probe, &mut ())
    }
    #[allow(clippy::too_many_arguments)]
    pub fn backup_observed(
        &mut self,
        target: &Target,
        queue: &WriteQueue,
        id: &str,
        temporary_root: &Path,
        cancel: &Cancellation,
        probe: &dyn VolumeProbe,
        observer: &mut dyn Observer,
    ) -> Result<BackupResult> {
        valid_id(id)?;
        cancel.check()?;
        let key = (target.id.clone(), id.into());
        let book_id = id.to_owned();
        let (source, revision) = queue
            .submit(move |s| {
                Ok((
                    s.notebook_path(&book_id)?,
                    s.notebook(&book_id)?.lease_revision()?,
                ))
            })?
            .wait()?;
        let revision = Revision::from(&revision);
        let session = Session::open(target, &[source], probe)?;
        let root = session.book(id, true)?;
        let mut previous = load_manifest(&root, target, id)?;
        recover_pending(&root, target, id, previous.as_ref(), cancel)?;
        if let Some(m) = &mut previous {
            cleanup(&root, m, cancel)?;
        }
        let trusted_previous = previous
            .as_ref()
            .map(|m| {
                Ok::<_, Error>(
                    self.successful.get(&key)
                        == Some(&(m.revision.clone(), io::json_fingerprint(m)?)),
                )
            })
            .transpose()?
            .unwrap_or(false);
        if let Some(m) = &previous
            && trusted_previous
            && revision == m.revision
        {
            let mut intact = true;
            for f in &m.files {
                if !matches(&root, f, &self.session_id, false, cancel)? {
                    intact = false;
                    break;
                }
            }
            let book_id = id.to_owned();
            let current = queue
                .submit(move |s| s.notebook(&book_id)?.lease_revision())?
                .wait()?;
            if intact && revision == Revision::from(&current) {
                cancel.check()?;
                root.guard()?;
                return Ok(BackupResult {
                    copied_files: 0,
                    skipped_files: m.files.len(),
                    copied_bytes: 0,
                    capture_skipped: true,
                    pending_cleanup: false,
                    revision,
                });
            }
        }
        self.successful.remove(&key);
        let book_id = id.to_owned();
        let temporary = temporary_root.to_owned();
        let cancellation = cancel.clone();
        let mut cut = queue
            .submit(move |s| s.capture_snapshot(&book_id, &temporary, &cancellation))?
            .wait()?;
        cut.prepare(SnapshotMode::Preservation, cancel)?;
        let (mut m, sources) = plan(&cut, target, previous.as_ref(), cancel)?;
        let old: BTreeMap<_, _> = previous
            .as_ref()
            .into_iter()
            .flat_map(|m| &m.files)
            .map(|f| (f.path.as_str(), f))
            .collect();
        let mut missing = Vec::new();
        for f in &mut m.files {
            f.token = if trusted_previous {
                old.get(f.path.as_str()).and_then(|o| o.token.clone())
            } else {
                None
            };
            if matches(&root, f, &self.session_id, false, cancel)? {
                f.token = token(&root.open(&f.path)?, &self.session_id)?;
            } else {
                require(
                    old.contains_key(f.path.as_str()) || !root.exists(&f.path)?,
                    "UNKNOWN_FILE_CONFLICT",
                    "同名未知文件禁止覆盖",
                )?;
                missing.push(f.clone());
            }
        }
        let copy_bytes: u64 = missing.iter().map(|f| f.size).sum();
        let largest = m
            .assets
            .iter()
            .map(|f| f.size)
            .max()
            .unwrap_or(0)
            .max(CHUNK_BYTES);
        root.guard()?
            .require_local(largest, copy_bytes + CHUNK_BYTES + 3 * io::json_size(&m)?)?;
        let pending = Pending {
            target_id: target.id.clone(),
            notebook_id: id.into(),
            task_id: m.task_id.clone(),
            files: missing.clone(),
        };
        cancel.check()?;
        root.atomic_json(".backup/pending.json", &pending)?;
        observer.checkpoint(Checkpoint::PendingWritten)?;
        for f in &missing {
            cancel.check()?;
            observer.checkpoint(Checkpoint::BeforeFileWrite)?;
            root.guard()?;
            let temp = format!("{}.{}.tmp", f.path, m.task_id);
            let mut output = root.create(&temp)?;
            let (source, offset) = sources
                .get(&f.path)
                .ok_or_else(|| Error::new("STORAGE_INVALID", "分块来源缺失"))?;
            let mut input = fs::File::open(source)?;
            input.seek(SeekFrom::Start(*offset))?;
            let (size, hash) = copy_hash(&mut input.take(f.size), &mut output, f.size, cancel)?;
            require(
                size == f.size && hash == f.sha256,
                "FILE_CHANGED",
                "备份源在复制时改变",
            )?;
            output.sync_all()?;
            drop(output);
            verify_file(
                &root,
                &Entry {
                    path: temp.clone(),
                    ..f.clone()
                },
                cancel,
            )?;
            cancel.check()?;
            root.replace(&temp, &f.path)?;
        }
        for f in &mut m.files {
            f.token = token(&root.open(&f.path)?, &self.session_id)?;
        }
        observer.checkpoint(Checkpoint::FilesWritten)?;
        cancel.check()?;
        observer.checkpoint(Checkpoint::BeforeManifest)?;
        cancel.check()?;
        for file in &m.files {
            require(
                matches(&root, file, &self.session_id, false, cancel)?,
                "FILE_CHANGED",
                "发布前备份文件改变",
            )?;
        }
        root.guard()?;
        root.atomic_json(".backup/manifest.json", &m)?;
        // The commit is already visible. Failures from this point report cleanup pending, not a failed backup.
        let cleaned = (|| {
            observer.checkpoint(Checkpoint::ManifestPublished)?;
            observer.checkpoint(Checkpoint::BeforeCleanup)?;
            cleanup(&root, &mut m, cancel)?;
            root.remove(".backup/pending.json")
        })();
        if cleaned.is_ok() {
            self.successful
                .insert(key, (m.revision.clone(), io::json_fingerprint(&m)?));
        }
        Ok(BackupResult {
            copied_files: missing.len(),
            skipped_files: m.files.len() - missing.len(),
            copied_bytes: copy_bytes,
            capture_skipped: false,
            pending_cleanup: cleaned.is_err(),
            revision: m.revision,
        })
    }
    pub fn backup_group(
        &mut self,
        target: &Target,
        queue: &WriteQueue,
        ids: &[String],
        temporary: &Path,
        cancel: &Cancellation,
        probe: &dyn VolumeProbe,
    ) -> Result<Vec<GroupResult>> {
        require(
            !ids.is_empty()
                && ids.len() <= 1000
                && ids.iter().collect::<BTreeSet<_>>().len() == ids.len(),
            "INVALID_INPUT",
            "分组过大或包含重复库",
        )?;
        let mut results = Vec::new();
        for id in ids {
            let result = self.backup(target, queue, id, temporary, cancel, probe);
            results.push(match result {
                Ok(result) => GroupResult {
                    notebook_id: id.clone(),
                    status: "completed".into(),
                    result: Some(result),
                    error: None,
                },
                Err(e) => GroupResult {
                    notebook_id: id.clone(),
                    status: match e.code.as_str() {
                        "TARGET_OFFLINE" => "waiting-disk",
                        "CANCELLED" => "cancelled",
                        _ => "failed",
                    }
                    .into(),
                    result: None,
                    error: Some(e.to_string()),
                },
            });
        }
        Ok(results)
    }
    pub fn verify(
        &self,
        target: &Target,
        id: &str,
        temporary: &Path,
        cancel: &Cancellation,
        probe: &dyn VolumeProbe,
    ) -> Result<VerificationReport> {
        let session = Session::open(target, &[], probe)?;
        let root = session.book(id, false)?;
        let mut m = load_manifest(&root, target, id)?
            .ok_or_else(|| Error::new("MANIFEST_MISSING", "没有备份清单"))?;
        let staging = tempfile::Builder::new()
            .prefix("anynote.local.verify.")
            .tempdir_in(temporary)?;
        let report = verify_staged(&root, &m, staging.path(), cancel)?;
        if report.status == "passed" {
            cancel.check()?;
            m.last_full_verified_at = Some(now());
            root.atomic_json(".backup/manifest.json", &m)?;
        }
        Ok(report)
    }
    pub fn restore(
        &self,
        target: &Target,
        id: &str,
        destination: &Path,
        cancel: &Cancellation,
        probe: &dyn VolumeProbe,
    ) -> Result<NotebookMeta> {
        cancel.check()?;
        let session = Session::open(target, &[destination.to_owned()], probe)?;
        let root = session.book(id, false)?;
        let m = load_manifest(&root, target, id)?
            .ok_or_else(|| Error::new("MANIFEST_MISSING", "没有备份清单"))?;
        probe.inspect(destination)?.require_local(
            m.database
                .file
                .size
                .max(m.assets.iter().map(|a| a.size).max().unwrap_or(0)),
            m.database.file.size + m.assets.iter().map(|a| a.size).sum::<u64>() + CHUNK_BYTES,
        )?;
        let staging = tempfile::Builder::new()
            .prefix("anynote.local.restore.")
            .tempdir_in(destination)?;
        let report = verify_staged(&root, &m, staging.path(), cancel)?;
        cancel.check()?;
        require(
            report.status == "passed",
            "VERIFICATION_FAILED",
            &serde_json::to_string(&report)?,
        )?;
        let meta = remap_imported_notebook(staging.path(), id)?;
        drop(ReadonlyNotebook::open(staging.path(), Some(&meta.id))?);
        let target_path = checked_local_path(destination, &meta.id)?;
        require(!target_path.exists(), "TARGET_EXISTS", "恢复新库已存在")?;
        sync_tree(staging.path())?;
        cancel.check()?;
        root.guard()?;
        fs::rename(staging.path(), target_path)?;
        sync_directory(destination)?;
        Ok(meta)
    }
}
fn load_manifest(root: &BookDir<'_>, target: &Target, id: &str) -> Result<Option<Manifest>> {
    let m: Option<Manifest> = root.json(".backup/manifest.json")?;
    if let Some(m) = &m {
        m.validate(&target.id, id)?;
    }
    Ok(m)
}
fn verify_file(root: &BookDir<'_>, f: &Entry, cancel: &Cancellation) -> Result<()> {
    let mut file = root.open(&f.path)?;
    let before = token(&file, "verify")?;
    require(
        file.metadata()?.len() == f.size,
        "SIZE_MISMATCH",
        "文件大小不匹配",
    )?;
    let (size, hash) = copy_hash(&mut file, &mut std::io::sink(), f.size, cancel)?;
    require(
        size == f.size && hash == f.sha256,
        "HASH_MISMATCH",
        "SHA-256 不匹配",
    )?;
    require(
        before == token(&file, "verify")? && before == token(&root.open(&f.path)?, "verify")?,
        "FILE_CHANGED",
        "校验时文件改变",
    )
}
fn matches(
    root: &BookDir<'_>,
    f: &Entry,
    session: &str,
    full: bool,
    cancel: &Cancellation,
) -> Result<bool> {
    cancel.check()?;
    if !root.exists(&f.path)? {
        return Ok(false);
    }
    let file = root.open(&f.path)?;
    if file.metadata()?.len() != f.size {
        return Ok(false);
    }
    let t = token(&file, session)?;
    if !full && t.is_some() && t == f.token {
        return Ok(true);
    }
    match verify_file(root, f, cancel) {
        Ok(()) => Ok(true),
        Err(e) if e.code == "HASH_MISMATCH" || e.code == "SIZE_MISMATCH" => Ok(false),
        Err(e) => Err(e),
    }
}
fn cleanup(root: &BookDir<'_>, m: &mut Manifest, cancel: &Cancellation) -> Result<()> {
    if m.cleanup.is_empty() {
        return Ok(());
    }
    for f in &m.cleanup {
        cancel.check()?;
        if root.exists(&f.path)? {
            verify_file(root, f, cancel)?;
            root.remove(&f.path)?;
        }
    }
    m.cleanup.clear();
    root.atomic_json(".backup/manifest.json", m)
}
fn recover_pending(
    root: &BookDir<'_>,
    target: &Target,
    id: &str,
    m: Option<&Manifest>,
    cancel: &Cancellation,
) -> Result<()> {
    let Some(p): Option<Pending> = root.json(".backup/pending.json")? else {
        return Ok(());
    };
    valid_id(&p.task_id)?;
    require(
        p.target_id == target.id && p.notebook_id == id && p.files.len() <= 120480,
        "MANIFEST_INVALID",
        "pending 身份无效",
    )?;
    let keep: BTreeSet<_> = m
        .into_iter()
        .flat_map(|m| m.files.iter().chain(&m.cleanup))
        .map(|f| f.path.as_str())
        .collect();
    let mut seen = BTreeSet::new();
    for f in &p.files {
        f.validate()?;
        require(seen.insert(&f.path), "MANIFEST_INVALID", "pending 重复文件")?;
    }
    for f in &p.files {
        cancel.check()?;
        root.remove(&format!("{}.{}.tmp", f.path, p.task_id))?;
        if !keep.contains(f.path.as_str()) && matches(root, f, "recovery", true, cancel)? {
            root.remove(&f.path)?;
        }
    }
    root.remove(".backup/pending.json")
}
type Sources = BTreeMap<String, (PathBuf, u64)>;
fn plan(
    cut: &FrozenSnapshot,
    target: &Target,
    previous: Option<&Manifest>,
    cancel: &Cancellation,
) -> Result<(Manifest, Sources)> {
    let book = ReadonlyNotebook::open(cut.path(), Some(cut.notebook_id()))?;
    let meta = book.integrity_check()?;
    let assets = book.assets()?;
    let mut sources = Sources::new();
    let mut files = BTreeMap::new();
    let mut chunks = Vec::new();
    let path = cut.path().join("notebook.sqlite");
    let mut database = fs::File::open(&path)?;
    let mut digest = Sha256::new();
    let mut offset = 0;
    let mut bytes = vec![0u8; CHUNK_BYTES as usize];
    loop {
        cancel.check()?;
        let mut n = 0;
        while n < bytes.len() {
            let read = database.read(&mut bytes[n..])?;
            if read == 0 {
                break;
            }
            n += read;
        }
        if n == 0 {
            break;
        }
        let hash = format!("{:x}", Sha256::digest(&bytes[..n]));
        digest.update(&bytes[..n]);
        let relative = format!("chunks/{hash}.bin");
        sources.insert(relative.clone(), (path.clone(), offset));
        chunks.push(Chunk {
            sha256: hash.clone(),
            size: n as u64,
        });
        files.insert(
            relative.clone(),
            Entry {
                path: relative,
                size: n as u64,
                sha256: hash,
                token: None,
            },
        );
        offset += n as u64;
    }
    let mut asset_entries = Vec::new();
    for a in assets {
        let relative = asset_relative_path(&a.hash)?;
        let file = crate::archive::describe(cut.path(), &relative, cancel)?;
        require(
            file.size == a.size && file.sha256 == a.hash,
            "HASH_MISMATCH",
            "源附件损坏",
        )?;
        sources.insert(relative.clone(), (cut.path().join(&relative), 0));
        let entry = Entry {
            path: relative.clone(),
            size: a.size,
            sha256: a.hash,
            token: None,
        };
        files.insert(relative, entry.clone());
        asset_entries.push(entry);
    }
    let cleanup = previous
        .into_iter()
        .flat_map(|m| m.files.iter().chain(&m.cleanup))
        .filter(|f| !files.contains_key(&f.path))
        .map(|f| (f.path.clone(), f.clone()))
        .collect::<BTreeMap<_, _>>()
        .into_values()
        .collect();
    let m = Manifest {
        format: "anynote.local-backup".into(),
        format_version: 3,
        target_id: target.id.clone(),
        notebook_id: cut.notebook_id().into(),
        task_id: new_id(),
        completed_at: now(),
        revision: Revision::from(cut.revision()),
        name: meta.name,
        database: Database {
            file: Entry {
                path: "notebook.sqlite".into(),
                size: offset,
                sha256: format!("{:x}", digest.finalize()),
                token: None,
            },
            chunk_size: CHUNK_BYTES,
            chunks,
        },
        assets: asset_entries,
        files: files.into_values().collect(),
        cleanup,
        verification_status: "verified-new-files".into(),
        last_full_verified_at: None,
    };
    m.validate(&target.id, cut.notebook_id())?;
    Ok((m, sources))
}
fn verify_staged(
    root: &BookDir<'_>,
    m: &Manifest,
    staging: &Path,
    cancel: &Cancellation,
) -> Result<VerificationReport> {
    let mut report = VerificationReport {
        target_id: m.target_id.clone(),
        notebook_id: m.notebook_id.clone(),
        status: "checking".into(),
        complete: false,
        checked_files: 0,
        verified_files: 0,
        database_check: "skipped".into(),
        issues: Vec::new(),
    };
    for f in &m.files {
        report.checked_files += 1;
        match verify_file(root, f, cancel) {
            Ok(()) => report.verified_files += 1,
            Err(e) => {
                let interrupted = e.code == "CANCELLED";
                report.issues.push(VerificationIssue {
                    path: f.path.clone(),
                    code: e.code,
                    message: e.message,
                });
                if interrupted {
                    report.status = "interrupted".into();
                    return Ok(report);
                }
            }
        }
    }
    if report.issues.is_empty() {
        let result: Result<()> = (|| {
            let mut db = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(staging.join("notebook.sqlite"))?;
            let mut digest = Sha256::new();
            let mut size = 0u64;
            for c in &m.database.chunks {
                cancel.check()?;
                let path = format!("chunks/{}.bin", c.sha256);
                let mut bytes = Vec::with_capacity(c.size as usize);
                let (n, hash) = copy_hash(&mut root.open(&path)?, &mut bytes, c.size, cancel)?;
                require(
                    n == c.size && hash == c.sha256,
                    "HASH_MISMATCH",
                    "装配分块损坏",
                )?;
                digest.update(&bytes);
                db.write_all(&bytes)?;
                size += n;
            }
            require(
                size == m.database.file.size
                    && format!("{:x}", digest.finalize()) == m.database.file.sha256,
                "HASH_MISMATCH",
                "数据库有序分块或总 hash 不符",
            )?;
            db.sync_all()?;
            drop(db);
            for f in &m.assets {
                let path = staging.join(&f.path);
                fs::create_dir_all(path.parent().unwrap())?;
                let mut out = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path)?;
                let (n, hash) = copy_hash(&mut root.open(&f.path)?, &mut out, f.size, cancel)?;
                require(
                    n == f.size && hash == f.sha256,
                    "HASH_MISMATCH",
                    "恢复附件校验失败",
                )?;
                out.sync_all()?;
            }
            cancel.check()?;
            let book = ReadonlyNotebook::open(staging, Some(&m.notebook_id))?;
            book.integrity_check()?;
            let actual: BTreeSet<_> = book
                .assets()?
                .into_iter()
                .map(|a| (a.hash, a.size))
                .collect();
            require(
                actual
                    == m.assets
                        .iter()
                        .map(|a| (a.sha256.clone(), a.size))
                        .collect(),
                "SQLITE_INVALID",
                "数据库与附件集合不匹配",
            )?;
            cancel.check()?;
            root.guard()?;
            Ok(())
        })();
        match result {
            Ok(()) => report.database_check = "passed".into(),
            Err(e) => {
                report.database_check = "failed".into();
                let interrupted = e.code == "CANCELLED";
                report.issues.push(VerificationIssue {
                    path: "notebook.sqlite".into(),
                    code: e.code,
                    message: e.message,
                });
                if interrupted {
                    report.status = "interrupted".into();
                    return Ok(report);
                }
            }
        }
    }
    report.complete = true;
    report.status = if report.issues.is_empty() {
        "passed"
    } else {
        "failed"
    }
    .into();
    Ok(report)
}
