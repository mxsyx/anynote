use super::{MigrationError, Result, read_bounded};
use rusty_leveldb::{DB, LdbIterator};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, io::Write, path::Path};

pub const ELECTRON_VERSION: &str = "41.9.1";
const MAX_DATABASE: usize = 64 * 1024 * 1024;
const MAX_VALUE: usize = 1024 * 1024;

#[derive(Debug, Default, Serialize, Deserialize)]
#[non_exhaustive]
pub struct Preferences {
    /// Raw localStorage strings preserve formatting and allow exact inverse mapping.
    pub values: BTreeMap<String, String>,
}
#[derive(Debug, Serialize)]
#[non_exhaustive]
pub struct PreferenceReport {
    pub preferences: Preferences,
    pub rejected_records: usize,
    pub ignored_records: usize,
}
impl PreferenceReport {
    pub fn is_complete(&self) -> bool {
        self.rejected_records == 0
    }
}

fn decode(bytes: &[u8]) -> Result<String> {
    match bytes.split_first() {
        Some((1, rest)) => Ok(rest.iter().map(|c| char::from(*c)).collect()),
        Some((0, rest)) if rest.len() % 2 == 0 => String::from_utf16(
            &rest
                .as_chunks::<2>()
                .0
                .iter()
                .map(|p| u16::from_le_bytes([p[0], p[1]]))
                .collect::<Vec<_>>(),
        )
        .map_err(|_| MigrationError::InvalidData),
        _ => Err(MigrationError::InvalidData),
    }
}
fn uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}
fn map_key(key: &str) -> Option<String> {
    match key {
        "anynote.appearance" | "anynote.navigation.tabs" | "anynote.notebooks.visits" => {
            Some(key.into())
        }
        "anynote-recent" => Some("anynote.navigation.recent".into()),
        "anynote-book" => Some("anynote.navigation.activeBook".into()),
        _ => ["pdf", "image"].into_iter().find_map(|kind| {
            let suffix = key.strip_prefix(&format!("anynote-{kind}-"))?;
            if suffix.len() != 73
                || suffix.as_bytes()[36] != b'-'
                || !suffix.is_char_boundary(36)
                || !suffix.is_char_boundary(37)
            {
                return None;
            }
            let (book, note) = (&suffix[..36], &suffix[37..]);
            (uuid(book) && uuid(note)).then(|| format!("anynote.reader.{kind}.{book}.{note}"))
        }),
    }
}
fn inverse_key(key: &str) -> Option<String> {
    match key {
        "anynote.navigation.recent" => Some("anynote-recent".into()),
        "anynote.navigation.activeBook" => Some("anynote-book".into()),
        _ if key.starts_with("anynote.reader.") => {
            let parts: Vec<_> = key.split('.').collect();
            if parts.len() != 5 {
                return None;
            }
            let old = format!("anynote-{}-{}-{}", parts[2], parts[3], parts[4]);
            (map_key(&old).as_deref() == Some(key)).then_some(old)
        }
        _ => (map_key(key).as_deref() == Some(key)).then(|| key.into()),
    }
}

