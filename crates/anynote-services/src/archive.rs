//! Streaming archive services. Invoke on a worker, never the GPUI event thread.
use anynote_storage::notebook::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};

pub type ArchiveResult<T> = Result<T, ArchiveError>;
#[derive(Debug)]
pub enum ArchiveError {
    Storage(ReadError),
    Io(std::io::Error),
    Json(serde_json::Error),
    Zip(zip::result::ZipError),
    Invalid(String),
}
impl std::fmt::Display for ArchiveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Storage(e) => e.fmt(f),
            Self::Io(e) => e.fmt(f),
            Self::Json(e) => e.fmt(f),
            Self::Zip(e) => e.fmt(f),
            Self::Invalid(e) => f.write_str(e),
        }
    }
}
impl std::error::Error for ArchiveError {}
macro_rules! from_error {
    ($t:ty,$v:ident) => {
        impl From<$t> for ArchiveError {
            fn from(e: $t) -> Self {
                Self::$v(e)
            }
        }
    };
}
from_error!(ReadError, Storage);
from_error!(std::io::Error, Io);
from_error!(serde_json::Error, Json);
from_error!(zip::result::ZipError, Zip);
pub(crate) fn ensure(ok: bool, message: &str) -> ArchiveResult<()> {
    if ok {
        Ok(())
    } else {
        Err(ArchiveError::Invalid(message.into()))
    }
}
pub const MAX_ENTRIES: usize = 100002;
pub const MANIFEST_BYTES: u64 = 16 * 1024 * 1024;
const CONTAINER_BYTES: u64 =
    SNAPSHOT_BYTES + SNAPSHOT_BYTES / 100 + MANIFEST_BYTES + MAX_ENTRIES as u64 * 512 + 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveManifest {
    pub format: String,
    pub format_version: u32,
    pub schema_version: u32,
    pub notebook_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub includes_history: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub includes_trash: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub includes_extension_state: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_extensions: Option<ContentRequirements>,
    pub database: ArchiveEntry,
    pub assets: Vec<ArchiveEntry>,
}
impl ArchiveManifest {
    fn validate(&self) -> ArchiveResult<()> {
        ensure(
            self.format == "anynote.notebook"
                && self.format_version == 1
                && self.schema_version == 5,
            "不支持的归档版本",
        )?;
        ensure(
            uuid::Uuid::parse_str(&self.notebook_id).is_ok() && self.notebook_id.len() == 36,
            "归档身份无效",
        )?;
        ensure(
            self.database.path == "notebook.sqlite" && self.assets.len() <= 100000,
            "归档数据库路径或附件数量无效",
        )?;
        let mut seen = BTreeSet::new();
        let mut total = 0u64;
        for e in std::iter::once(&self.database).chain(&self.assets) {
            asset_relative_path(&e.sha256)?;
            ensure(seen.insert(&e.path), "重复清单项")?;
            total = total
                .checked_add(e.size)
                .ok_or_else(|| ArchiveError::Invalid("归档超限".into()))?;
            ensure(total <= SNAPSHOT_BYTES, "归档超过 20GiB")?;
        }
        for a in &self.assets {
            ensure(
                a.path == asset_relative_path(&a.sha256)?,
                "附件路径与 hash 不符",
            )?;
        }
        if let Some(r) = &self.required_extensions {
            ensure(
                r.data
                    .iter()
                    .all(|d| d.schema_version > 0 && d.schema_version <= 9_007_199_254_740_991),
                "内容版本无效",
            )?;
        }
        Ok(())
    }
}

