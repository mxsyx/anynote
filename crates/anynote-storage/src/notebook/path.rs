use super::*;
use std::{
    fs::{self, File},
    path::{Component, Path, PathBuf},
    time::SystemTime,
};

pub(crate) fn local_path(root: &Path, relative: &str) -> ReadResult<PathBuf> {
    if !root.is_absolute()
        || root.components().any(|p| matches!(p, Component::ParentDir))
        || relative.contains('\\')
        || Path::new(relative)
            .components()
            .any(|p| !matches!(p, Component::Normal(_)))
    {
        return Err(ReadError::new(
            ReadErrorKind::UnsafePath,
            "Notebook 包含不安全路径",
        ));
    }
    if dunce::canonicalize(root)? != dunce::simplified(root) {
        return Err(ReadError::new(
            ReadErrorKind::UnsafePath,
            "Notebook 目录路径已改变或包含符号链接",
        ));
    }
    let mut path = root.to_path_buf();
    for part in Path::new(relative).components() {
        path.push(part);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(ReadError::new(
                    ReadErrorKind::UnsafePath,
                    "Notebook 内不允许符号链接",
                ));
            }
            Ok(_) => {
                if dunce::canonicalize(&path)? != dunce::simplified(&path) {
                    return Err(ReadError::new(
                        ReadErrorKind::UnsafePath,
                        "Notebook 路径重定向",
                    ));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(path)
}

pub(crate) struct FileIdentity {
    #[cfg(not(unix))]
    handle: same_file::Handle,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    length: u64,
    modified: Option<SystemTime>,
}
impl FileIdentity {
    pub fn from_file(file: &File) -> ReadResult<Self> {
        let meta = file.metadata()?;
        #[cfg(unix)]
        {
            Self::from_metadata(meta)
        }
        #[cfg(not(unix))]
        {
            require(meta.is_file(), "不是普通文件")?;
            Ok(Self {
                handle: same_file::Handle::from_file(file.try_clone()?)?,
                length: meta.len(),
                modified: meta.modified().ok(),
            })
        }
    }
    #[cfg(unix)]
    fn from_metadata(meta: fs::Metadata) -> ReadResult<Self> {
        use std::os::unix::fs::MetadataExt;
        require(meta.is_file(), "不是普通文件")?;
        Ok(Self {
            device: meta.dev(),
            inode: meta.ino(),
            length: meta.len(),
            modified: meta.modified().ok(),
        })
    }
    pub fn open(path: &Path) -> ReadResult<Self> {
        // POSIX closes release *all* process locks on that inode. Identity checks
        // must not open/close extra descriptors beside SQLite's writer handle.
        #[cfg(unix)]
        {
            Self::from_metadata(fs::metadata(path)?)
        }
        #[cfg(not(unix))]
        {
            Self::from_file(&File::open(path)?)
        }
    }
    fn same_identity(&self, other: &Self) -> bool {
        #[cfg(unix)]
        {
            self.device == other.device && self.inode == other.inode
        }
        #[cfg(not(unix))]
        {
            self.handle == other.handle
        }
    }
    pub fn same_file(&self, path: &Path) -> ReadResult<bool> {
        Ok(self.same_identity(&Self::open(path)?))
    }
    pub fn matches(&self, path: &Path) -> ReadResult<bool> {
        let current = Self::open(path)?;
        Ok(self.same_identity(&current)
            && self.length == current.length
            && self.modified == current.modified)
    }
    pub fn matches_file(&self, file: &File) -> ReadResult<bool> {
        let current = Self::from_file(file)?;
        Ok(self.same_identity(&current)
            && self.length == current.length
            && self.modified == current.modified)
    }
}
