use super::*;
use anynote_storage::notebook::*;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::Path,
};
use tokio_util::sync::CancellationToken;

/// Prepare one durable immutable cut. Resolve an existing pending generation first.
pub fn prepare_upload(
    session: &mut TransferSession,
    frozen: &mut FrozenSnapshot,
    expected_head: &str,
    created_at: &str,
    cancel: &Cancellation,
) -> CloudResult<Manifest> {
    prepare_upload_with_captures(session, frozen, expected_head, created_at, &[], cancel)
}

/// Receipt IDs are selected remotely before freezing; evidence is read only from the cut.
pub fn prepare_upload_with_captures(
    session: &mut TransferSession,
    frozen: &mut FrozenSnapshot,
    expected_head: &str,
    created_at: &str,
    pending_captures: &[String],
    cancel: &Cancellation,
) -> CloudResult<Manifest> {
    ensure(
        pending_captures.len() <= 20 && pending_captures.iter().all(|id| valid_uuid(id)),
        "CAPTURE_ACK_IDS",
    )?;
    ensure(
        session.identity().direction == Direction::Upload && session.pending()?.is_none(),
        "PENDING_UNRESOLVED",
    )?;
    if frozen.mode().is_none() {
        frozen.prepare(SnapshotMode::Full, cancel)?;
    }
    ensure(frozen.mode() == Some(SnapshotMode::Full), "SNAPSHOT_MODE")?;
    let book = ReadonlyNotebook::open(frozen.path(), Some(frozen.notebook_id()))?;
    let meta = book.metadata();
    ensure(
        meta.content_seq >= 0 && meta.content_seq as u64 <= JS_SAFE,
        "SNAPSHOT_SEQUENCE",
    )?;
    let mut database = File::open(checked_local_path(frozen.path(), "notebook.sqlite")?)?;
    let size = database.metadata()?.len();
    ensure(size > 0 && size <= SNAPSHOT_BYTES, "DATABASE_BUDGET")?;
    let mut whole = Sha256::new();
    let mut chunks = Vec::new();
    let mut remaining = size;
    while remaining > 0 {
        cancel.check()?;
        let mut bytes = vec![0; CHUNK_BYTES.min(remaining) as usize];
        database.read_exact(&mut bytes)?;
        whole.update(&bytes);
        let hash = digest(&bytes);
        session.write_bytes(&format!("objects/{hash}"), &bytes)?;
        chunks.push(Object {
            sha256: hash,
            size: bytes.len() as u64,
        });
        remaining -= bytes.len() as u64;
    }
    let mut assets = Vec::new();
    for asset in book.assets()? {
        cancel.check()?;
        let path = asset_relative_path(&asset.hash)?;
        store_object(
            session,
            &asset.hash,
            asset.size,
            &checked_local_path(frozen.path(), &path)?,
            cancel,
        )?;
        assets.push(Asset {
            path,
            size: asset.size,
            sha256: asset.hash,
            mime_type: Some(asset.mime),
        });
    }
    let writer = session
        .identity()
        .writer
        .as_ref()
        .ok_or_else(|| CloudError::new("TRANSFER_WRITER"))?;
    let data = SnapshotManifest {
        format: "anynote.sqlite".into(),
        protocol_version: 1,
        schema_version: 5,
        notebook_id: session.identity().notebook_id.clone(),
        source_notebook_id: frozen.notebook_id().into(),
        notebook_name: meta.name.clone(),
        snapshot_seq: meta.content_seq as u64,
        created_at: created_at.into(),
        assets,
        database: Database {
            chunk_size: CHUNK_BYTES,
            size,
            sha256: format!("{:x}", whole.finalize()),
            chunks,
        },
        generation_id: uuid::Uuid::new_v4().to_string(),
        lineage_id: session.identity().lineage_id.clone(),
        device_id: writer.device_id.clone(),
        expected_head: expected_head.into(),
        writer_epoch: writer.epoch,
    };
    let (browse, acks) = super::browse::project(session, &book, pending_captures, cancel)?;
    let mut value = serde_json::to_value(&data)?;
    if let Some(browse) = browse {
        value["browse"] = browse;
    }
    value["captureAcks"] = acks;
    let manifest = Manifest::parse(&serde_json::to_vec(&value)?)?;
    cancel.check()?;
    session.begin(&manifest)?;
    Ok(manifest)
}

