use super::{
    path::{FileIdentity, local_path},
    write::{input, new_id, now},
    *,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::Path,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CleanupFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupPreview {
    pub id: String,
    pub files: Vec<CleanupFile>,
    pub bytes: u64,
}
struct Candidate {
    file: CleanupFile,
    identity: FileIdentity,
}
pub(crate) struct CleanupPlan {
    preview: CleanupPreview,
    candidates: Vec<Candidate>,
    revision: BackupRevision,
    keep: usize,
    days: u32,
    created: Instant,
}
pub(crate) type CleanupPlans = HashMap<String, CleanupPlan>;
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Journal {
    format: String,
    notebook_id: String,
    plan_id: String,
    files: Vec<CleanupFile>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub quarantined: usize,
    pub bytes: u64,
    pub recovery_id: String,
}
fn digest(path: &Path) -> ReadResult<String> {
    let mut f = fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut b = vec![0; 64 * 1024];
    loop {
        let n = f.read(&mut b)?;
        if n == 0 {
            break;
        }
        h.update(&b[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}
fn snapshot_time(name: &str) -> Option<i64> {
    let value = name.strip_suffix(".anynote")?;
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value
        .parse::<i64>()
        .ok()
        .filter(|n| (0..=write::SAFE_INTEGER).contains(n))
}
fn candidates(root: &Path, keep: usize, days: u32) -> ReadResult<Vec<Candidate>> {
    let dir = local_path(root, "snapshots")?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let cutoff = now()?.saturating_sub(i64::from(days) * 86400000);
    let mut names = Vec::new();
    for entry in fs::read_dir(dir)? {
        let name = entry?.file_name().to_string_lossy().into_owned();
        if let Some(time) = snapshot_time(&name) {
            names.push((time, name));
        }
    }
    names.sort_by(|a, b| b.cmp(a));
    let mut result = Vec::new();
    for (time, name) in names.into_iter().skip(keep) {
        if time >= cutoff {
            continue;
        }
        let relative = format!("snapshots/{name}");
        let path = local_path(root, &relative)?;
        let identity = FileIdentity::open(&path)?;
        let meta = fs::metadata(&path)?;
        let hash = digest(&path)?;
        require(identity.matches(&path)?, "清理候选在预览时改变")?;
        result.push(Candidate {
            file: CleanupFile {
                path: relative,
                size: meta.len(),
                sha256: hash,
            },
            identity,
        });
    }
    Ok(result)
}
impl WriteCatalog {
    pub fn preview_cleanup(
        &mut self,
        id: &str,
        keep_snapshots: usize,
        keep_days: u32,
    ) -> ReadResult<CleanupPreview> {
        input(
            (1..=1000).contains(&keep_snapshots) && keep_days <= 3650,
            "清理策略无效",
        )?;
        self.cleanup_idle(id)?;
        let revision = self.notebook(id)?.lease_revision()?;
        let root = self.notebook_path(id)?;
        let candidates = candidates(&root, keep_snapshots, keep_days)?;
        let files = candidates
            .iter()
            .map(|c| c.file.clone())
            .collect::<Vec<_>>();
        let bytes = files
            .iter()
            .try_fold(0u64, |n, f| n.checked_add(f.size))
            .ok_or_else(|| ReadError::new(ReadErrorKind::InvalidInput, "清理大小超限"))?;
        let preview = CleanupPreview {
            id: new_id(),
            files,
            bytes,
        };
        self.cleanup_plans
            .retain(|_, p| p.created.elapsed() < Duration::from_secs(300));
        if self.cleanup_plans.len() >= 20 {
            return Err(ReadError::new(ReadErrorKind::Busy, "清理计划过多"));
        }
        self.cleanup_plans.insert(
            preview.id.clone(),
            CleanupPlan {
                preview: preview.clone(),
                candidates,
                revision,
                keep: keep_snapshots,
                days: keep_days,
                created: Instant::now(),
            },
        );
        Ok(preview)
    }
    fn cleanup_idle(&self, id: &str) -> ReadResult<()> {
        if self.has_pins(id) {
            Err(ReadError::new(
                ReadErrorKind::Busy,
                "活动快照或资源租约尚未释放",
            ))
        } else {
            Ok(())
        }
    }
    /// Explicit confirmation moves only the reviewed snapshots to durable quarantine.
    /// Retain the journal and bytes so failures/restarts remain recoverable.
    pub fn apply_cleanup(
        &mut self,
        id: &str,
        plan_id: &str,
        confirmed: bool,
    ) -> ReadResult<CleanupResult> {
        self.apply_cleanup_checked(id, plan_id, confirmed, || Ok(()))
    }
    fn apply_cleanup_checked(
        &mut self,
        id: &str,
        plan_id: &str,
        confirmed: bool,
        checkpoint: impl Fn() -> ReadResult<()>,
    ) -> ReadResult<CleanupResult> {
        input(confirmed, "清理需要显式确认")?;
        uuid(plan_id)?;
        self.cleanup_idle(id)?;
        let revision = self.notebook(id)?.lease_revision()?;
        let root = self.notebook_path(id)?;
        let plan = self
            .cleanup_plans
            .get(plan_id)
            .ok_or_else(|| ReadError::new(ReadErrorKind::Conflict, "清理计划不存在或已过期"))?;
        if plan.created.elapsed() >= Duration::from_secs(300)
            || plan.revision.lineage_id != revision.lineage_id
            || plan.revision.storage_epoch != revision.storage_epoch
            || plan.revision.content_seq != revision.content_seq
        {
            return Err(ReadError::new(
                ReadErrorKind::Conflict,
                "清理计划或引用已变化",
            ));
        }
        let current = candidates(&root, plan.keep, plan.days)?;
        if current.iter().map(|c| &c.file).collect::<Vec<_>>()
            != plan.candidates.iter().map(|c| &c.file).collect::<Vec<_>>()
        {
            return Err(ReadError::new(
                ReadErrorKind::Conflict,
                "快照集合或文件已改变",
            ));
        }
        for candidate in &plan.candidates {
            if !candidate
                .identity
                .matches(&local_path(&root, &candidate.file.path)?)?
            {
                return Err(ReadError::new(ReadErrorKind::Conflict, "快照身份已改变"));
            }
        }
        let quarantine = local_path(&root, &format!("_local/cleanup-quarantine/{plan_id}"))?;
        fs::create_dir_all(quarantine.parent().unwrap())?;
        fs::create_dir(&quarantine)?;
        let journal = Journal {
            format: "anynote.cleanup.v1".into(),
            notebook_id: id.into(),
            plan_id: plan_id.into(),
            files: plan.preview.files.clone(),
        };
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(quarantine.join("journal.json"))?;
        file.write_all(&serde_json::to_vec(&journal)?)?;
        file.sync_all()?;
        drop(file);
        sync_directory(&quarantine)?;
        sync_directory(quarantine.parent().unwrap())?;
        let result = (|| {
            for candidate in &plan.candidates {
                let source = local_path(&root, &candidate.file.path)?;
                require(candidate.identity.matches(&source)?, "执行时快照改变")?;
                let target = local_path(&quarantine, &candidate.file.path)?;
                fs::create_dir_all(target.parent().unwrap())?;
                fs::rename(source, &target)?;
                sync_directory(target.parent().unwrap())?;
                checkpoint()?;
            }
            sync_directory(&root.join("snapshots"))?;
            sync_directory(&quarantine)?;
            Ok(CleanupResult {
                quarantined: plan.preview.files.len(),
                bytes: plan.preview.bytes,
                recovery_id: plan_id.into(),
            })
        })();
        self.cleanup_plans.remove(plan_id);
        if result.is_err() {
            let _ = recover_cleanup(&root, id, plan_id);
        }
        result
    }
}
/// Readable even if the source database is corrupt; refuses to overwrite a newer snapshot.
pub fn recover_cleanup(root: &Path, id: &str, plan_id: &str) -> ReadResult<usize> {
    uuid(id)?;
    uuid(plan_id)?;
    let quarantine = local_path(root, &format!("_local/cleanup-quarantine/{plan_id}"))?;
    let journal_path = local_path(&quarantine, "journal.json")?;
    require(
        fs::metadata(&journal_path)?.len() <= 16 * 1024 * 1024,
        "清理回执超限",
    )?;
    let journal: Journal = serde_json::from_slice(&fs::read(journal_path)?)?;
    require(
        journal.format == "anynote.cleanup.v1"
            && journal.notebook_id == id
            && journal.plan_id == plan_id
            && journal.files.len() <= 100000,
        "清理回执身份无效",
    )?;
    for file in &journal.files {
        require(
            file.path
                .strip_prefix("snapshots/")
                .and_then(snapshot_time)
                .is_some(),
            "清理回执路径无效",
        )?;
        assets::check_hash(&file.sha256)?;
    }
    let mut restored = 0;
    for file in &journal.files {
        let source = local_path(&quarantine, &file.path)?;
        if !source.exists() {
            continue;
        }
        require(
            fs::metadata(&source)?.is_file()
                && fs::metadata(&source)?.len() == file.size
                && digest(&source)? == file.sha256,
            "隔离文件损坏，保留证据",
        )?;
        let destination = local_path(root, &file.path)?;
        if destination.exists() {
            return Err(ReadError::new(
                ReadErrorKind::Conflict,
                "恢复目标已存在，保留隔离副本",
            ));
        }
        fs::create_dir_all(destination.parent().unwrap())?;
        fs::hard_link(&source, &destination)?;
        sync_directory(destination.parent().unwrap())?;
        fs::remove_file(source)?;
        restored += 1;
    }
    Ok(restored)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupPurgeResult {
    pub removed: usize,
    pub reclaimed_bytes: u64,
    pub pending: Vec<CleanupFile>,
    pub error: Option<String>,
}
/// Reclaims quarantined bytes after the host commits the reviewed cleanup.
/// A partial filesystem failure retains the journal and remaining files for retry/recovery.
pub fn purge_cleanup(
    root: &Path,
    id: &str,
    plan_id: &str,
    confirmed: bool,
) -> ReadResult<CleanupPurgeResult> {
    input(confirmed, "永久清理需要确认")?;
    uuid(id)?;
    uuid(plan_id)?;
    let quarantine = local_path(root, &format!("_local/cleanup-quarantine/{plan_id}"))?;
    let journal_path = local_path(&quarantine, "journal.json")?;
    require(
        fs::metadata(&journal_path)?.len() <= 16 * 1024 * 1024,
        "清理回执超限",
    )?;
    let journal: Journal = serde_json::from_slice(&fs::read(journal_path)?)?;
    require(
        journal.format == "anynote.cleanup.v1"
            && journal.notebook_id == id
            && journal.plan_id == plan_id
            && journal.files.len() <= 100000,
        "清理回执身份无效",
    )?;
    let mut pending = Vec::new();
    for file in journal.files {
        require(
            file.path
                .strip_prefix("snapshots/")
                .and_then(snapshot_time)
                .is_some(),
            "清理回执路径无效",
        )?;
        assets::check_hash(&file.sha256)?;
        let source = local_path(&quarantine, &file.path)?;
        if !source.exists() {
            continue;
        }
        require(
            fs::metadata(&source)?.is_file()
                && fs::metadata(&source)?.len() == file.size
                && digest(&source)? == file.sha256,
            "隔离文件改变，保留证据",
        )?;
        pending.push(file);
    }
    let mut result = CleanupPurgeResult {
        removed: 0,
        reclaimed_bytes: 0,
        pending: Vec::new(),
        error: None,
    };
    for (i, file) in pending.iter().enumerate() {
        let remove = (|| -> ReadResult<()> {
            let path = local_path(&quarantine, &file.path)?;
            fs::remove_file(&path)?;
            sync_directory(path.parent().unwrap())?;
            Ok(())
        })();
        if let Err(error) = remove {
            result.pending = pending[i..].to_vec();
            result.error = Some(error.to_string());
            break;
        }
        result.removed += 1;
        result.reclaimed_bytes += file.size;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expired_plan_and_failure_after_move_preserve_snapshots() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm08");
        fs::create_dir_all(&root).unwrap();
        let dir = tempfile::tempdir_in(root.canonicalize().unwrap()).unwrap();
        let q = WriteQueue::open(dir.path(), 1).unwrap();
        let id = q
            .submit(|s| Ok(s.create_notebook("cleanup")?.id))
            .unwrap()
            .wait()
            .unwrap();
        let root = dir.path().join(&id);
        fs::create_dir(root.join("snapshots")).unwrap();
        for i in 1..=3 {
            fs::write(
                root.join(format!("snapshots/{i}.anynote")),
                format!("archive{i}"),
            )
            .unwrap();
        }
        q.submit(move |s| {
            let plan = s.preview_cleanup(&id, 1, 0)?;
            s.cleanup_plans.get_mut(&plan.id).unwrap().created =
                Instant::now() - Duration::from_secs(301);
            assert_eq!(
                s.apply_cleanup(&id, &plan.id, true).unwrap_err().kind(),
                ReadErrorKind::Conflict
            );
            let plan = s.preview_cleanup(&id, 1, 0)?;
            let result = s.apply_cleanup_checked(&id, &plan.id, true, || {
                Err(ReadError::new(
                    ReadErrorKind::Offline,
                    "injected I/O failure after rename",
                ))
            });
            assert!(result.is_err());
            assert!(root.join("snapshots/1.anynote").exists());
            assert!(root.join("snapshots/2.anynote").exists());
            assert!(
                root.join(format!(
                    "_local/cleanup-quarantine/{}/journal.json",
                    plan.id
                ))
                .exists()
            );
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    }
}
