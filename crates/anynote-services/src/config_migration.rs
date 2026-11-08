//! Offline configuration readers. Call only on a closed, preserved userData copy.
//! Activation, scheduling and migration journals belong to RM14.
pub mod credentials;
mod leveldb_check;
pub mod plugins;
pub mod preferences;

use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationError {
    Io,
    InvalidData,
    Unsupported,
    Budget,
    Conflict,
    CredentialUnavailable,
    VerificationFailed,
}
impl std::fmt::Display for MigrationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for MigrationError {}
impl From<std::io::Error> for MigrationError {
    fn from(_: std::io::Error) -> Self {
        Self::Io
    }
}
pub type Result<T> = std::result::Result<T, MigrationError>;

pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(crate) fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>> {
    if !fs::symlink_metadata(path)?.file_type().is_file() {
        return Err(MigrationError::InvalidData);
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(MigrationError::Budget);
    }
    Ok(bytes)
}

/// Copies every regular file, including unknown packages, without interpreting scripts.
/// The caller owns a closed source copy and a new private destination; failure leaves
/// the incomplete destination for diagnosis and never removes the source.
pub fn preserve_directory(source: &Path, destination: &Path, budget: u64) -> Result<()> {
    fn copy(source: &Path, destination: &Path, remaining: &mut u64, depth: usize) -> Result<()> {
        if depth > 32 || !fs::symlink_metadata(source)?.file_type().is_dir() {
            return Err(MigrationError::InvalidData);
        }
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            let ty = entry.file_type()?;
            let to = destination.join(entry.file_name());
            if ty.is_dir() {
                copy(&entry.path(), &to, remaining, depth + 1)?;
            } else if ty.is_file() {
                let bytes =
                    read_bounded(&entry.path(), (*remaining).min(usize::MAX as u64) as usize)?;
                *remaining -= bytes.len() as u64;
                let mut options = fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let mut out = options.open(&to)?;
                out.write_all(&bytes)?;
                out.sync_all()?;
                if digest(&read_bounded(&to, bytes.len())?) != digest(&bytes) {
                    return Err(MigrationError::VerificationFailed);
                }
            } else {
                return Err(MigrationError::InvalidData);
            }
        }
        Ok(())
    }
    let parent = destination
        .parent()
        .ok_or(MigrationError::InvalidData)?
        .canonicalize()?;
    let target = parent.join(destination.file_name().ok_or(MigrationError::InvalidData)?);
    if target.starts_with(source.canonicalize()?) {
        return Err(MigrationError::InvalidData);
    }
    let mut remaining = budget;
    copy(source, destination, &mut remaining, 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_packages_are_copied_without_execution_and_budget_is_enforced() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(
            source.join("unknown.js"),
            b"throw new Error('must never execute');",
        )
        .unwrap();
        fs::write(
            source.join("registry.json"),
            br#"[{"manifest":{"id":"unknown.required","version":"1"},"checksum":"unknown"}]"#,
        )
        .unwrap();
        let report =
            plugins::preserve_plugins(&source, &dir.path().join("preserved"), 4096).unwrap();
        assert_eq!(report.unknown_entries, ["unknown.required"]);
        assert_eq!(report.files.len(), 2);
        assert_eq!(
            fs::read(source.join("unknown.js")).unwrap(),
            fs::read(dir.path().join("preserved/unknown.js")).unwrap()
        );
        assert_eq!(
            preserve_directory(&source, &dir.path().join("limited"), 1),
            Err(MigrationError::Budget)
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&source, dir.path().join("link")).unwrap();
            assert_eq!(
                preserve_directory(&dir.path().join("link"), &dir.path().join("escape"), 4096),
                Err(MigrationError::InvalidData)
            );
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(dir.path().join("preserved/unknown.js"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
