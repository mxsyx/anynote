//! RM14 isolated rehearsal. No production activation entry point is exposed.
//! Own this session on a service worker; the private FIFO is the only writer.
mod files;
use crate::config_migration::preferences::{self, Preferences};
use crate::local_backup::{NativeVolumes, VolumeProbe};
use anynote_storage::notebook::*;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

const BUDGET: u64 = 20 * 1024 * 1024 * 1024;
const FORMAT: &str = "anynote.migration.rehearsal.v1";
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Error(pub &'static str);
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(_: std::io::Error) -> Self {
        Self("IO")
    }
}
impl From<ReadError> for Error {
    fn from(e: ReadError) -> Self {
        match e.kind() {
            ReadErrorKind::Busy => Self("NOTEBOOK_BUSY"),
            _ => Self("NOTEBOOK_INVALID"),
        }
    }
}
pub type Result<T> = std::result::Result<T, Error>;
fn ensure(ok: bool, code: &'static str) -> Result<()> {
    if ok { Ok(()) } else { Err(Error(code)) }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Preflight,
    Copied,
    Verified,
    Activated,
    Freezing,
    RollbackVerified,
    Released,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct Root {
    source: PathBuf,
    preserved: PathBuf,
    identity: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct Book {
    id: String,
    path: PathBuf,
    root: usize,
    relative: PathBuf,
    identity: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    format: String,
    phase: Phase,
    roots: Vec<Root>,
    books: Vec<Book>,
    manifests: Vec<Vec<files::Entry>>,
    latest: Option<Vec<Vec<files::Entry>>>,
    preferences_published: bool,
    workspace_published: bool,
    rollback_preferences: String,
    credentials: String,
}

/// Checkpoints are after durable boundaries, so a killed caller can reopen the
/// same journal. Hooks are for fault injection, not permission decisions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Boundary {
    Preflight,
    RootCopied,
    Copied,
    Verified,
    PreferencesPublished,
    WorkspacePublished,
    Activated,
    Frozen,
    LatestCopied,
    LegacyVerified,
    Released,
}

/// The marker must be prepared in an isolated clone. External registrations must
/// also point inside that clone. This is a rehearsal fence, not OS authorization.
pub struct Rehearsal {
    // POSIX closing any fd for a SQLite inode drops that process's byte locks.
    // Drop the queue before these preopened inputs; never reopen a source DB.
    queue: Option<WriteQueue>,
    _pins: Vec<NotebookPin>,
    inputs: BTreeMap<PathBuf, fs::File>,
    _lock: fs::File,
    identities: Vec<same_file::Handle>,
    directory: PathBuf,
    user_data: PathBuf,
    journal: Journal,
}
impl Rehearsal {
    pub fn open(sandbox: &Path) -> Result<Self> {
        Self::open_with(sandbox, &NativeVolumes, &mut |_| Ok(()))
    }
    pub fn open_with(
        sandbox: &Path,
        volumes: &dyn VolumeProbe,
        hook: &mut dyn FnMut(Boundary) -> Result<()>,
    ) -> Result<Self> {
        files::safe(sandbox)?;
        let marker = crate::config_migration::read_bounded(
            &sandbox.join("anynote.migration-rehearsal.json"),
            1024,
        )
        .map_err(|_| Error("REHEARSAL_REQUIRED"))?;
        let marker: serde_json::Value =
            serde_json::from_slice(&marker).map_err(|_| Error("REHEARSAL_REQUIRED"))?;
        ensure(
            marker == serde_json::json!({"format":FORMAT}),
            "REHEARSAL_REQUIRED",
        )?;
        let user_data = sandbox.join("userData");
        let workspace = user_data.join("notebooks");
        files::safe(&workspace)?;
        // Chromium singleton artifacts are not copied or removed while ownership is uncertain.
        for name in ["SingletonLock", "SingletonSocket", "SingletonCookie"] {
            ensure(
                fs::symlink_metadata(user_data.join(name))
                    .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound),
                "LEGACY_INSTANCE",
            )?;
        }
        for path in [
            user_data.join("rust"),
            user_data.join("rust/migrations"),
            user_data.join("rust/migrations/rm14"),
        ] {
            files::directory(&path)?;
        }
        let directory = user_data.join("rust/migrations/rm14");
        let lock_path = directory.join("session.lock");
        if lock_path.exists() {
            files::safe(&lock_path)?;
        }
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(lock_path)?;
        lock.try_lock().map_err(|_| Error("MIGRATION_BUSY"))?;
        let catalog = ReadonlyCatalog::open(&workspace, 1)?;
        ensure(catalog.entries().len() <= 64, "NOTEBOOK_LIMIT")?;
        let mut roots = vec![Root {
            source: user_data.clone(),
            preserved: directory.join("preserved"),
            identity: path_identity(&user_data)?,
        }];
        let mut books = Vec::new();
        let mut inputs = BTreeMap::new();
        for entry in catalog.entries() {
            files::safe(&entry.path)?;
            ensure(
                entry.path.starts_with(sandbox),
                "EXTERNAL_OUTSIDE_REHEARSAL",
            )?;
            let root = if entry.external {
                ensure(!entry.path.starts_with(&user_data), "ROOT_OVERLAP")?;
                for other in &roots {
                    ensure(
                        !entry.path.starts_with(&other.source)
                            && !other.source.starts_with(&entry.path),
                        "ROOT_OVERLAP",
                    )?;
                }
                let preserved = entry
                    .path
                    .parent()
                    .ok_or(Error("PATH"))?
                    .join(format!(".anynote-migrate-rm14-{}", entry.id));
                roots.push(Root {
                    source: entry.path.clone(),
                    preserved,
                    identity: path_identity(&entry.path)?,
                });
                roots.len() - 1
            } else {
                0
            };
            let relative = entry
                .path
                .strip_prefix(&roots[root].source)
                .map_err(|_| Error("PATH"))?
                .to_owned();
            let path = entry.path.join("notebook.sqlite");
            files::safe(&path)?;
            inputs.insert(path.clone(), fs::File::open(path)?);
            books.push(Book {
                id: entry.id.clone(),
                path: entry.path.clone(),
                root,
                relative,
                identity: path_identity(&entry.path.join("notebook.sqlite"))?,
            });
        }
        drop(catalog);
        let identities = roots
            .iter()
            .map(|r| same_file::Handle::from_path(&r.source))
            .collect::<std::io::Result<Vec<_>>>()?;
        let saved = directory.join("journal.json");
        let mut journal: Journal = if saved.exists() {
            let bytes = crate::config_migration::read_bounded(&saved, 64 * 1024 * 1024)
                .map_err(|_| Error("JOURNAL_INVALID"))?;
            serde_json::from_slice(&bytes).map_err(|_| Error("JOURNAL_INVALID"))?
        } else {
            Journal {
                format: FORMAT.into(),
                phase: Phase::Preflight,
                roots: roots.clone(),
                books: books.clone(),
                manifests: Vec::new(),
                latest: None,
                preferences_published: false,
                workspace_published: false,
                rollback_preferences: "not-requested".into(),
                credentials: "reauthentication-required-tasks-paused".into(),
            }
        };
        ensure(
            journal.format == FORMAT && journal.roots == roots && journal.books == books,
            "IDENTITY_CHANGED",
        )?;
        let queue = WriteQueue::open_for_preservation(&workspace, 64)?;
        let ids = books.iter().map(|b| b.id.clone()).collect::<Vec<_>>();
        let pins = if journal.phase == Phase::Released {
            Vec::new()
        } else {
            queue
                .submit(move |catalog| {
                    let mut pins = Vec::new();
                    for id in ids {
                        pins.push(catalog.pin(&id)?);
                        catalog.checkpoint_for_preservation(&id)?;
                    }
                    Ok(pins)
                })?
                .wait()?
        };
        // The queue now owns every SQLite lease. Inputs were opened before it.
        let mut manifests = Vec::new();
        for root in &roots {
            manifests.push(files::inventory(
                &root.source,
                Some(&directory),
                &mut inputs,
            )?);
        }
        if journal.manifests.is_empty() {
            ensure(!saved.exists(), "JOURNAL_INVALID")?;
            journal.manifests = manifests;
        } else if matches!(
            journal.phase,
            Phase::Preflight | Phase::Copied | Phase::Verified
        ) && !journal.preferences_published
            && !journal.workspace_published
        {
            ensure(journal.manifests == manifests, "SOURCE_CHANGED")?;
        }
        ensure(journal.manifests.len() == roots.len(), "JOURNAL_INVALID")?;
        space_check(&roots, &journal.manifests, volumes)?;
        let session = Self {
            queue: if journal.phase == Phase::Released {
                None
            } else {
                Some(queue)
            },
            _pins: pins,
            inputs,
            _lock: lock,
            identities,
            directory,
            user_data,
            journal,
        };
        session.save()?;
        hook(Boundary::Preflight)?;
        Ok(session)
    }
    pub fn phase(&self) -> Phase {
        self.journal.phase
    }
    pub fn journal_path(&self) -> PathBuf {
        self.directory.join("journal.json")
    }
    pub fn notebook_count(&self) -> usize {
        self.journal.books.len()
    }
    fn save(&self) -> Result<()> {
        files::json(&self.journal_path(), &self.journal)
    }
    fn guard(&self) -> Result<()> {
        for (root, identity) in self.journal.roots.iter().zip(&self.identities) {
            files::safe(&root.source)?;
            ensure(
                identity == &same_file::Handle::from_path(&root.source)?,
                "IDENTITY_CHANGED",
            )?;
        }
        for (path, file) in &self.inputs {
            files::safe(path)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                let old = file.metadata()?;
                let current = fs::metadata(path)?;
                ensure(
                    old.ino() == current.ino()
                        && old.dev() == current.dev()
                        && current.nlink() == 1,
                    "IDENTITY_CHANGED",
                )?;
            }
        }
        Ok(())
    }
    fn current(&mut self) -> Result<Vec<Vec<files::Entry>>> {
        self.guard()?;
        self.journal
            .roots
            .iter()
            .map(|root| files::inventory(&root.source, Some(&self.directory), &mut self.inputs))
            .collect()
    }
    fn verify_copies(&self, latest: bool) -> Result<Vec<PathBuf>> {
        let manifests = if latest {
            self.journal.latest.as_ref().ok_or(Error("PHASE"))?
        } else {
            &self.journal.manifests
        };
        ensure(
            manifests.len() == self.journal.roots.len(),
            "JOURNAL_INVALID",
        )?;
        for (root, expected) in self.journal.roots.iter().zip(manifests) {
            let path = copy_path(root, latest);
            ensure(
                files::inventory(&path, None, &mut BTreeMap::new())? == *expected,
                "COPY_CHANGED",
            )?;
        }
        self.journal
            .books
            .iter()
            .map(|book| {
                let path = copy_path(&self.journal.roots[book.root], latest).join(&book.relative);
                ReadonlyNotebook::open(&path, Some(&book.id))?.integrity_check()?;
                Ok(path)
            })
            .collect()
    }
    pub fn prepare(&mut self, hook: &mut dyn FnMut(Boundary) -> Result<()>) -> Result<()> {
        ensure(
            matches!(
                self.phase(),
                Phase::Preflight | Phase::Copied | Phase::Verified
            ),
            "PHASE",
        )?;
        ensure(
            !self.journal.preferences_published && !self.journal.workspace_published,
            "ACTIVATION_PENDING",
        )?;
        ensure(self.current()? == self.journal.manifests, "SOURCE_CHANGED")?;
        for (root, entries) in self.journal.roots.iter().zip(&self.journal.manifests) {
            files::copy(&root.source, &root.preserved, entries, &mut self.inputs)?;
            hook(Boundary::RootCopied)?;
        }
        self.journal.phase = Phase::Copied;
        self.save()?;
        hook(Boundary::Copied)?;
        self.verify_copies(false)?;
        ensure(self.current()? == self.journal.manifests, "SOURCE_CHANGED")?;
        self.journal.phase = Phase::Verified;
        self.save()?;
        hook(Boundary::Verified)
    }
    /// Activates only this explicitly marked clone, retaining original path leases.
    pub fn activate(&mut self, hook: &mut dyn FnMut(Boundary) -> Result<()>) -> Result<()> {
        ensure(
            matches!(self.phase(), Phase::Verified | Phase::Activated),
            "PHASE",
        )?;
        self.guard()?;
        self.verify_copies(false)?;
        if self.phase() == Phase::Activated {
            return Ok(());
        }
        let mut current = self.current()?;
        let mut original = self.journal.manifests.clone();
        // Each publication has a write-ahead flag. A retry may see either old or
        // new bytes, but only these two owned configuration files may differ.
        for manifests in [&mut current, &mut original] {
            if self.journal.preferences_published {
                manifests[0].retain(|e| e.path != Path::new("rust/preferences.json"));
            }
            if self.journal.workspace_published {
                manifests[0].retain(|e| e.path != Path::new("rust/workspace.json"));
            }
        }
        ensure(current == original, "SOURCE_CHANGED")?;
        let leveldb = self.journal.roots[0]
            .preserved
            .join("Local Storage/leveldb");
        let preferences = if leveldb.exists() {
            let report =
                preferences::read_preferences(&leveldb, "file://", preferences::ELECTRON_VERSION)
                    .map_err(|_| Error("PREFERENCES"))?;
            ensure(report.is_complete(), "PREFERENCES_INCOMPLETE")?;
            report.preferences
        } else {
            Preferences::default()
        };
        self.journal.preferences_published = true;
        self.save()?;
        preferences
            .save(&self.user_data.join("rust"))
            .map_err(|_| Error("PREFERENCES"))?;
        hook(Boundary::PreferencesPublished)?;
        self.journal.workspace_published = true;
        self.save()?;
        files::json(
            &self.user_data.join("rust/workspace.json"),
            &serde_json::json!({"format":"anynote.workspace.v1","mode":"rehearsal","tasksPaused":true,"notebooks":self.journal.books.iter().map(|b| serde_json::json!({"id":b.id,"path":b.path})).collect::<Vec<_>>()}),
        )?;
        hook(Boundary::WorkspacePublished)?;
        self.journal.phase = Phase::Activated;
        self.save()?;
        hook(Boundary::Activated)
    }
    /// Admission is owned by this non-cloneable session, never by a UI or a timer.
    pub fn submit<T: Send + 'static>(
        &mut self,
        id: &str,
        action: impl FnOnce(&mut WritableNotebook) -> ReadResult<T> + Send + 'static,
    ) -> Result<WriteTicket<T>> {
        ensure(self.phase() == Phase::Activated, "WRITES_PAUSED")?;
        self.guard()?;
        ensure(
            self.journal.books.iter().any(|b| b.id == id),
            "NOTEBOOK_UNKNOWN",
        )?;
        let id = id.to_owned();
        Ok(self
            .queue
            .as_ref()
            .ok_or(Error("RELEASED"))?
            .submit(move |catalog| {
                catalog.begin_writing()?;
                action(catalog.notebook(&id)?)
            })?)
    }
    pub fn rollback(
        &mut self,
        legacy_read: &mut dyn FnMut(&[PathBuf]) -> Result<()>,
        hook: &mut dyn FnMut(Boundary) -> Result<()>,
    ) -> Result<()> {
        ensure(
            matches!(
                self.phase(),
                Phase::Activated | Phase::Freezing | Phase::RollbackVerified
            ),
            "PHASE",
        )?;
        if self.phase() == Phase::RollbackVerified {
            let copies = self.verify_copies(true)?;
            legacy_read(&copies)?;
            self.verify_copies(true)?;
            let mut current = self.current()?;
            let mut expected = self
                .journal
                .latest
                .clone()
                .ok_or(Error("JOURNAL_INVALID"))?;
            for entries in [&mut current[0], &mut expected[0]] {
                entries.retain(|e| e.path != Path::new("rust/workspace.json"));
            }
            ensure(current == expected, "LATEST_CHANGED")?;
            return self.release(hook);
        }
        self.journal.phase = Phase::Freezing;
        self.save()?;
        let ids = self
            .journal
            .books
            .iter()
            .map(|b| b.id.clone())
            .collect::<Vec<_>>();
        self.queue
            .as_ref()
            .ok_or(Error("RELEASED"))?
            .submit(move |catalog| {
                for id in ids {
                    catalog.checkpoint_for_preservation(&id)?;
                }
                Ok(())
            })?
            .wait()?;
        hook(Boundary::Frozen)?;
        let latest = self.current()?;
        space_check(&self.journal.roots, &latest, &NativeVolumes)?;
        if let Some(saved) = &self.journal.latest {
            ensure(*saved == latest, "LATEST_CHANGED")?;
        } else {
            self.journal.latest = Some(latest);
            self.save()?;
        }
        for (root, entries) in self
            .journal
            .roots
            .iter()
            .zip(self.journal.latest.as_ref().unwrap())
        {
            files::copy(
                &root.source,
                &copy_path(root, true),
                entries,
                &mut self.inputs,
            )?;
        }
        hook(Boundary::LatestCopied)?;
        let copies = self.verify_copies(true)?;
        for (book, copy) in self.journal.books.iter().zip(&copies) {
            let candidate = tempfile::tempdir_in(&self.directory)?;
            let output = candidate.path().join("latest.anynote");
            let manifest = crate::archive::export_preserved_directory(
                copy,
                &book.id,
                &output,
                &Cancellation::default(),
            )
            .map_err(|_| Error("ARCHIVE"))?;
            let published = self.directory.join(format!("{}.latest.anynote", book.id));
            if published.exists() {
                let old = crate::archive::validate_archive(
                    &published,
                    &self.directory,
                    &Cancellation::default(),
                )
                .map_err(|_| Error("ARCHIVE"))?;
                ensure(
                    serde_json::to_value(old.manifest).ok() == serde_json::to_value(manifest).ok(),
                    "ARCHIVE_CHANGED",
                )?;
            } else {
                fs::rename(output, &published)?;
                files::sync(&self.directory)?;
            }
        }
        // The legacy oracle reads only sealed clones. Failure retains every lease.
        legacy_read(&copies)?;
        self.verify_copies(true)?;
        ensure(
            self.current()? == *self.journal.latest.as_ref().unwrap(),
            "LATEST_CHANGED",
        )?;
        let preferences_path = self.user_data.join("rust/preferences.json");
        let reverse = (|| {
            let bytes = crate::config_migration::read_bounded(&preferences_path, 64 * 1024 * 1024)
                .map_err(|_| Error("PREFERENCES"))?;
            let v: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(|_| Error("PREFERENCES"))?;
            ensure(v["format"] == "anynote.preferences.v1", "PREFERENCES")?;
            let preferences: Preferences =
                serde_json::from_value(serde_json::json!({"values":v["values"]}))
                    .map_err(|_| Error("PREFERENCES"))?;
            let reverse = preferences.reverse().map_err(|_| Error("PREFERENCES"))?;
            files::json(&self.directory.join("reverse-preferences.json"), &reverse)
        })();
        self.journal.rollback_preferences = if reverse.is_ok() {
            "mapped-awaiting-chromium-publication"
        } else {
            "preserved-manual-recovery-required"
        }
        .into();
        self.journal.phase = Phase::RollbackVerified;
        self.save()?;
        hook(Boundary::LegacyVerified)?;
        self.release(hook)
    }
    fn release(&mut self, hook: &mut dyn FnMut(Boundary) -> Result<()>) -> Result<()> {
        // Only Rust's startup pointer changes. Shared _local and new notebook
        // data stay at their current paths; no snapshot is copied back over them.
        files::json(
            &self.user_data.join("rust/workspace.json"),
            &serde_json::json!({"format":"anynote.workspace.v1","mode":"legacy","tasksPaused":true}),
        )?;
        self.journal.phase = Phase::Released;
        self.save()?;
        self.queue.take();
        hook(Boundary::Released)
    }
}
fn copy_path(root: &Root, latest: bool) -> PathBuf {
    if latest {
        root.preserved.with_file_name(format!(
            "{}.latest",
            root.preserved.file_name().unwrap().to_string_lossy()
        ))
    } else {
        root.preserved.clone()
    }
}

