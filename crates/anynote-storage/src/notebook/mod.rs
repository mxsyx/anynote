//! Schema-v5 notebooks. Connections stay on their owning storage thread.
mod assets;
mod capture;
mod catalog;
pub use capture::AppliedCapture;
mod cleanup;
pub use cleanup::{
    CleanupFile, CleanupPreview, CleanupPurgeResult, CleanupResult, purge_cleanup, recover_cleanup,
};
mod model;
mod path;
mod read;
mod schema;
mod search;
mod snapshot;
pub use snapshot::*;
pub mod transfer;
mod write;
mod write_assets;
mod write_import;
mod write_queue;
mod write_state;
pub use write::*;
pub use write_assets::ResourceWrite;
pub use write_import::{ImportRetryOutcome, ImportRetryResult};
pub use write_queue::{NotebookPin, WriteCatalog, WriteQueue, WriteTicket};
pub use write_state::{AnnotationInput, Proposal, ProposalStatus, Rectangle};

pub use assets::{AssetInfo, MAX_RANGE_BYTES, ResourceScope, VerifiedAsset};
pub use catalog::{CatalogEntry, ReadonlyCatalog};
pub use model::*;
pub use read::ReadonlyNotebook;
pub use search::{
    Backlink, SearchHit, SearchLocation, SearchRequest, SearchResponse, SearchWarning,
};

pub const SCHEMA_V5: &str = include_str!("schema.sql");
pub const BACKUP_REVISION_SQL: &str = include_str!("backup-revision.sql");

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadErrorKind {
    InvalidInput,
    Offline,
    UnsafePath,
    IdentityConflict,
    UnsupportedVersion,
    IncompatibleSchema,
    Corrupt,
    Busy,
    NotFound,
    InvalidRange,
    Cancelled,
    Conflict,
}
#[derive(Debug)]
pub struct ReadError {
    kind: ReadErrorKind,
    message: String,
}
impl ReadError {
    pub fn kind(&self) -> ReadErrorKind {
        self.kind
    }
    pub fn message(&self) -> &str {
        &self.message
    }
    pub(crate) fn new(kind: ReadErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}
impl std::fmt::Display for ReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for ReadError {}
impl From<rusqlite::Error> for ReadError {
    fn from(error: rusqlite::Error) -> Self {
        use rusqlite::ErrorCode;
        let kind = match error.sqlite_error_code() {
            Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => ReadErrorKind::Busy,
            Some(ErrorCode::CannotOpen) => ReadErrorKind::Offline,
            _ => ReadErrorKind::Corrupt,
        };
        Self::new(kind, error.to_string())
    }
}
impl From<std::io::Error> for ReadError {
    fn from(error: std::io::Error) -> Self {
        Self::new(ReadErrorKind::Offline, error.to_string())
    }
}
impl From<serde_json::Error> for ReadError {
    fn from(error: serde_json::Error) -> Self {
        Self::new(ReadErrorKind::Corrupt, error.to_string())
    }
}
pub type ReadResult<T> = Result<T, ReadError>;

pub(crate) fn require(ok: bool, message: &str) -> ReadResult<()> {
    if ok {
        Ok(())
    } else {
        Err(ReadError::new(ReadErrorKind::Corrupt, message))
    }
}
pub(crate) fn uuid(value: &str) -> ReadResult<()> {
    let valid = uuid::Uuid::parse_str(value).is_ok() && value.len() == 36;
    if valid {
        Ok(())
    } else {
        Err(ReadError::new(ReadErrorKind::InvalidInput, "无效 UUID"))
    }
}
