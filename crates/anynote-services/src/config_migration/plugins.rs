use super::{MigrationError, Result, digest};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const KNOWN: &str =
    include_str!("../../../../tests/fixtures/rust-migration/config/known-state-mappings.json");
const KNOWN_BUSINESS: &str =
    include_str!("../../../../tests/fixtures/builtin/known-manifests.json");

/// Classification only. No declarations from the package become executable commands or views.
pub fn is_known_business(entry: &Value) -> bool {
    let Ok(known) = serde_json::from_str::<Vec<Known>>(KNOWN_BUSINESS) else {
        return false;
    };
    known
        .iter()
        .any(|k| k.manifest == entry["manifest"] && entry["checksum"].as_str() == Some(&k.checksum))
}
pub fn is_known_source(path: &str, bytes: &[u8]) -> bool {
    let Ok(entries) = serde_json::from_str::<Vec<Value>>(include_str!(
        "../../../../tests/fixtures/rust-migration/inventory/known-plugins.json"
    )) else {
        return false;
    };
    let checksum = digest(bytes);
    entries
        .iter()
        .any(|entry| entry["path"] == path && entry["sha256"] == checksum)
}

#[derive(Deserialize)]
struct Known {
    manifest: Value,
    checksum: String,
    #[serde(rename = "settingsChecksum")]
    settings_checksum: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[non_exhaustive]
pub struct LegacyState {
    pub extension_id: String,
    pub key: String,
    pub schema_version: u32,
    pub revision: u64,
    pub value_json: String,
}
#[derive(Debug, Serialize, PartialEq, Eq)]
pub enum PluginDisposition {
    Converted,
    PreservedUnknown,
    PreservedIncompatible,
}
#[derive(Debug, Serialize)]
#[non_exhaustive]
pub struct PluginReport {
    pub extension_id: String,
    pub disposition: PluginDisposition,
    pub source_sha256: String,
    pub converted: Option<BuiltinState>,
}
#[derive(Debug, Serialize)]
#[non_exhaustive]
pub struct BuiltinState {
    pub key: String,
    pub version: u32,
    pub values: Value,
    pub source_revision: u64,
}

/// Pure conversion of a preserved registry entry and extension_data row. No manifest
/// declarations, migration scripts, commands or package entry points are evaluated.
pub fn convert_state(entry_json: &str, row: &LegacyState) -> Result<PluginReport> {
    if entry_json.len() > 8 * 1024 * 1024 || row.value_json.len() > 128 * 1024 {
        return Err(MigrationError::Budget);
    }
    let entry: Value = serde_json::from_str(entry_json).map_err(|_| MigrationError::InvalidData)?;
    let known: Vec<Known> = serde_json::from_str(KNOWN).map_err(|_| MigrationError::InvalidData)?;
    let candidate = known.iter().find(|k| {
        k.manifest["id"] == row.extension_id
            && k.manifest["version"] == entry["manifest"]["version"]
    });
    let mut report = PluginReport {
        extension_id: row.extension_id.clone(),
        disposition: PluginDisposition::PreservedUnknown,
        source_sha256: digest(row.value_json.as_bytes()),
        converted: None,
    };
    let Some(known) = candidate else {
        return Ok(report);
    };
    report.disposition = PluginDisposition::PreservedIncompatible;
    if entry["manifest"] != known.manifest
        || entry["checksum"].as_str() != Some(&known.checksum)
        || row.revision == 0
    {
        return Ok(report);
    }
    let Ok(raw) = serde_json::from_str::<Value>(&row.value_json) else {
        return Ok(report);
    };
    let (key, values) = match (row.extension_id.as_str(), row.key.as_str()) {
        ("garden.preferences", "settings:form") if row.schema_version == 1 => {
            if raw["format"] != "anynote.extension-settings.v1"
                || raw["schemaChecksum"].as_str() != known.settings_checksum.as_deref()
                || raw.as_object().is_none_or(|o| o.len() != 3)
            {
                return Ok(report);
            }
            let Some(mut values) = raw["values"].as_object().cloned() else {
                return Ok(report);
            };
            let old = known.manifest["version"] == "0.1.0";
            let goal = if old { "target" } else { "goal" };
            if values.len() != 3
                || !values
                    .get("heading")
                    .and_then(Value::as_str)
                    .is_some_and(|s| s.encode_utf16().count() <= 80)
                || !values
                    .get(goal)
                    .and_then(Value::as_u64)
                    .is_some_and(|n| (1..=100).contains(&n))
                || values.get("enabled").and_then(Value::as_bool).is_none()
            {
                return Ok(report);
            }
            if old {
                let value = values.remove("target").ok_or(MigrationError::InvalidData)?;
                values.insert("goal".into(), value);
            }
            ("anynote.reading.preferences", Value::Object(values))
        }
        ("garden.session", "script:state") => {
            let old = known.manifest["version"] == "0.1.0";
            if row.schema_version != if old { 1 } else { 2 } {
                return Ok(report);
            }
            let Some(mut values) = raw.as_object().cloned() else {
                return Ok(report);
            };
            let count = if old { "runs" } else { "visits" };
            if !values
                .get(count)
                .and_then(Value::as_u64)
                .is_some_and(|n| n <= 9_007_199_254_740_991)
                || values.get("lastTitle").is_some_and(|v| !v.is_string())
            {
                return Ok(report);
            }
            if old {
                if values.contains_key("visits") {
                    return Ok(report);
                }
                let value = values.remove("runs").ok_or(MigrationError::InvalidData)?;
                values.insert("visits".into(), value);
            }
            values
                .entry("lastTitle")
                .or_insert(Value::String(String::new()));
            ("anynote.reading.session", Value::Object(values))
        }
        _ => return Ok(report),
    };
    report.converted = Some(BuiltinState {
        key: key.into(),
        version: 1,
        values,
        source_revision: row.revision,
    });
    report.disposition = PluginDisposition::Converted;
    Ok(report)
}

/// Inverse mapping targets the exact known source envelope. Unknown/new fields are
/// retained or refused, never silently discarded. Publication belongs to RM14.
pub fn reverse_state(
    entry_json: &str,
    original: &LegacyState,
    current: &BuiltinState,
) -> Result<LegacyState> {
    let converted = convert_state(entry_json, original)?
        .converted
        .ok_or(MigrationError::Unsupported)?;
    if current.key != converted.key
        || current.version != 1
        || current.source_revision != original.revision
    {
        return Err(MigrationError::Conflict);
    }
    let entry: Value = serde_json::from_str(entry_json).map_err(|_| MigrationError::InvalidData)?;
    let old = entry["manifest"]["version"] == "0.1.0";
    let mut values = current
        .values
        .as_object()
        .cloned()
        .ok_or(MigrationError::InvalidData)?;
    let mut output = original.clone();
    if old {
        let (from, to) = if original.key == "settings:form" {
            ("goal", "target")
        } else {
            ("visits", "runs")
        };
        if values.contains_key(to) {
            return Err(MigrationError::Conflict);
        }
        let value = values.remove(from).ok_or(MigrationError::InvalidData)?;
        values.insert(to.into(), value);
    }
    let raw = if original.key == "settings:form" {
        let mut envelope: Value =
            serde_json::from_str(&original.value_json).map_err(|_| MigrationError::InvalidData)?;
        envelope["values"] = Value::Object(values);
        envelope
    } else {
        Value::Object(values)
    };
    output.value_json = serde_json::to_string(&raw).map_err(|_| MigrationError::InvalidData)?;
    if convert_state(entry_json, &output)?.converted.is_none() {
        return Err(MigrationError::InvalidData);
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn known_checksums_versions_and_inverse() {
        let known: Vec<Known> = serde_json::from_str(KNOWN).unwrap();
        for k in known {
            let settings = k.settings_checksum.is_some();
            let old = k.manifest["version"] == "0.1.0";
            let values = if settings {
                serde_json::json!({"heading":"阅读 📚","enabled":true,if old {"target"} else {"goal"}:7})
            } else {
                serde_json::json!({if old {"runs"} else {"visits"}:3,"lastTitle":"书签","unknown":"retained"})
            };
            let raw = if settings {
                serde_json::json!({"format":"anynote.extension-settings.v1","schemaChecksum":k.settings_checksum,"values":values})
            } else {
                values
            };
            let row = LegacyState {
                extension_id: k.manifest["id"].as_str().unwrap().into(),
                key: if settings {
                    "settings:form"
                } else {
                    "script:state"
                }
                .into(),
                schema_version: if !settings && !old { 2 } else { 1 },
                revision: 9,
                value_json: raw.to_string(),
            };
            let mut entry = serde_json::json!({"manifest":k.manifest,"checksum":k.checksum});
            let result = convert_state(&entry.to_string(), &row).unwrap();
            assert_eq!(result.disposition, PluginDisposition::Converted);
            let reversed =
                reverse_state(&entry.to_string(), &row, &result.converted.unwrap()).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&reversed.value_json).unwrap(),
                raw
            );
            entry["checksum"] = Value::String("bad".into());
            assert_eq!(
                convert_state(&entry.to_string(), &row).unwrap().disposition,
                PluginDisposition::PreservedIncompatible
            );
            entry["manifest"]["version"] = Value::String("999".into());
            assert_eq!(
                convert_state(&entry.to_string(), &row).unwrap().disposition,
                PluginDisposition::PreservedUnknown
            );
        }
    }
}