/// Adopts a frozen TS manifest without reconstructing its field order or generation.
/// Source objects are hash-named files in an explicitly supplied private directory.
pub fn prepare_manifest(
    session: &mut TransferSession,
    manifest: &Manifest,
    objects: &Path,
    cancel: &Cancellation,
) -> CloudResult<()> {
    upload_allowed(session)?;
    ensure(
        session.identity().direction == Direction::Upload && session.pending()?.is_none(),
        "PENDING_UNRESOLVED",
    )?;
    session.identity().matches(manifest)?;
    for (hash, size) in manifest.objects() {
        store_object(
            session,
            hash,
            *size,
            &checked_local_path(objects, hash)?,
            cancel,
        )?;
    }
    session.begin(manifest)
}
fn store_object(
    session: &TransferSession,
    hash: &str,
    size: u64,
    source: &Path,
    cancel: &Cancellation,
) -> CloudResult<()> {
    ensure(
        hash_valid(hash) && size <= SNAPSHOT_BYTES,
        "OBJECT_DESCRIPTOR",
    )?;
    let path = session.path(&format!("objects/{hash}"))?;
    fs::create_dir_all(path.parent().unwrap())?;
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
    let mut input = File::open(source)?;
    ensure(
        input.metadata()?.is_file() && input.metadata()?.len() == size,
        "SOURCE_CHANGED",
    )?;
    let mut hasher = Sha256::new();
    let mut total = 0;
    let mut bytes = vec![0; 64 * 1024];
    loop {
        cancel.check()?;
        let n = input.read(&mut bytes)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        ensure(total <= size, "SOURCE_CHANGED")?;
        hasher.update(&bytes[..n]);
        temp.write_all(&bytes[..n])?;
    }
    ensure(
        total == size && format!("{:x}", hasher.finalize()) == hash,
        "SOURCE_CHANGED",
    )?;
    temp.as_file().sync_all()?;
    temp.persist(&path).map_err(|e| CloudError::from(e.error))?;
    sync_directory(path.parent().unwrap())?;
    Ok(())
}

