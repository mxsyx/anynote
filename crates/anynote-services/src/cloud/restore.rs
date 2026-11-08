use super::*;
use crate::archive::sync_tree;
use anynote_storage::notebook::*;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[derive(Serialize, Deserialize)]
struct Publication {
    root: String,
    id: String,
    database_hash: String,
}

/// Restore to a new local UUID. The remote notebook/lineage never becomes the new
/// local writer identity. The caller retains this session for interrupted retries.
pub async fn restore(
    client: &CloudClient,
    session: &mut TransferSession,
    generation: &str,
    root: &Path,
    cancel: &CancellationToken,
) -> CloudResult<NotebookMeta> {
    session.bind(client, Direction::Download)?;
    ensure(valid_uuid(generation), "GENERATION_IDENTITY")?;
    let caps = client.test(cancel).await?;
    ensure(caps.has("transfer-resume-v1"), "RESUME_UNSUPPORTED")?;
    let base = format!(
        "/v1/notebooks/{}/backups/{generation}",
        session.identity().notebook_id
    );
    let pin_path = format!("{base}/pin");
    let pin_id = uuid::Uuid::new_v4().to_string();
    let pinned = caps.has("restore-pin");
    if pinned {
        let acquired = client
            .json(
                Method::POST,
                &pin_path,
                Some(json!({"pinId":pin_id})),
                cancel,
            )
            .await;
        if let Err(error) = acquired {
            let _ = client
                .json(
                    Method::DELETE,
                    &pin_path,
                    Some(json!({"pinId":pin_id})),
                    &CancellationToken::new(),
                )
                .await;
            return Err(error);
        }
    }
    let work_cancel = cancel.child_token();
    let result = {
        let future = restore_inner(client, session, generation, &base, root, &work_cancel);
        tokio::pin!(future);
        let mut timer = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(30),
            Duration::from_secs(30),
        );
        loop {
            tokio::select! { biased;
                _ = cancel.cancelled() => { work_cancel.cancel(); let _ = future.as_mut().await; break Err(CloudError::new("CANCELLED")); },
                _ = timer.tick(), if pinned => {
                    if let Err(e) = client.json(Method::POST, &pin_path, Some(json!({"pinId":pin_id})), cancel).await { work_cancel.cancel(); let _ = future.as_mut().await; break Err(e); }
                },
                result = &mut future => break result,
            }
        }
    };
    work_cancel.cancel();
    if pinned {
        // Use a fresh cancellation scope: an aborted restore must still release its pin.
        let _ = client
            .json(
                Method::DELETE,
                &pin_path,
                Some(json!({"pinId":pin_id})),
                &CancellationToken::new(),
            )
            .await;
    }
    result
}
async fn restore_inner(
    client: &CloudClient,
    session: &TransferSession,
    generation: &str,
    base: &str,
    root: &Path,
    cancel: &CancellationToken,
) -> CloudResult<NotebookMeta> {
    let (_, _, bytes) = client
        .request(
            Method::GET,
            &format!("{base}/manifest"),
            None,
            None,
            MANIFEST_BYTES,
            cancel,
        )
        .await?;
    let manifest = Manifest::parse(&bytes)?;
    session.identity().matches(&manifest)?;
    ensure(
        manifest.data.generation_id == generation,
        "GENERATION_IDENTITY",
    )?;
    let cut = manifest.hash();
    let previous = session.read::<String>(&format!("download.manifest.{generation}"))?;
    ensure(
        previous.as_ref().is_none_or(|hash| hash == &cut),
        "COMMITTED_MANIFEST_CONFLICT",
    )?;
    session.write(&format!("download.manifest.{generation}"), &cut)?;
    fs::create_dir_all(root)?;
    let canonical_root = root.canonicalize()?.to_string_lossy().into_owned();
    let receipt_key = format!(
        "download.publish.{cut}.{}",
        digest(canonical_root.as_bytes())
    );
    if let Some(prior) = session.read::<Publication>(&receipt_key)? {
        ensure(
            prior.root == canonical_root && valid_uuid(&prior.id),
            "RESTORE_RECEIPT",
        )?;
        let target = checked_local_path(root, &prior.id)?;
        if target.exists() {
            let assets = manifest.data.assets.clone();
            let work_cancel = cancel.clone();
            return tokio::task::spawn_blocking(move || {
                let book = ReadonlyNotebook::open(&target, Some(&prior.id))?;
                book.integrity_check()?;
                ensure(
                    hash_file(&target.join("notebook.sqlite"), None, &work_cancel)?
                        == prior.database_hash,
                    "RESTORED_COPY_CHANGED",
                )?;
                for a in &assets {
                    ensure(
                        hash_file(
                            &checked_local_path(&target, &a.path)?,
                            Some(a.size),
                            &work_cancel,
                        )? == a.sha256,
                        "RESTORED_COPY_CHANGED",
                    )?;
                }
                check(&work_cancel)?;
                Ok(book.metadata().clone())
            })
            .await
            .map_err(|_| CloudError::new("RESTORE_WORKER"))?;
        }
    }
    let stage = tempfile::Builder::new()
        .prefix("anynote.restore.")
        .tempdir_in(root)?;
    let m = &manifest.data;
    let object_base = format!("/v1/notebooks/{}/objects", m.notebook_id);
    let mut db = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(stage.path().join("notebook.sqlite"))?;
    let mut db_hash = Sha256::new();
    for chunk in &m.database.chunks {
        tokio::task::yield_now().await;
        check(cancel)?;
        let name = format!("download.{cut}/chunk.{}", chunk.sha256);
        let cache = session.path(&name)?;
        let cached = File::open(&cache).ok().and_then(|f| {
            let mut bytes = Vec::new();
            f.take(chunk.size + 1).read_to_end(&mut bytes).ok()?;
            (bytes.len() as u64 == chunk.size && digest(&bytes) == chunk.sha256).then_some(bytes)
        });
        let bytes = if let Some(bytes) = cached {
            bytes
        } else {
            let (_, _, bytes) = client
                .request(
                    Method::GET,
                    &format!("{object_base}/{}", chunk.sha256),
                    None,
                    None,
                    chunk.size as usize,
                    cancel,
                )
                .await?;
            ensure(
                bytes.len() as u64 == chunk.size && digest(&bytes) == chunk.sha256,
                "CHUNK_HASH",
            )?;
            session.write_bytes(&name, &bytes)?;
            bytes
        };
        db_hash.update(&bytes);
        db.write_all(&bytes)?;
    }
    ensure(
        format!("{:x}", db_hash.finalize()) == m.database.sha256,
        "DATABASE_HASH",
    )?;
    db.sync_all()?;
    drop(db);
    for a in &m.assets {
        let cache = download_asset(client, session, &cut, &object_base, a, cancel).await?;
        check(cancel)?;
        let destination = checked_local_path(stage.path(), &a.path)?;
        fs::create_dir_all(destination.parent().unwrap())?;
        let size = a.size;
        let hash = a.sha256.clone();
        let work_cancel = cancel.clone();
        tokio::task::spawn_blocking(move || {
            copy_checked(&cache, &destination, size, &hash, &work_cancel)
        })
        .await
        .map_err(|_| CloudError::new("RESTORE_WORKER"))??;
    }
    check(cancel)?;
    let source_id = m.source_notebook_id.clone();
    let expected_assets = m
        .assets
        .iter()
        .map(|a| (a.sha256.clone(), a.size))
        .collect::<std::collections::BTreeMap<_, _>>();
    let work_cancel = cancel.clone();
    let (stage, meta, database_hash) = tokio::task::spawn_blocking(move || -> CloudResult<_> {
        check(&work_cancel)?;
        let book = ReadonlyNotebook::open(stage.path(), Some(&source_id))?;
        book.integrity_check()?;
        let assets = book.assets()?;
        ensure(
            assets.len() == expected_assets.len()
                && assets
                    .iter()
                    .all(|a| expected_assets.get(&a.hash) == Some(&a.size)),
            "DATABASE_ASSET_CLOSURE",
        )?;
        for a in &assets {
            check(&work_cancel)?;
            book.asset_by_hash(&a.hash)?;
        }
        drop(book);
        check(&work_cancel)?;
        let meta = remap_imported_notebook(stage.path(), &source_id)?;
        File::open(stage.path().join("notebook.sqlite"))?.sync_all()?;
        sync_tree(stage.path())?;
        let database_hash = hash_file(&stage.path().join("notebook.sqlite"), None, &work_cancel)?;
        Ok((stage, meta, database_hash))
    })
    .await
    .map_err(|_| CloudError::new("RESTORE_WORKER"))??;
    check(cancel)?;
    let target = checked_local_path(root, &meta.id)?;
    ensure(!target.exists(), "RESTORE_TARGET_EXISTS")?;
    session.write(
        &receipt_key,
        &Publication {
            root: canonical_root,
            id: meta.id.clone(),
            database_hash,
        },
    )?;
    check(cancel)?;
    fs::rename(stage.path(), target)?;
    sync_directory(root)?;
    Ok(meta)
}
async fn download_asset(
    client: &CloudClient,
    session: &TransferSession,
    cut: &str,
    base: &str,
    asset: &Asset,
    cancel: &CancellationToken,
) -> CloudResult<std::path::PathBuf> {
    let key = format!("download.ranges.{cut}.{}", asset.sha256);
    let saved = session.read::<Vec<String>>(&key)?.unwrap_or_default();
    let path = session.path(&format!("download.{cut}/asset.{}", asset.sha256))?;
    fs::create_dir_all(path.parent().unwrap())?;
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)?;
    let count = asset.size.div_ceil(RANGE_BYTES) as usize;
    let mut hashes = Vec::new();
    for prior in saved.iter().take(count) {
        tokio::task::yield_now().await;
        check(cancel)?;
        let size = RANGE_BYTES.min(asset.size - hashes.len() as u64 * RANGE_BYTES);
        let mut bytes = vec![0; size as usize];
        if file.read_exact(&mut bytes).is_err() || digest(&bytes) != *prior {
            break;
        }
        hashes.push(prior.clone());
    }
    let mut offset = (hashes.len() as u64 * RANGE_BYTES).min(asset.size);
    file.set_len(offset)?;
    file.seek(SeekFrom::Start(offset))?;
    for _ in hashes.len()..count {
        check(cancel)?;
        let size = RANGE_BYTES.min(asset.size - offset);
        let (_, _, bytes) = client
            .request(
                Method::GET,
                &format!("{base}/{}", asset.sha256),
                None,
                Some((offset, size, asset.size)),
                size as usize,
                cancel,
            )
            .await?;
        ensure(bytes.len() as u64 == size, "RANGE_SIZE")?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        hashes.push(digest(&bytes));
        session.write(&key, &hashes)?;
        offset += size;
    }
    drop(file);
    let verify_path = path.clone();
    let verify_cancel = cancel.clone();
    let size = asset.size;
    let hash =
        tokio::task::spawn_blocking(move || hash_file(&verify_path, Some(size), &verify_cancel))
            .await
            .map_err(|_| CloudError::new("RESTORE_WORKER"))??;
    if hash != asset.sha256 {
        session.write(&key, &Vec::<String>::new())?;
        fs::remove_file(&path)?;
        return Err(CloudError::new("ASSET_HASH"));
    }
    Ok(path)
}
fn copy_checked(
    source: &Path,
    destination: &Path,
    size: u64,
    hash: &str,
    cancel: &CancellationToken,
) -> CloudResult<()> {
    let mut source = File::open(source)?;
    let mut dest = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)?;
    let mut hasher = Sha256::new();
    let mut total = 0;
    let mut bytes = vec![0; 64 * 1024];
    loop {
        check(cancel)?;
        let n = source.read(&mut bytes)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        ensure(total <= size, "ASSET_SIZE")?;
        hasher.update(&bytes[..n]);
        dest.write_all(&bytes[..n])?;
    }
    ensure(
        total == size && format!("{:x}", hasher.finalize()) == hash,
        "ASSET_HASH",
    )?;
    dest.sync_all()?;
    Ok(())
}
fn hash_file(path: &Path, size: Option<u64>, cancel: &CancellationToken) -> CloudResult<String> {
    let mut file = File::open(path)?;
    ensure(
        file.metadata()?.is_file()
            && size.is_none_or(|n| file.metadata().is_ok_and(|m| m.len() == n)),
        "FILE_SIZE",
    )?;
    let mut hasher = Sha256::new();
    let mut bytes = vec![0; 64 * 1024];
    let mut total = 0;
    loop {
        check(cancel)?;
        let n = file.read(&mut bytes)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        ensure(total <= SNAPSHOT_BYTES, "FILE_BUDGET")?;
        hasher.update(&bytes[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