fn path_identity(path: &Path) -> Result<String> {
    let metadata = fs::metadata(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(format!("{}:{}", metadata.dev(), metadata.ino()))
    }
    #[cfg(not(unix))]
    {
        // Native Windows directory/file identity qualification remains in RM32.
        let _ = metadata;
        Err(Error("PLATFORM_IDENTITY_UNQUALIFIED"))
    }
}

fn space_check(
    roots: &[Root],
    manifests: &[Vec<files::Entry>],
    probe: &dyn VolumeProbe,
) -> Result<()> {
    let mut budgets: BTreeMap<String, (u64, u64, PathBuf)> = BTreeMap::new();
    let mut archive_bytes = 0u64;
    for (root, entries) in roots.iter().zip(manifests) {
        let parent = root.preserved.parent().ok_or(Error("PATH"))?;
        let volume = probe.inspect(parent).map_err(|_| Error("VOLUME"))?;
        let source = probe.inspect(&root.source).map_err(|_| Error("VOLUME"))?;
        ensure(volume.same_volume(&source), "CROSS_VOLUME")?;
        let total = entries
            .iter()
            .try_fold(0u64, |sum, e| sum.checked_add(e.bytes))
            .ok_or(Error("BUDGET"))?;
        archive_bytes = archive_bytes.checked_add(total).ok_or(Error("BUDGET"))?;
        let budget = budgets
            .entry(volume.device_id)
            .or_insert((0, 0, parent.to_owned()));
        budget.0 = budget
            .0
            .checked_add(total.checked_mul(2).ok_or(Error("BUDGET"))?)
            .ok_or(Error("BUDGET"))?;
        budget.1 = budget
            .1
            .max(entries.iter().map(|e| e.bytes).max().unwrap_or(0));
    }
    // Archives and temporary extraction checks live in the device journal even when
    // the source notebook is on another volume.
    let journal = roots[0].preserved.parent().ok_or(Error("PATH"))?;
    let device = probe
        .inspect(journal)
        .map_err(|_| Error("VOLUME"))?
        .device_id;
    let budget = budgets.get_mut(&device).ok_or(Error("VOLUME"))?;
    budget.0 = budget
        .0
        .checked_add(archive_bytes.checked_mul(2).ok_or(Error("BUDGET"))?)
        .ok_or(Error("BUDGET"))?;
    budget.1 = budget.1.max(archive_bytes);
    for (_, (bytes, largest, path)) in budgets {
        probe
            .inspect(&path)
            .map_err(|_| Error("VOLUME"))?
            .require_local(largest, bytes.saturating_add(16 * 1024 * 1024))
            .map_err(|_| Error("NO_SPACE"))?;
    }
    Ok(())
}
