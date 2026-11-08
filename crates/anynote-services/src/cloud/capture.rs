use super::*;
use crate::importer::{ImportInput, ImportOptions, ImportService, PreviewTarget, canonical};
use anynote_storage::notebook::{AppliedCapture, ReadErrorKind, WriteQueue};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::{Seek, SeekFrom, Write},
    path::Path,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturePairing {
    pub code: String,
    pub expires_at: u64,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureDevice {
    pub id: String,
    pub notebook_id: String,
    pub lineage_id: String,
    pub expires_at: u64,
    pub revoked: u8,
}
impl CloudClient {
    async fn capture_capability(&self, cancel: &CancellationToken) -> CloudResult<()> {
        ensure(
            self.test(cancel).await?.has("capture-v1"),
            "CAPTURE_UNSUPPORTED",
        )
    }
    pub async fn pair_capture_device(
        &self,
        notebook: &str,
        lineage: &str,
        cancel: &CancellationToken,
    ) -> CloudResult<CapturePairing> {
        ensure(
            valid_uuid(notebook) && valid_uuid(lineage),
            "CAPTURE_IDENTITY",
        )?;
        self.capture_capability(cancel).await?;
        let pairing: CapturePairing = serde_json::from_value(
            self.json(
                Method::POST,
                "/v1/pairings",
                Some(json!({"notebookId":notebook,"lineageId":lineage})),
                cancel,
            )
            .await?,
        )?;
        ensure(
            hash_valid(&pairing.code) && pairing.expires_at <= JS_SAFE,
            "PAIRING_RESPONSE",
        )?;
        Ok(pairing)
    }
    pub async fn capture_devices(
        &self,
        cancel: &CancellationToken,
    ) -> CloudResult<Vec<CaptureDevice>> {
        self.capture_capability(cancel).await?;
        let devices: Vec<CaptureDevice> =
            serde_json::from_value(self.json(Method::GET, "/v1/devices", None, cancel).await?)?;
        ensure(
            devices.len() <= 100
                && devices.iter().all(|d| {
                    valid_uuid(&d.id)
                        && valid_uuid(&d.notebook_id)
                        && valid_uuid(&d.lineage_id)
                        && d.expires_at <= JS_SAFE
                        && d.revoked <= 1
                }),
            "DEVICE_RESPONSE",
        )?;
        Ok(devices)
    }
    pub async fn revoke_capture_device(
        &self,
        id: &str,
        cancel: &CancellationToken,
    ) -> CloudResult<()> {
        ensure(valid_uuid(id), "CAPTURE_IDENTITY")?;
        self.capture_capability(cancel).await?;
        self.json(Method::DELETE, &format!("/v1/devices/{id}"), None, cancel)
            .await?;
        Ok(())
    }
    pub async fn pending_capture_acks(
        &self,
        notebook: &str,
        lineage: &str,
        cancel: &CancellationToken,
    ) -> CloudResult<Vec<String>> {
        ensure(
            valid_uuid(notebook) && valid_uuid(lineage),
            "CAPTURE_IDENTITY",
        )?;
        self.capture_capability(cancel).await?;
        let ids: Vec<String> = serde_json::from_value(
            self.json(
                Method::POST,
                "/v1/captures/pending-acks",
                Some(json!({"notebookId":notebook,"lineageId":lineage})),
                cancel,
            )
            .await?,
        )?;
        ensure(
            ids.len() <= 20 && ids.iter().all(|s| valid_uuid(s)),
            "CAPTURE_ACK_IDS",
        )?;
        Ok(ids)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Claim {
    id: String,
    claim_id: String,
    target_version: u64,
    parent_id: Option<String>,
    manifest: Value,
}
#[derive(Deserialize)]
struct Download {
    path: String,
    sha256: String,
    size: u64,
}
fn import_error(e: crate::importer::ImportError) -> CloudError {
    CloudError::new(if e.cancelled {
        "CANCELLED"
    } else {
        "CAPTURE_IMPORT"
    })
}

/// Execute on a service worker: ZIP work and the storage queue waits are blocking.
/// The transfer lease excludes a second consumer for this connection/writer identity.
pub async fn consume_captures(
    client: &CloudClient,
    session: &TransferSession,
    queue: &WriteQueue,
    local_notebook: &str,
    temporary_root: &Path,
    cancel: &CancellationToken,
) -> CloudResult<usize> {
    session.bind(client, Direction::Upload)?;
    ensure(valid_uuid(local_notebook), "CAPTURE_IDENTITY")?;
    ensure(session.pending()?.is_none(), "PENDING_UNRESOLVED")?;
    client.capture_capability(cancel).await?;
    let identity = session.identity();
    let writer = identity
        .writer
        .as_ref()
        .ok_or_else(|| CloudError::new("TRANSFER_WRITER"))?;
    let mut seen = Vec::new();
    for _ in 0..20 {
        check(cancel)?;
        let started = Instant::now();
        let value = client
            .json(
                Method::POST,
                "/v1/captures/claim",
                Some(json!({
                    "notebookId":identity.notebook_id,"lineageId":identity.lineage_id,
                    "deviceId":writer.device_id,"writerEpoch":writer.epoch,"exclude":seen
                })),
                cancel,
            )
            .await?;
        if value.is_null() {
            break;
        }
        let claim: Claim = serde_json::from_value(value)?;
        ensure(
            valid_uuid(&claim.id)
                && valid_uuid(&claim.claim_id)
                && (1..=JS_SAFE).contains(&claim.target_version)
                && claim.parent_id.as_deref().is_none_or(valid_uuid)
                && claim.manifest["captureId"] == claim.id,
            "CAPTURE_CLAIM",
        )?;
        ensure(!seen.contains(&claim.id), "CAPTURE_REPEATED_CLAIM")?;
        let canonical = canonical(&claim.manifest).map_err(import_error)?;
        ensure(canonical.len() <= 1024 * 1024, "CAPTURE_MANIFEST_BUDGET")?;
        let hash = digest(canonical.as_bytes());
        seen.push(claim.id.clone());
        let mut receipt = receipt_read(queue, local_notebook, &claim.id)?;
        if let Some(r) = &receipt {
            ensure(r.digest == hash, "CAPTURE_RECEIPT_CONFLICT")?;
        }
        if receipt.is_none() {
            if !target_valid(queue, local_notebook, claim.parent_id.clone())? {
                ack(client, &claim, None, started, cancel).await?;
                continue;
            }
            let file = download_capture(client, &claim, temporary_root, cancel).await?;
            let mut importer = ImportService::new(temporary_root).map_err(import_error)?;
            let target = PreviewTarget {
                notebook_id: local_notebook.into(),
                parent_id: claim.parent_id.clone(),
            };
            let preview = importer
                .preview(
                    target.clone(),
                    ImportInput::File {
                        file,
                        name: "capture.anyclip".into(),
                    },
                    ImportOptions::default(),
                    cancel,
                )
                .await
                .map_err(import_error)?;
            lease(started, cancel)?;
            if let Err(error) = importer.commit(queue, &target, &preview.id, cancel) {
                check(cancel)?;
                // The folder can disappear while downloading. Never redirect to the root.
                if !target_valid(queue, local_notebook, claim.parent_id.clone())? {
                    ack(client, &claim, None, started, cancel).await?;
                    continue;
                }
                return Err(import_error(error));
            }
            receipt = receipt_read(queue, local_notebook, &claim.id)?;
        }
        let applied = receipt.ok_or_else(|| CloudError::new("CAPTURE_RECEIPT_MISSING"))?;
        ensure(applied.digest == hash, "CAPTURE_RECEIPT_CONFLICT")?;
        ack(client, &claim, Some(&applied), started, cancel).await?;
    }
    Ok(seen.len())
}
fn receipt_read(queue: &WriteQueue, book: &str, id: &str) -> CloudResult<Option<AppliedCapture>> {
    let (book, id) = (book.to_owned(), id.to_owned());
    Ok(queue
        .submit(move |s| s.notebook(&book)?.read().capture_receipt(&id))?
        .wait()?)
}
fn target_valid(queue: &WriteQueue, book: &str, parent: Option<String>) -> CloudResult<bool> {
    let book = book.to_owned();
    // Opening an offline/corrupt notebook is not a stale target and must not change remote status.
    let result = queue
        .submit(move |s| {
            Ok(s.notebook(&book)?
                .validate_capture_target(parent.as_deref()))
        })?
        .wait()?;
    match result {
        Ok(()) => Ok(true),
        Err(e)
            if matches!(
                e.kind(),
                ReadErrorKind::NotFound | ReadErrorKind::InvalidInput
            ) =>
        {
            Ok(false)
        }
        Err(e) => Err(e.into()),
    }
}
fn lease(started: Instant, cancel: &CancellationToken) -> CloudResult<()> {
    check(cancel)?;
    ensure(
        started.elapsed() < Duration::from_secs(20 * 60),
        "CAPTURE_CLAIM_EXPIRED",
    )
}
async fn ack(
    client: &CloudClient,
    claim: &Claim,
    receipt: Option<&AppliedCapture>,
    started: Instant,
    cancel: &CancellationToken,
) -> CloudResult<()> {
    lease(started, cancel)?;
    let mut body = json!({"claimId":claim.claim_id,"targetVersion":claim.target_version});
    if let Some(r) = receipt {
        body["noteId"] = json!(r.note_id);
        body["appliedSeq"] = json!(r.applied_seq);
    } else {
        body["needsTarget"] = json!(true);
    }
    client
        .json(
            Method::POST,
            &format!("/v1/captures/{}/ack", claim.id),
            Some(body),
            cancel,
        )
        .await?;
    Ok(())
}
async fn download_capture(
    client: &CloudClient,
    claim: &Claim,
    root: &Path,
    cancel: &CancellationToken,
) -> CloudResult<std::fs::File> {
    let body: Download = serde_json::from_value(claim.manifest["body"].clone())?;
    let assets: Vec<Download> = serde_json::from_value(claim.manifest["assets"].clone())?;
    ensure(
        body.path == "content.md" && body.size <= 8 * 1024 * 1024 && assets.len() <= 200,
        "CAPTURE_OBJECT_BUDGET",
    )?;
    let mut total = body.size;
    let mut names = std::collections::BTreeSet::new();
    for a in &assets {
        let prefix = format!("assets/{}.", a.sha256);
        let ext = a.path.strip_prefix(&prefix).unwrap_or("");
        ensure(
            (1..=10).contains(&ext.len())
                && ext
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
                && names.insert(&a.path)
                && a.size <= OBJECT_BYTES,
            "CAPTURE_OBJECT",
        )?;
        total = total
            .checked_add(a.size)
            .ok_or_else(|| CloudError::new("CAPTURE_OBJECT_BUDGET"))?;
    }
    ensure(total <= 88 * 1024 * 1024, "CAPTURE_OBJECT_BUDGET")?;
    let file = tempfile::tempfile_in(root)?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .unix_permissions(0o600);
    zip.start_file("manifest.json", options)
        .map_err(|_| CloudError::new("CAPTURE_ZIP"))?;
    zip.write_all(&serde_json::to_vec(&claim.manifest)?)?;
    for a in std::iter::once(&body).chain(assets.iter()) {
        ensure(hash_valid(&a.sha256), "CAPTURE_OBJECT")?;
        let (_, _, bytes) = client
            .request(
                Method::GET,
                &format!("/v1/captures/{}/objects/{}", claim.id, a.sha256),
                None,
                None,
                a.size as usize,
                cancel,
            )
            .await?;
        ensure(
            bytes.len() as u64 == a.size && digest(&bytes) == a.sha256,
            "CAPTURE_OBJECT_HASH",
        )?;
        zip.start_file(&a.path, options)
            .map_err(|_| CloudError::new("CAPTURE_ZIP"))?;
        zip.write_all(&bytes)?;
    }
    let mut file = zip.finish().map_err(|_| CloudError::new("CAPTURE_ZIP"))?;
    file.seek(SeekFrom::Start(0))?;
    Ok(file)
}
