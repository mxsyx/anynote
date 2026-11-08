use super::*;
use anynote_storage::notebook::{SNAPSHOT_BYTES, asset_relative_path};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub const CHUNK_BYTES: u64 = 1024 * 1024;
pub const OBJECT_BYTES: u64 = 20 * 1024 * 1024;
pub const PART_BYTES: u64 = 32 * 1024 * 1024;
pub const RANGE_BYTES: u64 = 16 * 1024 * 1024;
pub const MANIFEST_BYTES: usize = 5 * 1024 * 1024;
pub const JS_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Object {
    pub sha256: String,
    pub size: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Database {
    pub chunk_size: u64,
    pub size: u64,
    pub sha256: String,
    pub chunks: Vec<Object>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotManifest {
    pub format: String,
    pub protocol_version: u64,
    pub schema_version: u64,
    pub notebook_id: String,
    pub source_notebook_id: String,
    #[serde(default)]
    pub notebook_name: String,
    pub snapshot_seq: u64,
    pub created_at: String,
    pub assets: Vec<Asset>,
    pub database: Database,
    pub generation_id: String,
    pub lineage_id: String,
    pub device_id: String,
    pub expected_head: String,
    pub writer_epoch: u64,
}

/// Keeps the Worker JSON.stringify bytes, including unknown fields and property order.
#[derive(Clone, Debug)]
pub struct Manifest {
    bytes: Vec<u8>,
    pub(crate) data: SnapshotManifest,
    objects: BTreeMap<String, u64>,
}
impl Manifest {
    pub fn parse(bytes: &[u8]) -> CloudResult<Self> {
        ensure(bytes.len() <= MANIFEST_BYTES, "MANIFEST_BUDGET")?;
        let value: Value = serde_json::from_slice(bytes)?;
        let bytes = stringify(&value)?.into_bytes();
        ensure(bytes.len() <= MANIFEST_BYTES, "MANIFEST_BUDGET")?;
        let data: SnapshotManifest = serde_json::from_slice(&bytes)?;
        ensure(
            data.format == "anynote.sqlite"
                && data.protocol_version == 1
                && data.schema_version == 5,
            "UNSUPPORTED_PROTOCOL",
        )?;
        ensure(
            [
                &data.notebook_id,
                &data.source_notebook_id,
                &data.generation_id,
                &data.lineage_id,
                &data.device_id,
            ]
            .iter()
            .all(|s| valid_uuid(s))
                && (data.expected_head.is_empty() || valid_uuid(&data.expected_head))
                && (1..=JS_SAFE).contains(&data.writer_epoch)
                && data.snapshot_seq <= JS_SAFE
                && !data.created_at.is_empty()
                && data.created_at.len() <= 100,
            "MANIFEST_IDENTITY",
        )?;
        let db = &data.database;
        ensure(
            db.chunk_size == CHUNK_BYTES
                && db.size > 0
                && db.size <= SNAPSHOT_BYTES
                && db.chunks.len() as u64 == db.size.div_ceil(CHUNK_BYTES)
                && hash_valid(&db.sha256),
            "DATABASE_LAYOUT",
        )?;
        let mut objects = BTreeMap::new();
        for (i, chunk) in db.chunks.iter().enumerate() {
            ensure(
                chunk.size == CHUNK_BYTES.min(db.size - i as u64 * CHUNK_BYTES),
                "DATABASE_LAYOUT",
            )?;
            add(&mut objects, &chunk.sha256, chunk.size)?;
        }
        ensure(data.assets.len() <= 100000, "ASSET_BUDGET")?;
        let mut paths = BTreeSet::new();
        let mut total = db.size;
        for a in &data.assets {
            ensure(
                a.path == asset_relative_path(&a.sha256)? && paths.insert(&a.path),
                "ASSET_PATH",
            )?;
            total = total
                .checked_add(a.size)
                .ok_or_else(|| CloudError::new("ASSET_BUDGET"))?;
            ensure(total <= SNAPSHOT_BYTES, "ASSET_BUDGET")?;
            add(&mut objects, &a.sha256, a.size)?;
        }
        // RM12 owns projection generation; existing committed TS projections remain restorable.
        if let Some(browse) = value.get("browse") {
            ensure(browse["version"] == 1, "BROWSE_VERSION")?;
            let list = browse["objects"]
                .as_array()
                .ok_or_else(|| CloudError::new("BROWSE_OBJECTS"))?;
            ensure(list.len() <= 30000, "BROWSE_BUDGET")?;
            let mut seen = BTreeSet::new();
            for o in list {
                let path = o["path"]
                    .as_str()
                    .ok_or_else(|| CloudError::new("BROWSE_PATH"))?;
                let parts: Vec<_> = path.split('/').collect();
                ensure(
                    (parts.len() == 2 && parts[0] == "note" && valid_uuid(parts[1]))
                        || (parts.len() == 3
                            && parts[0] == "tree"
                            && (parts[1] == "root" || valid_uuid(parts[1]))
                            && !parts[2].is_empty()
                            && parts[2].bytes().all(|c| c.is_ascii_digit())),
                    "BROWSE_PATH",
                )?;
                ensure(seen.insert(path), "BROWSE_PATH")?;
                extra(&mut objects, o, OBJECT_BYTES)?;
            }
        }
        if let Some(ack) = value.get("captureAcks") {
            extra(&mut objects, ack, 256 * 1024)?;
        }
        ensure(
            objects
                .values()
                .try_fold(0u64, |a, b| a.checked_add(*b))
                .is_some_and(|n| n <= SNAPSHOT_BYTES),
            "OBJECT_BUDGET",
        )?;
        Ok(Self {
            bytes,
            data,
            objects,
        })
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn data(&self) -> &SnapshotManifest {
        &self.data
    }
    pub fn objects(&self) -> &BTreeMap<String, u64> {
        &self.objects
    }
    pub fn hash(&self) -> String {
        digest(&self.bytes)
    }
}
fn extra(objects: &mut BTreeMap<String, u64>, v: &Value, limit: u64) -> CloudResult<()> {
    let hash = v["hash"]
        .as_str()
        .ok_or_else(|| CloudError::new("OBJECT_HASH"))?;
    let size = v["size"]
        .as_u64()
        .ok_or_else(|| CloudError::new("OBJECT_SIZE"))?;
    ensure(size <= limit, "OBJECT_SIZE")?;
    add(objects, hash, size)
}
fn add(objects: &mut BTreeMap<String, u64>, hash: &str, size: u64) -> CloudResult<()> {
    ensure(
        hash_valid(hash) && size <= SNAPSHOT_BYTES,
        "OBJECT_DESCRIPTOR",
    )?;
    ensure(
        objects.get(hash).is_none_or(|prior| *prior == size),
        "OBJECT_CONFLICT",
    )?;
    objects.insert(hash.into(), size);
    Ok(())
}
pub(crate) fn hash_valid(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// JSON.stringify ordering differs from capture canonical(): array-index keys first,
/// other keys in insertion order. Unsafe numbers must never acquire a rounded identity.
pub fn stringify(value: &Value) -> CloudResult<String> {
    Ok(match value {
        Value::Object(map) => {
            let mut indices = map
                .keys()
                .filter_map(|k| {
                    k.parse::<u32>()
                        .ok()
                        .filter(|n| *n < u32::MAX && n.to_string() == *k)
                        .map(|n| (n, k))
                })
                .collect::<Vec<_>>();
            indices.sort_by_key(|(n, _)| *n);
            let mut keys = indices.iter().map(|(_, k)| *k).collect::<Vec<_>>();
            let indexed: BTreeSet<_> = indices.iter().map(|(_, k)| *k).collect();
            keys.extend(map.keys().filter(|k| !indexed.contains(k)));
            let entries = keys
                .into_iter()
                .map(|k| {
                    Ok(format!(
                        "{}:{}",
                        serde_json::to_string(k)?,
                        stringify(&map[k])?
                    ))
                })
                .collect::<CloudResult<Vec<_>>>()?;
            format!("{{{}}}", entries.join(","))
        }
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(stringify)
                .collect::<CloudResult<Vec<_>>>()?
                .join(",")
        ),
        Value::Number(n) => {
            let f = n.as_f64().ok_or_else(|| CloudError::new("JSON_NUMBER"))?;
            ensure(
                f.is_finite() && f.abs() <= JS_SAFE as f64,
                "JSON_UNSAFE_NUMBER",
            )?;
            ryu_js::Buffer::new().format(f).into()
        }
        _ => serde_json::to_string(value)?,
    })
}
