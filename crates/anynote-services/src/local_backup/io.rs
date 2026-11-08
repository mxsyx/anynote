use super::*;
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use serde::de::DeserializeOwned;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Target {
    pub id: String,
    pub path: PathBuf,
    pub volume: VolumeInfo,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RootMarker {
    format: String,
    format_version: u32,
    target_id: String,
    created_at: String,
}

pub fn initialize_target(
    selected: &Path,
    sources: &[PathBuf],
    probe: &dyn VolumeProbe,
) -> Result<Target> {
    let selected = fs::canonicalize(selected)?;
    let path = checked_local_path(&selected, "AnynoteBackup")?;
    check_overlap(&path, sources)?;
    let volume = probe.inspect(&selected)?;
    volume.require_local(0, 0)?;
    if !path.exists() {
        fs::create_dir(&path)?;
        let marker = RootMarker {
            format: "anynote.local-backup-root".into(),
            format_version: 1,
            target_id: new_id(),
            created_at: now(),
        };
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path.join("backup-root.json"))?;
        file.write_all(&serde_json::to_vec(&marker)?)?;
        file.sync_all()?;
        sync_directory(&path)?;
        sync_directory(&selected)?;
    }
    let marker: RootMarker = read_json(
        &Dir::open_ambient_dir(&path, ambient_authority())?,
        "backup-root.json",
    )?;
    require(
        marker.format == "anynote.local-backup-root" && marker.format_version == 1,
        "TARGET_ID_MISMATCH",
        "备份根标记无效",
    )?;
    valid_id(&marker.target_id)?;
    Ok(Target {
        id: marker.target_id,
        path,
        volume,
    })
}
fn check_overlap(root: &Path, sources: &[PathBuf]) -> Result<()> {
    for source in sources {
        let source = fs::canonicalize(source)?;
        require(
            !root.starts_with(&source) && !source.starts_with(root),
            "PATH_OVERLAP",
            "源与备份目录不能交叠",
        )?;
    }
    Ok(())
}
impl Target {
    pub fn status(&self, probe: &dyn VolumeProbe) -> TargetStatus {
        match self.guard(probe) {
            Ok(volume) => TargetStatus {
                status: "ready".into(),
                message: "磁盘已连接".into(),
                volume: Some(volume),
            },
            Err(e) => TargetStatus {
                status: if e.code == "TARGET_OFFLINE" {
                    "waiting-disk"
                } else {
                    "failed"
                }
                .into(),
                message: e.message,
                volume: None,
            },
        }
    }
    fn guard(&self, probe: &dyn VolumeProbe) -> Result<VolumeInfo> {
        valid_id(&self.id)?;
        if !self.path.try_exists()? {
            return Err(Error::new("TARGET_OFFLINE", "等待备份磁盘连接"));
        }
        let marker_path = checked_local_path(&self.path, "backup-root.json")?;
        if !marker_path.try_exists()? {
            return Err(Error::new("TARGET_OFFLINE", "等待备份磁盘身份标记"));
        }
        let dir = Dir::open_ambient_dir(&self.path, ambient_authority())?;
        let marker: RootMarker = read_json(&dir, "backup-root.json")?;
        require(
            marker.format == "anynote.local-backup-root"
                && marker.format_version == 1
                && marker.target_id == self.id,
            "TARGET_ID_MISMATCH",
            "备份磁盘身份改变",
        )?;
        let volume = probe.inspect(&self.path)?;
        require(
            volume.same_volume(&self.volume),
            "TARGET_ID_MISMATCH",
            "目标卷身份改变",
        )?;
        volume.require_local(0, 0)?;
        Ok(volume)
    }
}
#[derive(Debug, Serialize)]
pub struct TargetStatus {
    pub status: String,
    pub message: String,
    pub volume: Option<VolumeInfo>,
}