/// The origin is selected explicitly; values from different origins are never merged.
/// LevelDB recovery operates entirely in MemEnv, leaving even the supplied copy untouched.
pub fn read_preferences(
    directory: &Path,
    origin: &str,
    electron_version: &str,
) -> Result<PreferenceReport> {
    if electron_version != ELECTRON_VERSION
        || !["file://", "http://127.0.0.1:5173"].contains(&origin)
    {
        return Err(MigrationError::Unsupported);
    }
    if !fs::symlink_metadata(directory)?.is_dir()
        || fs::symlink_metadata(directory)?.file_type().is_symlink()
    {
        return Err(MigrationError::InvalidData);
    }
    let mut options = rusty_leveldb::in_memory();
    options.create_if_missing = false;
    options.paranoid_checks = true;
    let root = Path::new("preferences");
    options
        .env
        .mkdir(root)
        .map_err(|_| MigrationError::InvalidData)?;
    let mut remaining = MAX_DATABASE;
    let mut count = 0;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        count += 1;
        if count > 4096 {
            return Err(MigrationError::Budget);
        }
        let bytes = read_bounded(&entry.path(), remaining)?;
        remaining -= bytes.len();
        super::leveldb_check::validate(
            entry
                .file_name()
                .to_str()
                .ok_or(MigrationError::InvalidData)?,
            &bytes,
        )?;
        options
            .env
            .open_writable_file(&root.join(entry.file_name()))
            .map_err(|_| MigrationError::InvalidData)?
            .write_all(&bytes)?;
    }
    let mut db = DB::open(root, options).map_err(|_| MigrationError::InvalidData)?;
    let mut iter = db.new_iter().map_err(|_| MigrationError::InvalidData)?;
    let prefix = format!("_{origin}\0");
    let mut report = PreferenceReport {
        preferences: Preferences::default(),
        rejected_records: 0,
        ignored_records: 0,
    };
    while let Some((key, value)) = iter.next() {
        let Some(raw_key) = key.strip_prefix(prefix.as_bytes()) else {
            continue;
        };
        if key.len() > MAX_VALUE || value.len() > MAX_VALUE {
            report.rejected_records += 1;
            continue;
        }
        let Ok(key) = decode(raw_key) else {
            report.rejected_records += 1;
            continue;
        };
        let Some(mapped) = map_key(&key) else {
            report.ignored_records += 1;
            continue;
        };
        match decode(&value) {
            Ok(value) if valid_value(&mapped, &value) => {
                if report.preferences.values.insert(mapped, value).is_some() {
                    report.rejected_records += 1;
                }
            }
            _ => report.rejected_records += 1,
        }
    }
    Ok(report)
}
fn valid_value(key: &str, raw: &str) -> bool {
    if raw.len() > MAX_VALUE {
        return false;
    }
    if key == "anynote.navigation.tabs" {
        return ["hidden", "visible"].contains(&raw);
    }
    if key == "anynote.navigation.activeBook" {
        return uuid(raw);
    }
    if key.starts_with("anynote.reader.pdf.") {
        return raw.parse::<u32>().is_ok_and(|n| n > 0);
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return false;
    };
    match key {
        "anynote.appearance" => v
            .as_object()
            .is_some_and(|o| o.len() == 1 && matches!(v["mode"].as_str(), Some("light" | "dark"))),
        "anynote.navigation.recent" => v
            .as_array()
            .is_some_and(|a| a.iter().all(|v| v.as_str().is_some())),
        "anynote.notebooks.visits" => v
            .as_object()
            .is_some_and(|o| o.iter().all(|(k, v)| uuid(k) && v.as_u64().is_some())),
        _ if key.starts_with("anynote.reader.image.") => v.as_object().is_some_and(|o| {
            o.len() == 3
                && matches!(v["fit"].as_str(), Some("window" | "actual" | "custom"))
                && v["zoom"].as_f64().is_some_and(|n| n > 0. && n <= 100.)
                && v["rotate"].as_f64().is_some()
        }),
        _ => false,
    }
}
impl Preferences {
    pub fn reverse(&self) -> Result<BTreeMap<String, String>> {
        self.values
            .iter()
            .map(|(key, value)| {
                if !valid_value(key, value) {
                    return Err(MigrationError::InvalidData);
                }
                Ok((
                    inverse_key(key).ok_or(MigrationError::Unsupported)?,
                    value.clone(),
                ))
            })
            .collect()
    }
    /// Publishes only a validated non-secret preference document to an existing private directory.
    pub fn save(&self, rust_directory: &Path) -> Result<()> {
        self.reverse()?;
        let mut file = tempfile::NamedTempFile::new_in(rust_directory)?;
        serde_json::to_writer(
            &mut file,
            &serde_json::json!({"format":"anynote.preferences.v1","values":self.values}),
        )
        .map_err(|_| MigrationError::InvalidData)?;
        file.flush()?;
        file.as_file().sync_all()?;
        file.persist(rust_directory.join("preferences.json"))
            .map_err(|_| MigrationError::Io)?;
        #[cfg(unix)]
        fs::File::open(rust_directory)?.sync_all()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn files(dir: &Path) -> BTreeMap<String, Vec<u8>> {
        fs::read_dir(dir)
            .unwrap()
            .map(|entry| {
                let e = entry.unwrap();
                (
                    e.file_name().to_str().unwrap().into(),
                    fs::read(e.path()).unwrap(),
                )
            })
            .collect()
    }
    #[test]
    fn electron_file_dev_clean_and_crash_read_without_mutation() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/rust-migration/config/electron-linux");
        for name in ["file-clean", "file-crash", "dev-clean", "dev-crash"] {
            let dir = root.join(name);
            let expected: serde_json::Value =
                serde_json::from_slice(&fs::read(dir.join("expected.json")).unwrap()).unwrap();
            let before = files(&dir.join("leveldb"));
            let hashes: BTreeMap<String, String> = serde_json::from_slice(
                &fs::read(root.with_file_name("electron-linux-sha256.json")).unwrap(),
            )
            .unwrap();
            for (file, bytes) in &before {
                assert_eq!(
                    hashes.get(&format!("{name}/leveldb/{file}")),
                    Some(&super::super::digest(bytes))
                );
            }
            let result = read_preferences(
                &dir.join("leveldb"),
                expected["origin"].as_str().unwrap(),
                ELECTRON_VERSION,
            )
            .unwrap();
            assert!(result.is_complete(), "{name}: {result:?}");
            assert_eq!(
                serde_json::to_value(result.preferences.reverse().unwrap()).unwrap(),
                expected["values"],
                "{name}"
            );
            assert_eq!(before, files(&dir.join("leveldb")));
            let saved = tempfile::tempdir().unwrap();
            result.preferences.save(saved.path()).unwrap();
            let document: serde_json::Value =
                serde_json::from_slice(&fs::read(saved.path().join("preferences.json")).unwrap())
                    .unwrap();
            assert_eq!(document["format"], "anynote.preferences.v1");
            assert!(!document.to_string().contains("unrelated.token"));
        }
    }
    #[test]
    fn encodings_invalid_data_origin_and_corruption() {
        assert_eq!(decode(&[1, 0x63, 0x61, 0x66, 0xe9]).unwrap(), "café");
        let mut bytes = vec![0];
        bytes.extend("阅读📚".encode_utf16().flat_map(u16::to_le_bytes));
        assert_eq!(decode(&bytes).unwrap(), "阅读📚");
        assert!(decode(&[0, 0, 0xd8]).is_err());
        assert!(decode(&[0, 1]).is_err());
        assert!(map_key("anynote-pdf-../../secret").is_none());
        let dir = tempfile::tempdir().unwrap();
        assert!(
            read_preferences(dir.path(), "https://unrelated.invalid", ELECTRON_VERSION).is_err()
        );
        assert!(read_preferences(dir.path(), "file://", "42").is_err());
        assert!(read_preferences(dir.path(), "file://", ELECTRON_VERSION).is_err());
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/rust-migration/config/electron-linux/file-crash/leveldb");
        let copied = dir.path().join("copy");
        super::super::preserve_directory(&source, &copied, 64 * 1024 * 1024).unwrap();
        let path = fs::read_dir(&copied)
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.extension().is_some_and(|s| s == "log"))
            .unwrap();
        let mut bytes = fs::read(&path).unwrap();
        bytes[0] ^= 1;
        fs::write(&path, bytes).unwrap();
        assert!(read_preferences(&copied, "file://", ELECTRON_VERSION).is_err());
    }
    #[test]
    fn invalid_allowlisted_value_blocks_complete_and_unrelated_origin_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut db = DB::open(dir.path(), rusty_leveldb::Options::default()).unwrap();
            db.put(b"_file://\0\x01anynote.appearance", b"\x01not-json")
                .unwrap();
            db.put(
                b"_https://elsewhere\0\x01anynote.appearance",
                b"\x01{\"mode\":\"dark\"}",
            )
            .unwrap();
            db.flush().unwrap();
        }
        let result = read_preferences(dir.path(), "file://", ELECTRON_VERSION).unwrap();
        assert!(!result.is_complete());
        assert!(result.preferences.values.is_empty());
    }
}

