//! Cloudflare v1 services. Run blocking snapshot/state work on a service worker.
mod browse;
mod capture;
mod client;
pub use capture::*;
mod maintenance;
mod manifest;
mod restore;
mod session;
mod upload;
pub use client::*;
pub use maintenance::*;
pub use manifest::*;
pub use restore::*;
pub use session::*;
pub use upload::*;

use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
pub type CloudResult<T> = Result<T, CloudError>;
#[derive(Debug, Clone)]
pub struct CloudError {
    pub code: String,
    pub status: Option<u16>,
    pub retry_after_ms: Option<u64>,
}
impl CloudError {
    pub fn new(code: &str) -> Self {
        Self {
            code: code.into(),
            status: None,
            retry_after_ms: None,
        }
    }
    pub fn cancelled(&self) -> bool {
        self.code == "CANCELLED"
    }
}
impl std::fmt::Display for CloudError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.code)
    }
}
impl std::error::Error for CloudError {}
macro_rules! convert {
    ($ty:ty, $code:literal) => {
        impl From<$ty> for CloudError {
            fn from(_: $ty) -> Self {
                Self::new($code)
            }
        }
    };
}
convert!(std::io::Error, "LOCAL_IO");
convert!(serde_json::Error, "INVALID_JSON");
convert!(reqwest::Error, "NETWORK");
convert!(anynote_core::backend::ServiceError, "LOCAL_STATE");
convert!(
    crate::config_migration::MigrationError,
    "CREDENTIAL_UNAVAILABLE"
);
convert!(crate::archive::ArchiveError, "ARCHIVE_STORAGE");
impl From<anynote_storage::notebook::ReadError> for CloudError {
    fn from(e: anynote_storage::notebook::ReadError) -> Self {
        Self::new(
            if e.kind() == anynote_storage::notebook::ReadErrorKind::Cancelled {
                "CANCELLED"
            } else {
                "STORAGE"
            },
        )
    }
}
pub(crate) fn ensure(ok: bool, code: &str) -> CloudResult<()> {
    if ok {
        Ok(())
    } else {
        Err(CloudError::new(code))
    }
}
pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub(crate) fn valid_uuid(s: &str) -> bool {
    s.len() == 36 && uuid::Uuid::parse_str(s).is_ok()
}
pub(crate) fn check(cancel: &tokio_util::sync::CancellationToken) -> CloudResult<()> {
    ensure(!cancel.is_cancelled(), "CANCELLED")
}
