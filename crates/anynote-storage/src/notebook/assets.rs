use super::path::{FileIdentity, local_path};
use super::*;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    sync::LazyLock,
};

pub const MAX_RANGE_BYTES: usize = 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[non_exhaustive]
pub struct AssetInfo {
    pub hash: String,
    pub size: u64,
    pub mime: String,
}
/// None selects the current resource. A note scope always resolves its pinned revision.
#[derive(Clone, Debug)]
pub struct ResourceScope<'a> {
    note_id: &'a str,
    revision_id: Option<&'a str>,
}
impl<'a> ResourceScope<'a> {
    pub fn note(id: &'a str) -> Self {
        Self {
            note_id: id,
            revision_id: None,
        }
    }
    pub fn with_revision(mut self, id: &'a str) -> Self {
        self.revision_id = Some(id);
        self
    }
}
/// Owns a verified file handle; callers stream bounded ranges and never receive a filesystem path.
pub struct VerifiedAsset {
    file: File,
    identity: FileIdentity,
    root: PathBuf,
    relative: String,
    info: AssetInfo,
}
impl VerifiedAsset {
    pub fn info(&self) -> &AssetInfo {
        &self.info
    }
    pub fn read_range(&mut self, hash: &str, offset: u64, length: usize) -> ReadResult<Vec<u8>> {
        if hash != self.info.hash
            || length > MAX_RANGE_BYTES
            || offset
                .checked_add(length as u64)
                .is_none_or(|n| n > self.info.size)
        {
            return Err(ReadError::new(
                ReadErrorKind::InvalidRange,
                "资源身份或范围无效",
            ));
        }
        self.check_file()?;
        self.file.seek(SeekFrom::Start(offset))?;
        let mut bytes = vec![0; length];
        self.file.read_exact(&mut bytes)?;
        self.check_file()?;
        Ok(bytes)
    }
    pub(crate) fn scene_resources(&mut self) -> ReadResult<Vec<String>> {
        self.check_file()?;
        self.file.seek(SeekFrom::Start(0))?;
        let scene: SceneResources =
            serde_json::from_reader(std::io::BufReader::new(&mut self.file))?;
        self.check_file()?;
        Ok(scene
            .files
            .unwrap_or_default()
            .into_values()
            .filter_map(|f| f.resource_id)
            .collect())
    }
    fn check_file(&self) -> ReadResult<()> {
        let path = local_path(&self.root, &self.relative)?;
        require(
            self.identity.matches(&path)? && self.identity.matches_file(&self.file)?,
            "资源文件在读取时改变",
        )
    }
}
pub(crate) fn check_hash(hash: &str) -> ReadResult<()> {
    require(
        hash.len() == 64
            && hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "资源 hash 无效",
    )
}
impl ReadonlyNotebook {
    pub fn resource(
        &self,
        id: &str,
        scope: Option<ResourceScope<'_>>,
    ) -> ReadResult<VerifiedAsset> {
        self.check_path()?;
        uuid(id)?;
        let hash: Option<String> = if let Some(scope) = scope {
            let note = self.note(scope.note_id)?;
            let revision = scope
                .revision_id
                .or(note.head_revision_id.as_deref())
                .ok_or_else(|| ReadError::new(ReadErrorKind::NotFound, "修订不存在"))?;
            uuid(revision)?;
            self.db.query_row("SELECT r.asset_hash FROM revision_resources r WHERE r.revision_id=? AND r.resource_id=? AND EXISTS(SELECT 1 FROM note_revisions WHERE id=? AND note_id=?)", [revision,id,revision,scope.note_id], |r| r.get(0)).optional()?
        } else {
            self.db
                .query_row("SELECT asset_hash FROM resources WHERE id=?", [id], |r| {
                    r.get(0)
                })
                .optional()?
        };
        self.asset(&hash.ok_or_else(|| {
            ReadError::new(ReadErrorKind::NotFound, "资源不存在或此版本未引用该资源")
        })?)
    }
    pub(crate) fn asset(&self, hash: &str) -> ReadResult<VerifiedAsset> {
        check_hash(hash)?;
        let mut values = model::rows(
            &self.db,
            "SELECT hash,size,mime FROM assets WHERE hash=?",
            [hash],
        )?;
        let info: AssetInfo = serde_json::from_value(
            values
                .pop()
                .ok_or_else(|| ReadError::new(ReadErrorKind::NotFound, "资源不存在"))?,
        )?;
        let relative = format!("assets/sha256/{}/{hash}.bin", &hash[..2]);
        let path = local_path(&self.root, &relative)?;
        let mut file = File::open(&path)?;
        let identity = FileIdentity::from_file(&file)?;
        require(
            identity.matches(&path)? && file.metadata()?.len() == info.size,
            "资源大小或文件身份不匹配",
        )?;
        let mut digest = Sha256::new();
        let mut buffer = vec![0u8; MAX_RANGE_BYTES];
        let mut size = 0;
        loop {
            let n = file.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            digest.update(&buffer[..n]);
            size += n as u64;
        }
        require(
            size == info.size && format!("{:x}", digest.finalize()) == hash,
            "资源 hash 不匹配",
        )?;
        let asset = VerifiedAsset {
            file,
            identity,
            root: self.root.clone(),
            relative,
            info,
        };
        asset.check_file()?;
        Ok(asset)
    }
    pub(crate) fn verify_assets(&self) -> ReadResult<()> {
        let mut stmt = self.db.prepare("SELECT hash FROM assets ORDER BY hash")?;
        for hash in stmt.query_map([], |r| r.get::<_, String>(0))? {
            self.asset(&hash?)?;
        }
        Ok(())
    }
    pub(crate) fn verify_revision_closure(&self) -> ReadResult<()> {
        let pinned = self.revision_resources()?;
        let mut by_revision: HashMap<&str, HashMap<&str, &str>> = HashMap::new();
        for r in &pinned {
            by_revision
                .entry(&r.revision_id)
                .or_default()
                .insert(&r.resource_id, &r.asset_hash);
        }
        let known: HashSet<String> = self
            .db
            .prepare("SELECT id FROM resources")?
            .query_map([], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        for id in &known {
            uuid(id)?;
        }
        require(model::rows(&self.db, "SELECT node_id FROM notes n WHERE primary_resource_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM revision_resources r WHERE r.revision_id=n.head_revision_id AND r.resource_id=n.primary_resource_id)", [])?.is_empty(), "当前修订主资源闭包缺失")?;
        let mut stmt = self.db.prepare("SELECT id,body FROM note_revisions")?;
        for revision in
            stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        {
            let (id, body) = revision?;
            uuid(&id)?;
            let empty = HashMap::new();
            let resources = by_revision.get(id.as_str()).unwrap_or(&empty);
            for resource in resource_ids(&body) {
                // Existing capture deliberately ignores unresolved resource IDs; retain that behavior.
                require(
                    !known.contains(&resource) || resources.contains_key(resource.as_str()),
                    "修订资源引用闭包缺失",
                )?;
            }
            for hash in resources.values() {
                let mime: String =
                    self.db
                        .query_row("SELECT mime FROM assets WHERE hash=?", [hash], |r| r.get(0))?;
                if mime != "application/vnd.anynote.whiteboard+json" {
                    continue;
                }
                let mut asset = self.asset(hash)?;
                asset.file.seek(SeekFrom::Start(0))?;
                let scene: SceneResources =
                    serde_json::from_reader(std::io::BufReader::new(&mut asset.file))?;
                asset.check_file()?;
                for file in scene.files.unwrap_or_default().values() {
                    if let Some(id) = &file.resource_id {
                        require(
                            !known.contains(id) || resources.contains_key(id.as_str()),
                            "白板历史嵌图闭包缺失",
                        )?;
                    }
                }
            }
        }
        Ok(())
    }
}
#[derive(Deserialize)]
struct SceneResources {
    files: Option<HashMap<String, SceneResource>>,
}
#[derive(Deserialize)]
struct SceneResource {
    #[serde(rename = "resourceId")]
    resource_id: Option<String>,
}

pub(crate) fn resource_ids(body: &str) -> HashSet<String> {
    static PATTERN: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"(?i)anynote-resource:([a-f0-9-]{36})").unwrap());
    let mut ids: HashSet<_> = PATTERN
        .captures_iter(body)
        .map(|c| c[1].to_owned())
        .collect();
    for block in anynote_core::protocol::markdown::parse_blocks(body) {
        let Some(value) = block.directive().and_then(|d| d.data()) else {
            continue;
        };
        let mut stack = vec![value];
        let mut budget = 0;
        while let Some(value) = stack.pop() {
            budget += 1;
            if budget > 10000 {
                break;
            }
            match value {
                serde_json::Value::Object(fields) => {
                    for (key, value) in fields {
                        if key.to_ascii_lowercase().ends_with("resourceid")
                            && value.as_str().is_some_and(|s| {
                                s.len() == 36
                                    && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
                            })
                        {
                            ids.insert(value.as_str().unwrap().to_owned());
                        } else if value.is_object() || value.is_array() {
                            stack.push(value);
                        }
                    }
                }
                serde_json::Value::Array(values) => stack.extend(values),
                _ => {}
            }
        }
    }
    ids
}