#[cfg(test)]
mod table_tests {
    use super::*;
    #[test]
    fn compressed_tables_and_fragmented_logs_are_verified_before_iteration() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut db = DB::open(dir.path(), rusty_leveldb::Options::default()).unwrap();
            let value = format!(
                "\u{1}{}",
                serde_json::to_string(&vec!["阅读📚".repeat(6000)]).unwrap()
            );
            db.put(b"_file://\0\x01anynote-recent", value.as_bytes())
                .unwrap();
            db.put(b"_file://\0\x01anynote.navigation.tabs", b"\x01hidden")
                .unwrap();
            db.flush().unwrap();
        }
        let result = read_preferences(dir.path(), "file://", ELECTRON_VERSION).unwrap();
        assert!(result.is_complete());
        assert_eq!(result.preferences.values.len(), 2);
        {
            let mut db = DB::open(dir.path(), rusty_leveldb::Options::default()).unwrap();
            db.compact_range(b"", b"~").unwrap();
        }
        let result = read_preferences(dir.path(), "file://", ELECTRON_VERSION).unwrap();
        assert!(result.is_complete());
        assert_eq!(result.preferences.values.len(), 2);
        let table = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.extension().is_some_and(|e| e == "ldb"))
            .unwrap();
        let mut bytes = fs::read(&table).unwrap();
        bytes[0] ^= 1;
        fs::write(table, bytes).unwrap();
        assert!(read_preferences(dir.path(), "file://", ELECTRON_VERSION).is_err());
    }
}