pub(super) struct Session<'a> {
    pub target: &'a Target,
    probe: &'a dyn VolumeProbe,
    dir: Dir,
    identity: same_file::Handle,
    _process_lock: fs::File,
    _legacy_lock: rusqlite::Connection,
}
impl<'a> Session<'a> {
    pub fn open(
        target: &'a Target,
        sources: &[PathBuf],
        probe: &'a dyn VolumeProbe,
    ) -> Result<Self> {
        target.guard(probe)?;
        check_overlap(&target.path, sources)?;
        let dir = Dir::open_ambient_dir(&target.path, ambient_authority())?;
        let identity = same_file::Handle::from_file(dir.try_clone()?.into_std_file())?;
        safe(&dir, ".backup.rust.lock")?;
        let process_lock = dir
            .open_with(
                ".backup.rust.lock",
                OpenOptions::new().create(true).write(true),
            )?
            .into_std();
        process_lock
            .try_lock()
            .map_err(|_| Error::new("TARGET_LOCKED", "另一个备份任务正在使用磁盘"))?;
        // Share the legacy SQLite lease as well, so TS and Rust cannot publish concurrently.
        for suffix in ["", "-journal", "-wal", "-shm"] {
            checked_local_path(&target.path, &format!(".backup-lock.sqlite{suffix}"))?;
        }
        let legacy_lock = rusqlite::Connection::open(target.path.join(".backup-lock.sqlite"))
            .map_err(|e| Error::new("TARGET_LOCKED", e.to_string()))?;
        legacy_lock
            .execute_batch("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;")
            .map_err(|_| Error::new("TARGET_LOCKED", "另一个备份任务正在使用磁盘"))?;
        let s = Self {
            target,
            probe,
            dir,
            identity,
            _process_lock: process_lock,
            _legacy_lock: legacy_lock,
        };
        s.guard()?;
        Ok(s)
    }
    pub fn guard(&self) -> Result<VolumeInfo> {
        let v = self.target.guard(self.probe)?;
        require(
            self.identity == same_file::Handle::from_path(&self.target.path)?,
            "TARGET_ID_MISMATCH",
            "运行期间备份路径被替换",
        )?;
        Ok(v)
    }
    pub fn book(&self, id: &str, create: bool) -> Result<BookDir<'_>> {
        valid_id(id)?;
        self.guard()?;
        let rel = format!("notebooks/{id}");
        safe(&self.dir, &rel)?;
        if create {
            create_directories(&self.dir, Path::new(&rel))?;
        }
        let dir = self.dir.open_dir(&rel)?;
        let identity = same_file::Handle::from_file(dir.try_clone()?.into_std_file())?;
        let book = BookDir {
            session: self,
            dir,
            identity,
            relative: rel,
        };
        book.guard()?;
        Ok(book)
    }
}
pub(super) struct BookDir<'a> {
    session: &'a Session<'a>,
    pub dir: Dir,
    identity: same_file::Handle,
    relative: String,
}
impl BookDir<'_> {
    pub fn guard(&self) -> Result<VolumeInfo> {
        let v = self.session.guard()?;
        safe(&self.session.dir, &self.relative)?;
        let current = self.session.dir.open_dir(&self.relative)?;
        require(
            self.identity == same_file::Handle::from_file(current.into_std_file())?,
            "TARGET_ID_MISMATCH",
            "Notebook 备份路径被替换",
        )?;
        Ok(v)
    }
    pub fn open(&self, path: &str) -> Result<fs::File> {
        self.guard()?;
        safe(&self.dir, path)?;
        let f = self.dir.open(path)?.into_std();
        require(
            f.metadata()?.is_file(),
            "NOT_REGULAR_FILE",
            "备份条目不是普通文件",
        )?;
        Ok(f)
    }
    pub fn exists(&self, path: &str) -> Result<bool> {
        self.guard()?;
        safe(&self.dir, path)?;
        match self.dir.symlink_metadata(path) {
            Ok(_) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e.into()),
        }
    }
    pub fn remove(&self, path: &str) -> Result<()> {
        self.guard()?;
        safe(&self.dir, path)?;
        match self.dir.remove_file(path) {
            Ok(()) => {
                self.sync_parent(path)?;
                Ok(())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
    pub fn sync_parent(&self, path: &str) -> Result<()> {
        #[cfg(unix)]
        self.dir
            .open(Path::new(path).parent().unwrap())?
            .sync_all()?;
        Ok(())
    }
    pub fn create(&self, path: &str) -> Result<fs::File> {
        self.guard()?;
        safe(&self.dir, path)?;
        create_directories(&self.dir, Path::new(path).parent().unwrap())?;
        let f = self
            .dir
            .open_with(path, OpenOptions::new().write(true).create_new(true))?
            .into_std();
        self.sync_parent(path)?;
        Ok(f)
    }
    pub fn replace(&self, temp: &str, path: &str) -> Result<()> {
        self.guard()?;
        safe(&self.dir, temp)?;
        safe(&self.dir, path)?;
        self.dir.rename(temp, &self.dir, path)?;
        self.sync_parent(path)?;
        Ok(())
    }
    pub fn json<T: DeserializeOwned>(&self, path: &str) -> Result<Option<T>> {
        if !self.exists(path)? {
            return Ok(None);
        }
        Ok(Some(read_json(&self.dir, path)?))
    }
    pub fn atomic_json(&self, path: &str, value: &impl Serialize) -> Result<()> {
        let temp = format!("{path}.{}.tmp", new_id());
        let result = (|| {
            let mut file = self.create(&temp)?;
            {
                let mut writer = std::io::BufWriter::with_capacity(64 * 1024, &mut file);
                write_json(value, &mut writer)?;
                writer.flush()?;
            }
            file.sync_all()?;
            drop(file);
            self.replace(&temp, path)
        })();
        // Only this invocation's temporary file is eligible for best-effort cleanup.
        if result.is_err() {
            let _ = self.remove(&temp);
        }
        result
    }
}
fn read_json<T: DeserializeOwned>(dir: &Dir, path: &str) -> Result<T> {
    safe(dir, path)?;
    let mut file = dir.open(path)?;
    require(
        file.metadata()?.is_file() && file.metadata()?.len() <= MANIFEST_BYTES,
        "MANIFEST_INVALID",
        "JSON 文件无效或超限",
    )?;
    Ok(serde_json::from_reader(std::io::BufReader::new(
        (&mut file).take(MANIFEST_BYTES + 1),
    ))?)
}
struct JsonWriter<W> {
    writer: W,
    size: u64,
}
impl<W: Write> Write for JsonWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.size + bytes.len() as u64 > MANIFEST_BYTES {
            return Err(std::io::Error::other("JSON exceeds 128 MiB"));
        }
        let n = self.writer.write(bytes)?;
        self.size += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.writer.flush()
    }
}
fn write_json(value: &impl Serialize, writer: impl Write) -> Result<u64> {
    let mut writer = JsonWriter { writer, size: 0 };
    serde_json::to_writer(&mut writer, value)?;
    Ok(writer.size)
}
pub(super) fn json_size(value: &impl Serialize) -> Result<u64> {
    write_json(value, std::io::sink())
}
fn create_directories(dir: &Dir, path: &Path) -> Result<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component);
        match dir.create_dir(&current) {
            Ok(()) => {
                #[cfg(unix)]
                dir.open(
                    current
                        .parent()
                        .filter(|p| !p.as_os_str().is_empty())
                        .unwrap_or(Path::new(".")),
                )?
                .sync_all()?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

fn safe(dir: &Dir, path: &str) -> Result<()> {
    use std::path::Component;
    require(
        !path.contains('\\') && !path.is_empty(),
        "PATH_UNSAFE",
        "不安全路径",
    )?;
    let mut current = PathBuf::new();
    for c in Path::new(path).components() {
        require(
            matches!(c, Component::Normal(_)),
            "PATH_UNSAFE",
            "不安全路径",
        )?;
        current.push(c);
        match dir.symlink_metadata(&current) {
            Ok(m) => require(
                !m.file_type().is_symlink() && dir.canonicalize(&current)? == current,
                "PATH_UNSAFE",
                "路径包含链接或重定向",
            )?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
pub(super) fn token(file: &fs::File, session: &str) -> Result<Option<String>> {
    let m = file.metadata()?;
    require(m.is_file(), "NOT_REGULAR_FILE", "不是普通文件")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(Some(format!(
            "rust:{session}:{}:{}:{}:{}:{}:{}:{}",
            m.dev(),
            m.ino(),
            m.len(),
            m.mtime(),
            m.mtime_nsec(),
            m.ctime(),
            m.ctime_nsec()
        )))
    }
    #[cfg(not(unix))]
    {
        let _ = session;
        Ok(None)
    }
}

struct HashWriter(Sha256);
impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
pub(super) fn json_fingerprint(value: &impl Serialize) -> Result<String> {
    let mut hash = HashWriter(Sha256::new());
    write_json(value, &mut hash)?;
    Ok(format!("{:x}", hash.0.finalize()))
}