#[derive(Debug, Serialize)]
#[non_exhaustive]
pub struct PreservedPlugins {
    pub files: std::collections::BTreeMap<String, String>,
    pub known_entries: Vec<String>,
    pub unknown_entries: Vec<String>,
}

/// Preserve the whole retired package directory, including unregistered downloads.
/// Unknown identities are a replacement-review requirement, never an install request.
pub fn preserve_plugins(
    source: &std::path::Path,
    destination: &std::path::Path,
    budget: u64,
) -> Result<PreservedPlugins> {
    super::preserve_directory(source, destination, budget)?;
    fn inventory(
        root: &std::path::Path,
        dir: &std::path::Path,
        out: &mut std::collections::BTreeMap<String, String>,
        remaining: &mut usize,
    ) -> Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                inventory(root, &entry.path(), out, remaining)?;
            } else {
                let bytes = super::read_bounded(&entry.path(), *remaining)?;
                *remaining -= bytes.len();
                out.insert(
                    entry
                        .path()
                        .strip_prefix(root)
                        .map_err(|_| MigrationError::InvalidData)?
                        .to_str()
                        .ok_or(MigrationError::InvalidData)?
                        .replace('\\', "/"),
                    digest(&bytes),
                );
            }
        }
        Ok(())
    }
    let mut report = PreservedPlugins {
        files: Default::default(),
        known_entries: Vec::new(),
        unknown_entries: Vec::new(),
    };
    inventory(
        destination,
        destination,
        &mut report.files,
        &mut usize::try_from(budget).map_err(|_| MigrationError::Budget)?,
    )?;
    let path = destination.join("registry.json");
    if !path.exists() {
        return Ok(report);
    }
    let registry: Vec<Value> =
        serde_json::from_slice(&super::read_bounded(&path, 8 * 1024 * 1024)?)
            .map_err(|_| MigrationError::InvalidData)?;
    if registry.len() > 64 {
        return Err(MigrationError::Budget);
    }
    let known: Vec<Known> = serde_json::from_str(KNOWN).map_err(|_| MigrationError::InvalidData)?;
    for entry in registry {
        let id = entry["manifest"]["id"]
            .as_str()
            .ok_or(MigrationError::InvalidData)?;
        if id.len() > 100 {
            return Err(MigrationError::InvalidData);
        }
        if is_known_business(&entry)
            || known.iter().any(|k| {
                k.manifest == entry["manifest"] && entry["checksum"].as_str() == Some(&k.checksum)
            })
        {
            report.known_entries.push(id.into());
        } else {
            report.unknown_entries.push(id.into());
        }
    }
    Ok(report)
}

