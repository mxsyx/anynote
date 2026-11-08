use super::*;
use anynote_storage::notebook::{checked_local_path, sync_directory};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferIdentity {
    pub connection_id: String,
    pub endpoint: String,
    pub notebook_id: String,
    pub lineage_id: String,
    pub direction: Direction,
    pub writer: Option<WriterIdentity>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Upload,
    Download,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WriterIdentity {
    pub device_id: String,
    pub epoch: u64,
}
impl TransferIdentity {
    pub fn validate(&self) -> CloudResult<()> {
        ensure(
            [&self.connection_id, &self.notebook_id, &self.lineage_id]
                .iter()
                .all(|v| valid_uuid(v)),
            "TRANSFER_IDENTITY",
        )?;
        RecoveryConnection {
            id: self.connection_id.clone(),
            name: "transfer".into(),
            endpoint: self.endpoint.clone(),
            allow_insecure: true,
        }
        .validate()?;
        ensure(
            match (&self.direction, &self.writer) {
                (Direction::Upload, Some(w)) => {
                    valid_uuid(&w.device_id) && (1..=JS_SAFE).contains(&w.epoch)
                }
                (Direction::Download, None) => true,
                _ => false,
            },
            "TRANSFER_WRITER",
        )
    }
    pub fn matches(&self, manifest: &Manifest) -> CloudResult<()> {
        let m = &manifest.data;
        ensure(
            m.notebook_id == self.notebook_id
                && m.lineage_id == self.lineage_id
                && self
                    .writer
                    .as_ref()
                    .is_none_or(|w| w.device_id == m.device_id && w.epoch == m.writer_epoch),
            "TRANSFER_IDENTITY",
        )
    }
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudCursor {
    pub last_generation: String,
    pub last_ack_seq: u64,
    pub pending_generation: Option<String>,
    pub pending_manifest_hash: Option<String>,
}
/// Exclusive OS lease releases on process death. Files are private, bounded and fsynced.
pub struct TransferSession {
    pub(crate) root: PathBuf,
    pub(crate) state_root: PathBuf,
    identity: TransferIdentity,
    _lease: File,
}
impl TransferSession {
    pub fn open(root: &Path, identity: TransferIdentity) -> CloudResult<Self> {
        identity.validate()?;
        let key = digest(&serde_json::to_vec(&identity)?);
        let base = checked_local_path(root, "cloud.transfers")?;
        fs::create_dir_all(&base)?;
        private_dir(&base)?;
        let lock = checked_local_path(&base, &format!("{key}.lock"))?;
        let lease = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock)?;
        lease
            .try_lock()
            .map_err(|_| CloudError::new("TRANSFER_BUSY"))?;
        let path = checked_local_path(&base, &key)?;
        fs::create_dir_all(&path)?;
        private_dir(&path)?;
        let session = Self {
            root: path,
            state_root: root.to_owned(),
            identity,
            _lease: lease,
        };
        if let Some(prior) = session.read::<TransferIdentity>("transfer.identity")? {
            ensure(prior == session.identity, "TRANSFER_IDENTITY")?;
        } else {
            session.write("transfer.identity", &session.identity)?;
        }
        Ok(session)
    }
    pub fn identity(&self) -> &TransferIdentity {
        &self.identity
    }
    pub fn cursor(&self) -> CloudResult<CloudCursor> {
        Ok(self.read("upload.cursor")?.unwrap_or_default())
    }
    pub(crate) fn bind(&self, client: &CloudClient, direction: Direction) -> CloudResult<()> {
        ensure(
            self.identity.direction == direction
                && self.identity.connection_id == client.connection.id
                && self.identity.endpoint == client.connection.endpoint,
            "TRANSFER_CONNECTION",
        )
    }
    pub(crate) fn path(&self, name: &str) -> CloudResult<PathBuf> {
        Ok(checked_local_path(&self.root, name)?)
    }
    pub(crate) fn read<T: serde::de::DeserializeOwned>(&self, key: &str) -> CloudResult<Option<T>> {
        let path = self.path(&format!("{key}.json"))?;
        match File::open(path) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take((MANIFEST_BYTES + 1) as u64)
                    .read_to_end(&mut bytes)?;
                ensure(bytes.len() <= MANIFEST_BYTES, "STATE_BUDGET")?;
                Ok(Some(serde_json::from_slice(&bytes)?))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }
    pub(crate) fn write<T: Serialize>(&self, key: &str, value: &T) -> CloudResult<()> {
        self.write_bytes(&format!("{key}.json"), &serde_json::to_vec(value)?)
    }
    pub(crate) fn write_bytes(&self, name: &str, bytes: &[u8]) -> CloudResult<()> {
        let path = self.path(name)?;
        let parent = path.parent().ok_or_else(|| CloudError::new("STATE_PATH"))?;
        fs::create_dir_all(parent)?;
        private_dir(parent)?;
        let mut temp = tempfile::NamedTempFile::new_in(parent)?;
        temp.write_all(bytes)?;
        temp.as_file().sync_all()?;
        temp.persist(&path).map_err(|e| CloudError::from(e.error))?;
        sync_directory(parent)?;
        Ok(())
    }
    pub(crate) fn pending(&self) -> CloudResult<Option<Manifest>> {
        let cursor = self.cursor()?;
        let Some(id) = cursor.pending_generation else {
            return Ok(None);
        };
        ensure(valid_uuid(&id), "PENDING_IDENTITY")?;
        let file = File::open(self.path(&format!("upload.{id}.manifest"))?)?;
        let mut bytes = Vec::new();
        file.take((MANIFEST_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        let manifest = Manifest::parse(&bytes)?;
        self.identity.matches(&manifest)?;
        ensure(
            manifest.data.generation_id == id
                && Some(manifest.hash()) == cursor.pending_manifest_hash,
            "PENDING_MANIFEST_CHANGED",
        )?;
        Ok(Some(manifest))
    }
    pub(crate) fn begin(&self, manifest: &Manifest) -> CloudResult<()> {
        self.identity.matches(manifest)?;
        let mut cursor = self.cursor()?;
        ensure(cursor.pending_generation.is_none(), "PENDING_UNRESOLVED")?;
        ensure(
            cursor.last_generation.is_empty()
                || manifest.data.expected_head == cursor.last_generation,
            "CURSOR_HEAD_CONFLICT",
        )?;
        ensure(
            manifest.data.snapshot_seq >= cursor.last_ack_seq,
            "CURSOR_REGRESSION",
        )?;
        self.write_bytes(
            &format!("upload.{}.manifest", manifest.data.generation_id),
            manifest.bytes(),
        )?;
        cursor.pending_generation = Some(manifest.data.generation_id.clone());
        cursor.pending_manifest_hash = Some(manifest.hash());
        self.write("upload.cursor", &cursor)
    }
    pub(crate) fn committed(&self, manifest: &Manifest) -> CloudResult<CloudCursor> {
        let mut cursor = self.cursor()?;
        ensure(
            cursor.pending_generation.as_ref() == Some(&manifest.data.generation_id)
                && cursor.pending_manifest_hash.as_ref() == Some(&manifest.hash())
                && manifest.data.snapshot_seq >= cursor.last_ack_seq,
            "CURSOR_CONFLICT",
        )?;
        cursor.last_generation = manifest.data.generation_id.clone();
        cursor.last_ack_seq = manifest.data.snapshot_seq;
        cursor.pending_generation = None;
        cursor.pending_manifest_hash = None;
        self.write("upload.cursor", &cursor)?;
        Ok(cursor)
    }
}
fn private_dir(path: &Path) -> CloudResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
