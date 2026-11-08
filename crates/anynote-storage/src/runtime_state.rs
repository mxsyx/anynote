//! Device-local service state, deliberately separate from Notebook schema v5.
use anynote_core::backend::{ErrorCode, ServiceError, ServiceResult};
use rusqlite::{Connection, OptionalExtension, params};
use std::{
    fs::{File, OpenOptions},
    path::Path,
};

pub const MAX_STATE_BYTES: usize = 1024 * 1024;
pub struct RuntimeState {
    connection: Connection,
    _lease: File,
}
impl RuntimeState {
    pub fn open(directory: &Path) -> ServiceResult<Self> {
        let open = || -> Result<Self, Box<dyn std::error::Error>> {
            std::fs::create_dir_all(directory)?;
            let lease = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(directory.join("backend.owner.lock"))?;
            lease.try_lock()?;
            let connection = Connection::open(directory.join("backend.state.sqlite"))?;
            connection.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=1024; CREATE TABLE IF NOT EXISTS runtime_state (key TEXT PRIMARY KEY, value BLOB NOT NULL) STRICT;")?;
            Ok(Self {
                connection,
                _lease: lease,
            })
        };
        open().map_err(|_| ServiceError::new(ErrorCode::Storage))
    }
    pub fn read(&self, key: &str) -> ServiceResult<Option<Vec<u8>>> {
        let row: Option<(usize, Vec<u8>)> = self
            .connection
            .query_row(
                "SELECT length(value), substr(value,1,?2) FROM runtime_state WHERE key=?1",
                params![key, MAX_STATE_BYTES + 1],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|_| ServiceError::new(ErrorCode::Storage))?;
        match row {
            Some((length, _)) if length > MAX_STATE_BYTES => {
                Err(ServiceError::new(ErrorCode::FrameTooLarge))
            }
            Some((_, value)) => Ok(Some(value)),
            None => Ok(None),
        }
    }
    pub fn write(&self, key: &str, value: &[u8]) -> ServiceResult<()> {
        if value.len() > MAX_STATE_BYTES {
            return Err(ServiceError::new(ErrorCode::FrameTooLarge));
        }
        self.connection.execute("INSERT INTO runtime_state(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, value])
            .map(|_| ()).map_err(|_| ServiceError::new(ErrorCode::Storage))
    }
}
