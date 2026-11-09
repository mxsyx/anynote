use super::*;
use sha2::{Digest, Sha256};
use std::io::{Read, Seek, Write};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct Entry {
    pub path: PathBuf,
    pub bytes: u64,
    pub sha256: Option<String>,
}

pub(super) fn directory(path: &Path) -> Result<()> {
    if path.exists() {
        safe(path)?;
        ensure(path.is_dir(), "PATH")?;
        return Ok(());
    }
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    sync(path.parent().ok_or(Error("PATH"))?)
}

pub(super) fn safe(path: &Path) -> Result<()> {
    ensure(path.is_absolute(), "PATH")?;
    for parent in path.ancestors() {
        let m = fs::symlink_metadata(parent)?;
        ensure(!m.file_type().is_symlink(), "PATH_REDIRECT")?;
        #[cfg(unix)]
        if m.is_file() {
            use std::os::unix::fs::MetadataExt;
            ensure(m.nlink() == 1, "HARD_LINK")?;
        }
    }
    ensure(path.canonicalize()? == path, "PATH_REDIRECT")
}

pub(super) fn sync(path: &Path) -> Result<()> {
    #[cfg(unix)]
    fs::File::open(path)?.sync_all()?;
    let _ = path;
    Ok(())
}

pub(super) fn publish(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or(Error("PATH"))?;
    safe(parent)?;
    if path.exists() {
        safe(path)?;
    }
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|_| Error("PUBLISH"))?;
    sync(parent)
}

pub(super) fn json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    publish(path, &serde_json::to_vec(value).map_err(|_| Error("JSON"))?)
}

fn hash(input: &mut fs::File, output: Option<&mut fs::File>, limit: u64) -> Result<(u64, String)> {
    input.rewind()?;
    let mut output = output;
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0; 65536];
    loop {
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        bytes = bytes.checked_add(n as u64).ok_or(Error("BUDGET"))?;
        ensure(bytes <= limit, "BUDGET")?;
        hash.update(&buffer[..n]);
        if let Some(out) = output.as_mut() {
            out.write_all(&buffer[..n])?;
        }
    }
    Ok((bytes, format!("{:x}", hash.finalize())))
}

pub(super) fn inventory(
    root: &Path,
    skip: Option<&Path>,
    handles: &mut BTreeMap<PathBuf, fs::File>,
) -> Result<Vec<Entry>> {
    fn walk(
        root: &Path,
        path: &Path,
        skip: Option<&Path>,
        handles: &mut BTreeMap<PathBuf, fs::File>,
        entries: &mut Vec<Entry>,
        total: &mut u64,
        depth: usize,
    ) -> Result<()> {
        ensure(depth <= 64 && entries.len() < 100_000, "BUDGET")?;
        safe(path)?;
        let mut children = fs::read_dir(path)?.collect::<std::io::Result<Vec<_>>>()?;
        children.sort_by_key(|e| e.file_name());
        for child in children {
            let path = child.path();
            if skip == Some(path.as_path()) {
                continue;
            }
            safe(&path)?;
            let ty = child.file_type()?;
            let relative = path
                .strip_prefix(root)
                .map_err(|_| Error("PATH"))?
                .to_owned();
            if ty.is_dir() {
                entries.push(Entry {
                    path: relative,
                    bytes: 0,
                    sha256: None,
                });
                walk(root, &path, skip, handles, entries, total, depth + 1)?;
            } else {
                ensure(ty.is_file(), "SPECIAL_FILE")?;
                let (bytes, sha256) = if let Some(input) = handles.get_mut(&path) {
                    hash(input, None, BUDGET - *total)?
                } else {
                    hash(&mut fs::File::open(&path)?, None, BUDGET - *total)?
                };
                *total += bytes;
                entries.push(Entry {
                    path: relative,
                    bytes,
                    sha256: Some(sha256),
                });
            }
            ensure(entries.len() <= 100_000, "BUDGET")?;
        }
        Ok(())
    }
    let mut entries = Vec::new();
    walk(root, root, skip, handles, &mut entries, &mut 0, 0)?;
    Ok(entries)
}

pub(super) fn copy(
    root: &Path,
    target: &Path,
    entries: &[Entry],
    handles: &mut BTreeMap<PathBuf, fs::File>,
) -> Result<()> {
    directory(target)?;
    for entry in entries {
        ensure(
            !entry.path.as_os_str().is_empty()
                && entry
                    .path
                    .components()
                    .all(|p| matches!(p, std::path::Component::Normal(_))),
            "JOURNAL_PATH",
        )?;
        let source = root.join(&entry.path);
        let destination = target.join(&entry.path);
        safe(&source)?;
        if entry.sha256.is_none() {
            directory(&destination)?;
            continue;
        }
        if destination.exists() {
            safe(&destination)?;
            let (bytes, digest) = hash(&mut fs::File::open(&destination)?, None, entry.bytes)?;
            ensure(
                bytes == entry.bytes && Some(digest) == entry.sha256,
                "COPY_CONFLICT",
            )?;
            continue;
        }
        let parent = destination.parent().ok_or(Error("PATH"))?;
        safe(parent)?;
        // Interrupted temporary files stay outside the sealed tree, so a restart
        // can finish it without deleting unrecognized files from a source/copy.
        let mut temp = tempfile::NamedTempFile::new_in(target.parent().ok_or(Error("PATH"))?)?;
        let (bytes, digest) = if let Some(input) = handles.get_mut(&source) {
            hash(input, Some(temp.as_file_mut()), entry.bytes)?
        } else {
            hash(
                &mut fs::File::open(&source)?,
                Some(temp.as_file_mut()),
                entry.bytes,
            )?
        };
        ensure(
            bytes == entry.bytes && Some(digest) == entry.sha256,
            "SOURCE_CHANGED",
        )?;
        temp.as_file().sync_all()?;
        temp.persist_noclobber(&destination)
            .map_err(|_| Error("COPY_CONFLICT"))?;
        sync(parent)?;
    }
    sync(target)
}
