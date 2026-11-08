use super::*;
use cap_std::fs::{Dir, OpenOptions};
use std::{
    fs::File,
    path::{Component, Path, PathBuf},
};

/// Created only from the native directory chooser, never from imported HTML or UI JSON.
pub struct DirectoryGrant {
    path: PathBuf,
    identity: same_file::Handle,
    directory: Dir,
}
impl DirectoryGrant {
    pub fn authorize(path: &Path) -> ImportResult<Self> {
        let path = path.canonicalize()?;
        check(path.is_dir(), "授权路径不是目录")?;
        let identity = same_file::Handle::from_path(&path)?;
        let directory = Dir::open_ambient_dir(&path, cap_std::ambient_authority())?;
        check(
            same_file::Handle::from_file(directory.try_clone()?.into_std_file())? == identity,
            "授权目录已改变",
        )?;
        Ok(Self {
            path,
            identity,
            directory,
        })
    }
    pub fn open(&self, source: &str) -> ImportResult<File> {
        check(
            self.path.canonicalize()? == self.path
                && same_file::Handle::from_path(&self.path)? == self.identity,
            "授权目录已改变，请重新授权",
        )?;
        let relative = relative_path(source)?;
        // Resolve inward symlinks, then open beneath the retained directory handle.
        // cap-std prevents a raced parent symlink from opening outside that capability.
        let actual = self.path.join(relative).canonicalize()?;
        let relative = actual
            .strip_prefix(&self.path)
            .map_err(|_| ImportError::invalid("符号链接逃逸授权目录"))?;
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK);
        }
        let file = self.directory.open_with(relative, &options)?.into_std();
        check(file.metadata()?.is_file(), "资源不是普通文件")?;
        check(
            same_file::Handle::from_file(file.try_clone()?)?
                == same_file::Handle::from_path(&actual)?
                && same_file::Handle::from_path(&self.path)? == self.identity,
            "资源路径在打开时改变",
        )?;
        Ok(file)
    }
}
fn relative_path(source: &str) -> ImportResult<PathBuf> {
    let raw = if source.starts_with("https://anynote.invalid/") {
        source.strip_prefix("https://anynote.invalid/").unwrap()
    } else {
        source
    };
    let raw = raw.split(['?', '#']).next().unwrap_or("");
    let decoded = percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .map_err(|_| ImportError::invalid("资源路径编码无效"))?;
    check(
        !decoded.is_empty() && !decoded.contains(['\\', '\0', ':']),
        "资源路径不在授权目录内",
    )?;
    let path = PathBuf::from(decoded.as_ref());
    check(
        path.components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir)),
        "资源路径逃逸授权目录",
    )?;
    Ok(path)
}
