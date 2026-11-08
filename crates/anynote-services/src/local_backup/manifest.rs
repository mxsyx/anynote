use super::*;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub lineage_id: String,
    pub content_seq: String,
    pub schema_version: u32,
    pub storage_epoch: String,
}
impl From<&BackupRevision> for Revision {
    fn from(r: &BackupRevision) -> Self {
        Self {
            lineage_id: r.lineage_id.clone(),
            content_seq: r.content_seq.clone(),
            storage_epoch: r.storage_epoch.clone(),
            schema_version: 5,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Entry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Chunk {
    pub sha256: String,
    pub size: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Database {
    #[serde(flatten)]
    pub file: Entry,
    pub chunk_size: u64,
    pub chunks: Vec<Chunk>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: String,
    pub format_version: u32,
    pub target_id: String,
    pub notebook_id: String,
    pub task_id: String,
    pub completed_at: String,
    pub revision: Revision,
    pub name: String,
    pub database: Database,
    pub verification_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_full_verified_at: Option<String>,
    pub assets: Vec<Entry>,
    pub files: Vec<Entry>,
    #[serde(default)]
    pub cleanup: Vec<Entry>,
}
impl Entry {
    pub(super) fn validate(&self) -> Result<()> {
        let asset = asset_relative_path(&self.sha256)?;
        require(
            self.path == asset || self.path == format!("chunks/{}.bin", self.sha256),
            "MANIFEST_INVALID",
            "非法受管文件路径",
        )?;
        require(self.size <= SNAPSHOT_BYTES, "MANIFEST_INVALID", "文件超限")
    }
}
impl Manifest {
    pub fn validate(&self, target: &str, book: &str) -> Result<()> {
        require(
            self.format == "anynote.local-backup"
                && self.format_version == 3
                && self.target_id == target
                && self.notebook_id == book,
            "MANIFEST_INVALID",
            "备份版本或身份不匹配",
        )?;
        for id in [target, book, &self.task_id, &self.revision.lineage_id] {
            valid_id(id)?;
        }
        require(
            self.revision.schema_version == 5
                && self.name.encode_utf16().count() <= 240
                && chrono::DateTime::parse_from_rfc3339(&self.completed_at).is_ok(),
            "MANIFEST_INVALID",
            "清单元数据无效",
        )?;
        require(
            self.verification_status == "verified-new-files"
                && self
                    .last_full_verified_at
                    .as_ref()
                    .is_none_or(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok()),
            "MANIFEST_INVALID",
            "验证状态无效",
        )?;
        let d = &self.database;
        asset_relative_path(&d.file.sha256)?;
        require(
            d.file.path == "notebook.sqlite"
                && d.chunk_size == CHUNK_BYTES
                && !d.chunks.is_empty()
                && d.chunks.len() <= 20480
                && self.assets.len() <= 100000
                && self.files.len() <= 120480
                && self.cleanup.len() <= 120480,
            "MANIFEST_INVALID",
            "分块或条目数量无效",
        )?;
        let mut expected = BTreeMap::new();
        let mut size = 0u64;
        for (i, c) in d.chunks.iter().enumerate() {
            asset_relative_path(&c.sha256)?;
            require(
                c.size > 0
                    && c.size <= CHUNK_BYTES
                    && (i + 1 == d.chunks.len() || c.size == CHUNK_BYTES),
                "MANIFEST_INVALID",
                "有序分块大小无效",
            )?;
            size += c.size;
            let path = format!("chunks/{}.bin", c.sha256);
            if let Some(old) = expected.insert(path, (c.size, c.sha256.clone())) {
                require(old.0 == c.size, "MANIFEST_INVALID", "重复分块大小冲突")?;
            }
        }
        require(size == d.file.size, "MANIFEST_INVALID", "数据库长度不匹配")?;
        for a in &self.assets {
            a.validate()?;
            require(
                a.path == asset_relative_path(&a.sha256)?
                    && expected
                        .insert(a.path.clone(), (a.size, a.sha256.clone()))
                        .is_none(),
                "MANIFEST_INVALID",
                "附件重复或路径错误",
            )?;
            size = size
                .checked_add(a.size)
                .ok_or_else(|| Error::new("MANIFEST_INVALID", "备份超限"))?;
        }
        require(
            size <= SNAPSHOT_BYTES && expected.len() == self.files.len(),
            "MANIFEST_INVALID",
            "文件集合或总量错误",
        )?;
        let mut seen = BTreeSet::new();
        for f in &self.files {
            f.validate()?;
            require(
                seen.insert(&f.path) && expected.get(&f.path) == Some(&(f.size, f.sha256.clone())),
                "MANIFEST_INVALID",
                "文件集合不匹配",
            )?;
        }
        for f in &self.cleanup {
            f.validate()?;
            require(
                seen.insert(&f.path),
                "MANIFEST_INVALID",
                "清理与当前文件冲突",
            )?;
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Pending {
    pub target_id: String,
    pub notebook_id: String,
    pub task_id: String,
    pub files: Vec<Entry>,
}
pub(super) fn valid_id(id: &str) -> Result<()> {
    require(
        uuid::Uuid::parse_str(id).is_ok() && id.len() == 36,
        "INVALID_INPUT",
        "无效 UUID",
    )
}