async fn confirmed(
    client: &CloudClient,
    manifest: &Manifest,
    cancel: &CancellationToken,
) -> CloudResult<bool> {
    let m = &manifest.data;
    let status = match client
        .json(
            Method::GET,
            &format!("/v1/notebooks/{}/backup/{}", m.notebook_id, m.generation_id),
            None,
            cancel,
        )
        .await
    {
        Err(e) if e.status == Some(404) => return Ok(false),
        other => other?,
    };
    ensure(
        status["id"] == m.generation_id && status["snapshotSeq"] == m.snapshot_seq,
        "GENERATION_IDENTITY",
    )?;
    if status["status"] == "staging" {
        return Ok(false);
    }
    ensure(status["status"] == "committed", "GENERATION_STATUS")?;
    let (_, _, raw) = client
        .request(
            Method::GET,
            &format!(
                "/v1/notebooks/{}/backups/{}/manifest",
                m.notebook_id, m.generation_id
            ),
            None,
            None,
            MANIFEST_BYTES,
            cancel,
        )
        .await?;
    ensure(
        Manifest::parse(&raw)?.bytes() == manifest.bytes(),
        "COMMITTED_MANIFEST_CONFLICT",
    )?;
    Ok(true)
}
/// Confirmation runs before plan and after commit errors. Cursor advances only on a
/// byte-identical committed manifest; failures leave pendingGeneration durable.
pub async fn resume_upload(
    client: &CloudClient,
    session: &mut TransferSession,
    cancel: &CancellationToken,
) -> CloudResult<CloudCursor> {
    session.bind(client, Direction::Upload)?;
    upload_allowed(session)?;
    let manifest = session
        .pending()?
        .ok_or_else(|| CloudError::new("NO_PENDING_GENERATION"))?;
    let caps = client.test(cancel).await?;
    ensure(caps.has("transfer-resume-v1"), "RESUME_UNSUPPORTED")?;
    if confirmed(client, &manifest, cancel).await? {
        return finish(session, &manifest);
    }
    let m = &manifest.data;
    let base = format!("/v1/notebooks/{}/backup", m.notebook_id);
    let plan = client
        .json_bytes(
            Method::POST,
            &format!("{base}/plan"),
            Some(manifest.bytes().to_vec()),
            cancel,
        )
        .await?;
    let missing = plan["missing"]
        .as_array()
        .ok_or_else(|| CloudError::new("INVALID_PLAN"))?;
    let mut seen = std::collections::BTreeSet::new();
    for hash in missing {
        check(cancel)?;
        let hash = hash
            .as_str()
            .ok_or_else(|| CloudError::new("INVALID_PLAN"))?;
        ensure(seen.insert(hash), "INVALID_PLAN")?;
        let size = *manifest
            .objects()
            .get(hash)
            .ok_or_else(|| CloudError::new("PLAN_UNKNOWN_OBJECT"))?;
        let path = format!("{base}/{}/objects/{hash}", m.generation_id);
        if size <= OBJECT_BYTES {
            let bytes = read_object(session, hash, size)?;
            client
                .json_bytes(Method::PUT, &path, Some(bytes), cancel)
                .await?;
        } else {
            multipart(client, session, &m.generation_id, &path, hash, size, cancel).await?;
        }
    }
    check(cancel)?;
    let outcome = client
        .json(
            Method::POST,
            &format!("{base}/{}/commit", m.generation_id),
            Some(json!({"expectedHead":m.expected_head,"writerEpoch":m.writer_epoch})),
            cancel,
        )
        .await;
    // Cancellation can race a successful remote commit. Preserve pending and reconcile on retry.
    if let Err(error) = outcome {
        if error.cancelled() {
            return Err(error);
        }
        if !confirmed(client, &manifest, cancel).await? {
            return Err(error);
        }
    } else {
        ensure(
            confirmed(client, &manifest, cancel).await?,
            "COMMIT_UNCONFIRMED",
        )?;
    }
    finish(session, &manifest)
}
fn finish(session: &TransferSession, manifest: &Manifest) -> CloudResult<CloudCursor> {
    let result = session.committed(manifest)?;
    // Only this acknowledged cut's owned files are eligible; a cleanup failure is harmless.
    for hash in manifest.objects().keys() {
        if let Ok(path) = session.path(&format!("objects/{hash}")) {
            let _ = fs::remove_file(path);
        }
    }
    Ok(result)
}
/// Explicitly abandon staging only after checking whether it already committed.
pub async fn abandon_upload(
    client: &CloudClient,
    session: &mut TransferSession,
    cancel: &CancellationToken,
) -> CloudResult<CloudCursor> {
    session.bind(client, Direction::Upload)?;
    let manifest = session
        .pending()?
        .ok_or_else(|| CloudError::new("NO_PENDING_GENERATION"))?;
    if confirmed(client, &manifest, cancel).await? {
        return finish(session, &manifest);
    }
    let mut cursor = session.cursor()?;
    cursor.pending_generation = None;
    cursor.pending_manifest_hash = None;
    session.write("upload.cursor", &cursor)?;
    Ok(cursor)
}
fn read_object(session: &TransferSession, hash: &str, size: u64) -> CloudResult<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(session.path(&format!("objects/{hash}"))?)?
        .take(size + 1)
        .read_to_end(&mut bytes)?;
    ensure(
        bytes.len() as u64 == size && digest(&bytes) == hash,
        "SOURCE_CHANGED",
    )?;
    Ok(bytes)
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Part {
    part_number: u64,
    etag: String,
    sha256: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Multipart {
    upload_id: String,
    parts: Vec<Part>,
}
async fn multipart(
    client: &CloudClient,
    session: &TransferSession,
    generation: &str,
    path: &str,
    hash: &str,
    size: u64,
    cancel: &CancellationToken,
) -> CloudResult<()> {
    let key = format!("upload.parts.{generation}.{hash}");
    for attempt in 0..2 {
        let mut saved = match session.read::<Multipart>(&key)? {
            Some(saved) => saved,
            None => {
                let response = client
                    .json(Method::POST, &format!("{path}/multipart"), None, cancel)
                    .await?;
                let upload_id = response["uploadId"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 2048)
                    .ok_or_else(|| CloudError::new("UPLOAD_ID"))?
                    .to_owned();
                let saved = Multipart {
                    upload_id,
                    parts: vec![],
                };
                session.write(&key, &saved)?;
                saved
            }
        };
        let id: String = url::form_urlencoded::byte_serialize(saved.upload_id.as_bytes()).collect();
        let endpoint = format!("{path}/multipart/{id}");
        let result: CloudResult<()> = async {
            let mut file = File::open(session.path(&format!("objects/{hash}"))?)?;
            ensure(file.metadata()?.len() == size, "SOURCE_CHANGED")?;
            let mut hasher = Sha256::new();
            let mut parts = Vec::new();
            for i in 0..size.div_ceil(PART_BYTES) {
                check(cancel)?;
                let mut bytes = vec![0; PART_BYTES.min(size - i * PART_BYTES) as usize];
                file.read_exact(&mut bytes)?;
                hasher.update(&bytes);
                let sha256 = digest(&bytes);
                if let Some(prior) = saved.parts.get(i as usize) {
                    ensure(
                        prior.part_number == i + 1 && prior.sha256 == sha256,
                        "SOURCE_CHANGED",
                    )?;
                }
                // v1 has no list-parts endpoint: idempotently PUT each part to confirm R2 state.
                let part = client
                    .json_bytes(
                        Method::PUT,
                        &format!("{endpoint}/{}", i + 1),
                        Some(bytes),
                        cancel,
                    )
                    .await?;
                ensure(part["partNumber"] == i + 1, "PART_NUMBER")?;
                let etag = part["etag"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 1024)
                    .ok_or_else(|| CloudError::new("PART_ETAG"))?
                    .to_owned();
                parts.push(Part {
                    part_number: i + 1,
                    etag,
                    sha256,
                });
                saved.parts = parts
                    .iter()
                    .map(|p| Part {
                        part_number: p.part_number,
                        etag: p.etag.clone(),
                        sha256: p.sha256.clone(),
                    })
                    .collect();
                session.write(&key, &saved)?;
            }
            ensure(format!("{:x}", hasher.finalize()) == hash, "SOURCE_CHANGED")?;
            client
                .json(
                    Method::POST,
                    &endpoint,
                    Some(json!({"parts":parts})),
                    cancel,
                )
                .await?;
            Ok(())
        }
        .await;
        match result {
            Err(e) if e.code == "UPLOAD_SESSION_MISSING" && attempt == 0 => {
                fs::remove_file(session.path(&format!("{key}.json"))?)?;
            }
            other => return other,
        }
    }
    Err(CloudError::new("UPLOAD_SESSION_MISSING"))
}
