use super::write::{input, text_limit};
use super::*;
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashSet, VecDeque},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    sync::Mutex,
};

const MAX_ASSET_BYTES: u64 = 50 * 1024 * 1024;
/// Owned input handle supplied by a trusted service, never a path from UI JSON.
/// File input is streamed; the per-resource budget is checked again during copying.
pub struct ResourceWrite {
    pub id: String,
    pub name: String,
    pub mime: String,
    source: Mutex<Box<dyn ReadSeek + Send>>,
}
trait ReadSeek: Read + Seek {}
impl<T: Read + Seek> ReadSeek for T {}
impl ResourceWrite {
    pub fn bytes(id: String, name: String, mime: String, bytes: Vec<u8>) -> ReadResult<Self> {
        input(bytes.len() as u64 <= MAX_ASSET_BYTES, "资源大小超过预算")?;
        Self::source(id, name, mime, Box::new(std::io::Cursor::new(bytes)))
    }
    pub fn file(id: String, name: String, mime: String, file: File) -> ReadResult<Self> {
        input(
            file.metadata()?.is_file() && file.metadata()?.len() <= MAX_ASSET_BYTES,
            "资源文件无效或超限",
        )?;
        Self::source(id, name, mime, Box::new(file))
    }
    fn source(
        id: String,
        name: String,
        mime: String,
        source: Box<dyn ReadSeek + Send>,
    ) -> ReadResult<Self> {
        uuid(&id)?;
        text_limit(&name, 0, 240)?;
        text_limit(&mime, 1, 120)?;
        Ok(Self {
            id,
            name,
            mime,
            source: Mutex::new(source),
        })
    }
}
pub(crate) fn sync_directory(path: &std::path::Path) -> ReadResult<()> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
impl WritableNotebook {
    pub(crate) fn bind_resources(&self, resources: &[ResourceWrite]) -> ReadResult<()> {
        input(resources.len() <= 201, "资源数量超限")?;
        let mut ids = HashSet::new();
        for resource in resources {
            uuid(&resource.id)?;
            text_limit(&resource.name, 0, 240)?;
            text_limit(&resource.mime, 1, 120)?;
            input(ids.insert(&resource.id), "资源 ID 重复")?;
            self.publish_asset(resource)?;
        }
        Ok(())
    }
    fn publish_asset(&self, resource: &ResourceWrite) -> ReadResult<()> {
        let hash = self.publish_asset_bytes(
            &mut **resource
                .source
                .lock()
                .map_err(|_| ReadError::new(ReadErrorKind::Corrupt, "资源输入已失效"))?,
            &resource.mime,
            MAX_ASSET_BYTES,
        )?;
        self.view.db.execute("INSERT INTO resources(id,asset_hash,original_name) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET asset_hash=excluded.asset_hash,revision=resources.revision+1",params![resource.id,hash,resource.name])?;
        Ok(())
    }
    pub(crate) fn publish_asset_bytes<R: Read + Seek + ?Sized>(
        &self,
        source: &mut R,
        mime: &str,
        limit: u64,
    ) -> ReadResult<String> {
        let root = &self.view.root;
        let relative = format!(".anynote-asset-{}", write::new_id());
        let temp = path::local_path(root, &relative)?;
        struct Temporary(Option<std::path::PathBuf>);
        impl Drop for Temporary {
            fn drop(&mut self) {
                if let Some(path) = &self.0 {
                    let _ = fs::remove_file(path);
                }
            }
        }
        // Declare the cleanup guard first so the output handle closes before deletion on Windows.
        let mut temporary = Temporary(None);
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        temporary.0 = Some(temp.clone());
        source.seek(SeekFrom::Start(0))?;
        let mut digest = Sha256::new();
        let mut size = 0u64;
        let mut bytes = vec![0u8; MAX_RANGE_BYTES];
        loop {
            let n = source.read(&mut bytes)?;
            if n == 0 {
                break;
            }
            size += n as u64;
            input(size <= limit, "资源大小超过预算")?;
            output.write_all(&bytes[..n])?;
            digest.update(&bytes[..n]);
        }
        output.sync_all()?;
        drop(output);
        let hash = format!("{:x}", digest.finalize());
        let directory = path::local_path(root, &format!("assets/sha256/{}", &hash[..2]))?;
        fs::create_dir_all(&directory)?;
        let destination =
            path::local_path(root, &format!("assets/sha256/{}/{hash}.bin", &hash[..2]))?;
        // Atomic no-clobber publication: a failed SQL transaction may leave an orphan,
        // but must never delete or overwrite bytes pinned by an earlier revision.
        match fs::hard_link(&temp, &destination) {
            Ok(()) => {
                sync_directory(&directory)?;
                sync_directory(&root.join("assets/sha256"))?;
                sync_directory(&root.join("assets"))?;
                sync_directory(root)?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
        self.view.db.execute(
            "INSERT OR IGNORE INTO assets(hash,size,mime) VALUES(?,?,?)",
            params![hash, size, mime],
        )?;
        let asset = self.view.asset(&hash)?;
        require(asset.info().size == size, "已有 CAS 文件大小不匹配")?;
        Ok(hash)
    }
    pub(crate) fn capture(
        &self,
        revision: &str,
        body: &str,
        primary: Option<&str>,
        previous: Option<&str>,
        resources: &[ResourceWrite],
    ) -> ReadResult<()> {
        let mut seen = assets::resource_ids(body);
        if let Some(primary) = primary {
            seen.insert(primary.into());
        }
        let mut queue: VecDeque<_> = seen.iter().cloned().collect();
        let changed: HashSet<_> = resources.iter().map(|r| r.id.as_str()).collect();
        let mut count = 0;
        while let Some(id) = queue.pop_front() {
            count += 1;
            input(count <= 10_000, "资源引用数量超限")?;
            let prior: Option<String> = if !changed.contains(id.as_str()) {
                self.view.db.query_row("SELECT asset_hash FROM revision_resources WHERE revision_id=? AND resource_id=?",params![previous,id],|r|r.get(0)).optional()?
            } else {
                None
            };
            let hash = match prior {
                Some(hash) => Some(hash),
                None => self
                    .view
                    .db
                    .query_row("SELECT asset_hash FROM resources WHERE id=?", [&id], |r| {
                        r.get(0)
                    })
                    .optional()?,
            };
            let Some(hash) = hash else { continue };
            let mut asset = self.view.asset(&hash)?;
            self.view.db.execute(
                "INSERT INTO revision_resources VALUES(?,?,?)",
                params![revision, id, hash],
            )?;
            if asset.info().mime == "application/vnd.anynote.whiteboard+json" {
                input(asset.info().size <= 20 * 1024 * 1024, "白板资源超过预算")?;
                for child in asset.scene_resources()? {
                    if seen.insert(child.clone()) {
                        queue.push_back(child);
                    }
                }
            }
        }
        Ok(())
    }
}