pub(crate) fn copy_hash(
    input: &mut impl Read,
    output: &mut impl Write,
    max: u64,
    cancel: &Cancellation,
) -> ArchiveResult<(u64, String)> {
    let mut total = 0u64;
    let mut digest = Sha256::new();
    let mut buffer = vec![0; 64 * 1024];
    loop {
        cancel.check()?;
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        ensure(total <= max, "文件超过声明大小或预算")?;
        digest.update(&buffer[..n]);
        output.write_all(&buffer[..n])?;
    }
    Ok((total, format!("{:x}", digest.finalize())))
}
pub(crate) fn describe(
    root: &Path,
    relative: &str,
    cancel: &Cancellation,
) -> ArchiveResult<ArchiveEntry> {
    let file = checked_local_path(root, relative)?;
    ensure(fs::metadata(&file)?.is_file(), "不是普通文件")?;
    let (size, sha256) = copy_hash(
        &mut File::open(file)?,
        &mut std::io::sink(),
        SNAPSHOT_BYTES,
        cancel,
    )?;
    Ok(ArchiveEntry {
        path: relative.into(),
        size,
        sha256,
        mime_type: None,
    })
}
pub(crate) fn destination(path: &Path) -> ArchiveResult<PathBuf> {
    let parent = path
        .parent()
        .ok_or_else(|| ArchiveError::Invalid("缺少目标目录".into()))?;
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| ArchiveError::Invalid("目标文件名无效".into()))?;
    Ok(checked_local_path(parent, name)?)
}

/// No overwrite: publish only after all bytes, hashes and cancellation checks succeed.
pub(crate) fn write_zip(
    root: &Path,
    output: &Path,
    entries: &[ArchiveEntry],
    manifest: Option<&ArchiveManifest>,
    force_zip64: bool,
    cancel: &Cancellation,
) -> ArchiveResult<u64> {
    let target = destination(output)?;
    ensure(!target.exists(), "导出目标已存在")?;
    let mut staging = tempfile::Builder::new()
        .prefix("anynote.archive.")
        .suffix(".partial")
        .tempfile_in(target.parent().unwrap())?;
    let metadata = manifest.map(serde_json::to_vec).transpose()?;
    ensure(
        metadata
            .as_ref()
            .is_none_or(|m| m.len() as u64 <= MANIFEST_BYTES),
        "清单超过 16MiB",
    )?;
    ensure(
        entries.len() + usize::from(metadata.is_some()) <= MAX_ENTRIES,
        "导出条目超限",
    )?;
    let mut total = metadata.as_ref().map_or(0, |m| m.len() as u64);
    let mut names = BTreeSet::new();
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .large_file(force_zip64)
        .unix_permissions(0o600);
    {
        let mut zip = ZipWriter::new(staging.as_file_mut());
        if let Some(metadata) = metadata {
            zip.start_file("manifest.json", options)?;
            zip.write_all(&metadata)?;
            names.insert("manifest.json".to_owned());
        }
        for e in entries {
            cancel.check()?;
            ensure(names.insert(e.path.to_lowercase()), "重复导出路径")?;
            total = total
                .checked_add(e.size)
                .ok_or_else(|| ArchiveError::Invalid("导出超限".into()))?;
            ensure(total <= SNAPSHOT_BYTES, "导出超过 20GiB")?;
            let source = checked_local_path(root, &e.path)?;
            if source.is_dir() {
                ensure(e.size == 0 && e.sha256.is_empty(), "目录声明无效")?;
                zip.add_directory(&e.path, options)?;
                continue;
            }
            let mut input = File::open(source)?;
            ensure(input.metadata()?.is_file(), "导出条目不是普通文件")?;
            zip.start_file(
                &e.path,
                options.large_file(force_zip64 || e.size >= u32::MAX as u64),
            )?;
            let (size, hash) = copy_hash(&mut input, &mut zip, e.size, cancel)?;
            ensure(size == e.size && hash == e.sha256, "导出文件在读取时改变")?;
        }
        zip.finish()?;
    }
    staging.as_file().sync_all()?;
    cancel.check()?;
    destination(output)?;
    let file = staging
        .persist_noclobber(&target)
        .map_err(|e| ArchiveError::Io(e.error))?;
    let size = file.metadata()?.len();
    sync_directory(target.parent().unwrap())?;
    Ok(size)
}

pub fn export_archive(
    snapshot: &mut FrozenSnapshot,
    mode: SnapshotMode,
    output: &Path,
    force_zip64: bool,
    cancel: &Cancellation,
) -> ArchiveResult<ArchiveManifest> {
    if snapshot.mode().is_none() {
        snapshot.prepare(mode, cancel)?;
    }
    ensure(snapshot.mode() == Some(mode), "快照模式不匹配")?;
    export_directory(
        snapshot.path(),
        snapshot.notebook_id(),
        mode != SnapshotMode::Current,
        output,
        force_zip64,
        cancel,
    )
}