/// Preserve the exact original row (including invalid/unknown JSON) before conversion.
/// Each notebook/revision gets a content-addressed file; resuming cannot overwrite it.
pub fn preserve_state(
    notebook_id: &str,
    row: &LegacyState,
    directory: &std::path::Path,
) -> Result<String> {
    use std::io::Write;
    if notebook_id.len() != 36
        || !notebook_id
            .bytes()
            .all(|c| c.is_ascii_hexdigit() || c == b'-')
        || row.extension_id.len() > 100
        || row.key.len() > 240
        || row.value_json.len() > 128 * 1024
        || !std::fs::symlink_metadata(directory)?.file_type().is_dir()
    {
        return Err(MigrationError::InvalidData);
    }
    let bytes=serde_json::to_vec(&serde_json::json!({"format":"anynote.preserved-plugin-state.v1","notebookId":notebook_id,"row":row})).map_err(|_| MigrationError::InvalidData)?;
    let hash = digest(&bytes);
    let name = format!("state.{notebook_id}.{hash}.json");
    let path = directory.join(&name);
    if path.exists() {
        if super::read_bounded(&path, 1024 * 1024)? != bytes {
            return Err(MigrationError::Conflict);
        }
    } else {
        let mut file = tempfile::NamedTempFile::new_in(directory)?;
        file.write_all(&bytes)?;
        file.as_file().sync_all()?;
        file.persist_noclobber(path)
            .map_err(|_| MigrationError::Io)?;
    }
    Ok(name)
}

#[cfg(test)]
mod preservation_tests {
    use super::*;
    #[test]
    fn unknown_and_invalid_state_bytes_survive_offline_preservation() {
        let dir = tempfile::tempdir().unwrap();
        let row = LegacyState {
            extension_id: "unknown.required".into(),
            key: "opaque:key".into(),
            schema_version: 42,
            revision: 17,
            value_json: "{unknown invalid JSON 数据".into(),
        };
        let notebook = "11111111-1111-4111-8111-111111111111";
        let name = preserve_state(notebook, &row, dir.path()).unwrap();
        assert_eq!(name, preserve_state(notebook, &row, dir.path()).unwrap());
        let saved: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(name)).unwrap()).unwrap();
        assert_eq!(saved["row"]["value_json"], row.value_json);
        assert_eq!(saved["row"]["revision"], 17);
        assert_eq!(
            convert_state(
                r#"{"manifest":{"id":"unknown.required","version":"42"}}"#,
                &row
            )
            .unwrap()
            .disposition,
            PluginDisposition::PreservedUnknown
        );
    }
}