/// The migration owner holds the original leases and supplies a verified,
/// independent full copy. No hard links or source database descriptors are opened.
pub(crate) fn export_preserved_directory(
    source: &Path,
    notebook_id: &str,
    output: &Path,
    cancel: &Cancellation,
) -> ArchiveResult<ArchiveManifest> {
    export_directory(source, notebook_id, true, output, false, cancel)
}

fn export_directory(
    source: &Path,
    notebook_id: &str,
    full: bool,
    output: &Path,
    force_zip64: bool,
    cancel: &Cancellation,
) -> ArchiveResult<ArchiveManifest> {
    let book = ReadonlyNotebook::open(source, Some(notebook_id))?;
    let database = describe(source, "notebook.sqlite", cancel)?;
    let assets = book
        .assets()?
        .into_iter()
        .map(|a| {
            Ok(ArchiveEntry {
                path: asset_relative_path(&a.hash)?,
                size: a.size,
                sha256: a.hash,
                mime_type: Some(a.mime),
            })
        })
        .collect::<ArchiveResult<Vec<_>>>()?;
    let manifest = ArchiveManifest {
        format: "anynote.notebook".into(),
        format_version: 1,
        schema_version: 5,
        notebook_id: notebook_id.into(),
        includes_history: Some(full),
        includes_trash: Some(full),
        includes_extension_state: Some(full),
        required_extensions: Some(book.content_requirements()?),
        database,
        assets,
    };
    manifest.validate()?;
    drop(book);
    let entries = std::iter::once(manifest.database.clone())
        .chain(manifest.assets.clone())
        .collect::<Vec<_>>();
    write_zip(
        source,
        output,
        &entries,
        Some(&manifest),
        force_zip64,
        cancel,
    )?;
    Ok(manifest)
}

// Preflight the central directory before ZipArchive allocates its name map (which deduplicates entries).
fn preflight(file: &mut File, cancel: &Cancellation) -> ArchiveResult<usize> {
    preflight_zip(file, CONTAINER_BYTES, MAX_ENTRIES, valid_entry, || {
        cancel.check().map_err(Into::into)
    })
}

pub(crate) fn preflight_zip(
    file: &mut File,
    max_bytes: u64,
    max_entries: usize,
    valid_entry: impl Fn(&str) -> bool,
    check_cancel: impl Fn() -> ArchiveResult<()>,
) -> ArchiveResult<usize> {
    let length = file.metadata()?.len();
    ensure((22..=max_bytes).contains(&length), "归档容器大小无效")?;
    let tail_len = length.min(65557) as usize;
    file.seek(SeekFrom::End(-(tail_len as i64)))?;
    let mut tail = vec![0; tail_len];
    file.read_exact(&mut tail)?;
    let end = (0..=tail_len - 22)
        .rev()
        .find(|&i| {
            tail[i..i + 4] == [0x50, 0x4b, 5, 6]
                && i + 22 + u16_at(&tail, i + 20) as usize == tail_len
        })
        .ok_or_else(|| ArchiveError::Invalid("ZIP 缺少结束记录".into()))?;
    ensure(
        u16_at(&tail, end + 4) == 0 && u16_at(&tail, end + 6) == 0,
        "不支持分卷 ZIP",
    )?;
    let mut count = u16_at(&tail, end + 10) as u64;
    ensure(u16_at(&tail, end + 8) as u64 == count, "ZIP 条目计数不符")?;
    let mut central_size = u32_at(&tail, end + 12) as u64;
    let mut offset = u32_at(&tail, end + 16) as u64;
    let end_offset = length - tail_len as u64 + end as u64;
    let mut central_end = end_offset;
    if end >= 20 && tail[end - 20..end - 16] == [0x50, 0x4b, 6, 7] {
        ensure(
            u32_at(&tail, end - 16) == 0 && u32_at(&tail, end - 4) == 1,
            "不支持分卷 ZIP64",
        )?;
        let at = u64_at(&tail, end - 12);
        ensure(
            at.checked_add(56).is_some_and(|n| n <= end_offset - 20),
            "ZIP64 记录越界",
        )?;
        file.seek(SeekFrom::Start(at))?;
        let mut record = [0u8; 56];
        file.read_exact(&mut record)?;
        ensure(
            record[..4] == [0x50, 0x4b, 6, 6]
                && u64_at(&record, 4) >= 44
                && u32_at(&record, 16) == 0
                && u32_at(&record, 20) == 0,
            "ZIP64 记录无效",
        )?;
        count = u64_at(&record, 32);
        ensure(u64_at(&record, 24) == count, "ZIP64 计数不符")?;
        central_size = u64_at(&record, 40);
        offset = u64_at(&record, 48);
        central_end = at;
    }
    ensure(
        (2..=max_entries as u64).contains(&count)
            && offset.checked_add(central_size) == Some(central_end),
        "ZIP 中央目录越界或数量超限",
    )?;
    file.seek(SeekFrom::Start(offset))?;
    let mut names = BTreeSet::new();
    for _ in 0..count {
        check_cancel()?;
        let mut header = [0u8; 46];
        file.read_exact(&mut header)?;
        ensure(header[..4] == [0x50, 0x4b, 1, 2], "ZIP 中央目录损坏")?;
        let name_len = u16_at(&header, 28) as usize;
        ensure((1..=120).contains(&name_len), "归档路径无效")?;
        let mut name = vec![0; name_len];
        file.read_exact(&mut name)?;
        let name =
            std::str::from_utf8(&name).map_err(|_| ArchiveError::Invalid("路径编码无效".into()))?;
        ensure(
            valid_entry(name) && names.insert(name.to_owned()),
            "归档路径不安全或重复",
        )?;
        ensure(
            u16_at(&header, 8) & 1 == 0
                && matches!(u16_at(&header, 10), 0 | 8)
                && u16_at(&header, 34) == 0,
            "不支持加密、分卷或压缩方法",
        )?;
        let mode = u32_at(&header, 38) >> 16 & 0o170000;
        ensure(mode == 0 || mode == 0o100000, "归档含链接或特殊文件")?;
        let skip = u16_at(&header, 30) as u64 + u16_at(&header, 32) as u64;
        let next = file
            .stream_position()?
            .checked_add(skip)
            .ok_or_else(|| ArchiveError::Invalid("目录越界".into()))?;
        ensure(next <= central_end, "ZIP 目录越界")?;
        file.seek(SeekFrom::Start(next))?;
    }
    ensure(file.stream_position()? == central_end, "ZIP 目录大小不符")?;
    file.rewind()?;
    Ok(count as usize)
}
fn u16_at(b: &[u8], i: usize) -> u16 {
    u16::from_le_bytes(b[i..i + 2].try_into().unwrap())
}
fn u32_at(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes(b[i..i + 4].try_into().unwrap())
}
fn u64_at(b: &[u8], i: usize) -> u64 {
    u64::from_le_bytes(b[i..i + 8].try_into().unwrap())
}
fn valid_entry(name: &str) -> bool {
    if matches!(name, "manifest.json" | "notebook.sqlite") {
        return true;
    }
    let Some(hash) = name
        .strip_prefix("assets/sha256/")
        .and_then(|s| s.get(3..))
        .and_then(|s| s.strip_suffix(".bin"))
    else {
        return false;
    };
    asset_relative_path(hash).is_ok_and(|s| s == name)
}

pub struct ValidatedArchive {
    directory: tempfile::TempDir,
    pub manifest: ArchiveManifest,
}
impl ValidatedArchive {
    pub fn path(&self) -> &Path {
        self.directory.path()
    }
}
pub fn validate_archive(
    input: &Path,
    staging_parent: &Path,
    cancel: &Cancellation,
) -> ArchiveResult<ValidatedArchive> {
    cancel.check()?;
    let source = destination(input)?;
    let mut file = File::open(&source)?;
    ensure(file.metadata()?.is_file(), "归档不是普通文件")?;
    let count = preflight(&mut file, cancel)?;
    let mut archive = ZipArchive::new(file)?;
    ensure(archive.len() == count, "ZIP 含重复条目")?;
    let mut sizes = BTreeMap::new();
    let mut total = 0u64;
    let mut ranges = Vec::new();
    let central = archive.central_directory_start();
    for i in 0..archive.len() {
        cancel.check()?;
        let e = archive.by_index(i)?;
        ensure(
            !e.encrypted()
                && valid_entry(e.name())
                && matches!(
                    e.compression(),
                    CompressionMethod::Stored | CompressionMethod::Deflated
                ),
            "ZIP 条目无效",
        )?;
        total = total
            .checked_add(e.size())
            .ok_or_else(|| ArchiveError::Invalid("解压超限".into()))?;
        ensure(
            total <= SNAPSHOT_BYTES && (e.name() != "manifest.json" || e.size() <= MANIFEST_BYTES),
            "解压预算超限",
        )?;
        let end = e
            .data_start()
            .checked_add(e.compressed_size())
            .ok_or_else(|| ArchiveError::Invalid("ZIP 越界".into()))?;
        ensure(
            end <= central && e.header_start() < e.data_start(),
            "ZIP 数据越界",
        )?;
        ranges.push((e.header_start(), end));
        sizes.insert(e.name().to_owned(), e.size());
    }
    ranges.sort_unstable();
    ensure(ranges.windows(2).all(|w| w[0].1 <= w[1].0), "ZIP 数据重叠")?;
    let mut bytes = Vec::new();
    copy_hash(
        &mut archive.by_name("manifest.json")?,
        &mut bytes,
        MANIFEST_BYTES,
        cancel,
    )?;
    let manifest: ArchiveManifest = serde_json::from_slice(&bytes)?;
    manifest.validate()?;
    ensure(
        sizes.len() == manifest.assets.len() + 2,
        "归档存在未声明条目",
    )?;
    checked_local_path(staging_parent, "probe")?;
    let directory = tempfile::Builder::new()
        .prefix("anynote.import.")
        .tempdir_in(staging_parent)?;
    for e in std::iter::once(&manifest.database).chain(&manifest.assets) {
        ensure(sizes.get(&e.path) == Some(&e.size), "归档声明大小不符")?;
        let target = directory.path().join(&e.path);
        fs::create_dir_all(target.parent().unwrap())?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)?;
        let (size, hash) = copy_hash(&mut archive.by_name(&e.path)?, &mut output, e.size, cancel)?;
        ensure(
            size == e.size && hash == e.sha256,
            "归档 SHA-256 或大小错误",
        )?;
        output.sync_all()?;
    }
    let book = ReadonlyNotebook::open(directory.path(), Some(&manifest.notebook_id))?;
    let assets = book.assets()?;
    ensure(
        assets.len() == manifest.assets.len(),
        "数据库附件与清单不符",
    )?;
    let declared_assets = manifest
        .assets
        .iter()
        .map(|e| (e.sha256.as_str(), e))
        .collect::<BTreeMap<_, _>>();
    for a in assets {
        ensure(
            declared_assets.get(a.hash.as_str()).is_some_and(|e| {
                e.size == a.size && e.mime_type.as_ref().is_none_or(|m| m == &a.mime)
            }),
            "数据库附件与清单不符",
        )?;
    }
    if let Some(declared) = &manifest.required_extensions {
        let actual = book.content_requirements()?;
        ensure(
            declared.blocks.iter().collect::<BTreeSet<_>>() == actual.blocks.iter().collect()
                && declared.data.iter().collect::<BTreeSet<_>>() == actual.data.iter().collect(),
            "requiredExtensions 与内容不符",
        )?;
    }
    if manifest.includes_history == Some(false)
        || manifest.includes_trash == Some(false)
        || manifest.includes_extension_state == Some(false)
    {
        book.assert_current_content()?;
    }
    drop(book);
    cancel.check()?;
    Ok(ValidatedArchive {
        directory,
        manifest,
    })
}

/// Restores into a new UUID directory, retaining the original archive and source notebook.
pub fn import_archive(
    input: &Path,
    root: &Path,
    cancel: &Cancellation,
) -> ArchiveResult<NotebookMeta> {
    let staged = validate_archive(input, root, cancel)?;
    let meta = remap_imported_notebook(staged.path(), &staged.manifest.notebook_id)?;
    drop(ReadonlyNotebook::open(staged.path(), Some(&meta.id))?);
    let target = checked_local_path(root, &meta.id)?;
    ensure(!target.exists(), "目标库已存在")?;
    cancel.check()?;
    sync_tree(staged.path())?;
    fs::rename(staged.path(), &target)?;
    sync_directory(root)?;
    Ok(meta)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub name: String,
    pub created_at: u64,
    pub size: u64,
}
fn snapshot_name(name: &str) -> ArchiveResult<u64> {
    let value = name
        .strip_suffix(".anynote")
        .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|s| s.parse::<u64>().ok());
    let value = value.ok_or_else(|| ArchiveError::Invalid("快照名称无效".into()))?;
    ensure(value <= 9_007_199_254_740_991, "快照时间无效")?;
    Ok(value)
}
pub fn list_snapshots(notebook_root: &Path) -> ArchiveResult<Vec<SnapshotInfo>> {
    let directory = checked_local_path(notebook_root, "snapshots")?;
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut snapshots = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Ok(created_at) = snapshot_name(&name) {
            let path = checked_local_path(notebook_root, &format!("snapshots/{name}"))?;
            let meta = fs::metadata(path)?;
            ensure(meta.is_file(), "快照不是普通文件")?;
            snapshots.push(SnapshotInfo {
                name,
                created_at,
                size: meta.len(),
            });
        }
    }
    snapshots.sort_by_key(|a| std::cmp::Reverse(a.created_at));
    Ok(snapshots)
}
pub fn snapshot(
    queue: &WriteQueue,
    id: &str,
    temporary_root: &Path,
    cancel: &Cancellation,
) -> ArchiveResult<SnapshotInfo> {
    let id = id.to_owned();
    let tmp = temporary_root.to_owned();
    let token = cancel.clone();
    let (mut cut, root) = queue
        .submit(move |catalog| {
            let root = catalog.notebook_path(&id)?;
            Ok((catalog.capture_snapshot(&id, &tmp, &token)?, root))
        })?
        .wait()?;
    let directory = checked_local_path(&root, "snapshots")?;
    fs::create_dir_all(&directory)?;
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| ArchiveError::Invalid("系统时间无效".into()))?
        .as_millis();
    let name = format!("{time}.anynote");
    let output = checked_local_path(&root, &format!("snapshots/{name}"))?;
    export_archive(&mut cut, SnapshotMode::Full, &output, false, cancel)?;
    Ok(SnapshotInfo {
        name,
        created_at: time as u64,
        size: fs::metadata(output)?.len(),
    })
}
pub fn restore_snapshot(
    notebook_root: &Path,
    name: &str,
    destination_root: &Path,
    cancel: &Cancellation,
) -> ArchiveResult<NotebookMeta> {
    snapshot_name(name)?;
    import_archive(
        &checked_local_path(notebook_root, &format!("snapshots/{name}"))?,
        destination_root,
        cancel,
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityReport {
    pub format: String,
    pub notebook_id: String,
    pub revision: BackupRevision,
    pub ok: bool,
    pub issue: Option<String>,
    pub files: Vec<ArchiveEntry>,
}
/// Preserve the unpruned database cut and all captured assets, including failure evidence.
/// This is notebook evidence, not a full workspace/configuration migration backup.
pub fn inspect_snapshot(
    snapshot: &FrozenSnapshot,
    output: &Path,
    cancel: &Cancellation,
) -> ArchiveResult<IntegrityReport> {
    ensure(
        snapshot.preserves_unpruned_evidence(),
        "不能将裁剪快照作为恢复保全证据",
    )?;
    let target = destination(output)?;
    ensure(!target.exists(), "保全目标已存在")?;
    let directory = tempfile::Builder::new()
        .prefix("anynote.evidence.")
        .tempdir_in(target.parent().unwrap())?;
    let issue = ReadonlyNotebook::open(snapshot.path(), Some(snapshot.notebook_id()))
        .and_then(|b| b.integrity_check())
        .err()
        .map(|e| e.to_string());
    let mut files = Vec::new();
    let mut pending = vec![PathBuf::new()];
    let mut bytes = 0u64;
    while let Some(relative) = pending.pop() {
        for entry in fs::read_dir(snapshot.path().join(&relative))? {
            cancel.check()?;
            let entry = entry?;
            let relative = relative.join(entry.file_name());
            let name = relative
                .to_str()
                .ok_or_else(|| ArchiveError::Invalid("证据路径编码无效".into()))?
                .replace('\\', "/");
            let source = checked_local_path(snapshot.path(), &name)?;
            if entry.file_type()?.is_dir() {
                pending.push(relative);
                continue;
            }
            ensure(entry.file_type()?.is_file(), "证据包含特殊文件")?;
            let item = describe(snapshot.path(), &name, cancel)?;
            bytes += item.size;
            ensure(
                bytes <= SNAPSHOT_BYTES && files.len() < MAX_ENTRIES,
                "证据超过预算",
            )?;
            let target = directory.path().join(&name);
            fs::create_dir_all(target.parent().unwrap())?;
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target)?;
            let (size, hash) = copy_hash(&mut File::open(source)?, &mut output, item.size, cancel)?;
            ensure(size == item.size && hash == item.sha256, "证据在保全时改变")?;
            output.sync_all()?;
            files.push(item);
        }
    }
    let report = IntegrityReport {
        format: "anynote.integrity.v1".into(),
        notebook_id: snapshot.notebook_id().into(),
        revision: snapshot.revision().clone(),
        ok: issue.is_none(),
        issue,
        files,
    };
    let mut file = File::create(directory.path().join("integrity-report.json"))?;
    file.write_all(&serde_json::to_vec_pretty(&report)?)?;
    file.sync_all()?;
    drop(file);
    cancel.check()?;
    destination(output)?;
    ensure(!target.exists(), "保全目标在处理期间出现")?;
    sync_tree(directory.path())?;
    fs::rename(directory.path(), &target)?;
    sync_directory(target.parent().unwrap())?;
    Ok(report)
}

pub(crate) fn sync_tree(root: &Path) -> ArchiveResult<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            sync_tree(&entry.path())?;
        }
    }
    sync_directory(root)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn streaming_hash_failure_cleans_partial_and_cancellation_interrupts_chunks() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm08");
        fs::create_dir_all(&root).unwrap();
        let dir = tempfile::tempdir_in(root.canonicalize().unwrap()).unwrap();
        fs::write(dir.path().join("payload"), vec![42u8; 256 * 1024]).unwrap();
        let cancel = Cancellation::default();
        let mut entry = describe(dir.path(), "payload", &cancel).unwrap();
        entry.sha256 = "0".repeat(64);
        let output = dir.path().join("failed.zip");
        assert!(write_zip(dir.path(), &output, &[entry], None, false, &cancel).is_err());
        assert!(!output.exists());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        struct CancelWriter(Cancellation, usize);
        impl Write for CancelWriter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.1 += bytes.len();
                self.0.cancel();
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut writer = CancelWriter(cancel.clone(), 0);
        let result = copy_hash(
            &mut File::open(dir.path().join("payload")).unwrap(),
            &mut writer,
            256 * 1024,
            &cancel,
        );
        assert!(
            matches!(result,Err(ArchiveError::Storage(e)) if e.kind()==ReadErrorKind::Cancelled)
        );
        assert_eq!(writer.1, 64 * 1024);
        struct FullDisk;
        impl Write for FullDisk {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::from(std::io::ErrorKind::StorageFull))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        assert!(
            copy_hash(
                &mut File::open(dir.path().join("payload")).unwrap(),
                &mut FullDisk,
                256 * 1024,
                &Cancellation::default()
            )
            .is_err()
        );
    }
}
