//! Backend upload staging and revision-scoped image operations on the storage queue.
use super::codec;
use anynote_core::{backend::*, document_session::DocumentId, image::*};
use anynote_storage::notebook::*;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use uuid::Uuid;

struct Upload {
    document: DocumentId,
    name: String,
    bytes: Vec<u8>,
    mime: Option<String>,
    touched: Instant,
}
#[derive(Default)]
pub(crate) struct Uploads {
    entries: HashMap<Uuid, Upload>,
    reads: HashMap<Uuid, (VerifiedAsset, Instant)>,
}
fn invalid() -> ServiceError {
    ServiceError::new(ErrorCode::InvalidRequest)
}
fn storage(error: ReadError) -> ServiceError {
    ServiceError::new(match error.kind() {
        ReadErrorKind::Conflict => ErrorCode::Conflict,
        ReadErrorKind::NotFound => ErrorCode::NotFound,
        ReadErrorKind::InvalidInput | ReadErrorKind::InvalidRange => ErrorCode::InvalidRequest,
        _ => ErrorCode::Storage,
    })
}
impl Uploads {
    pub fn resources(
        &self,
        document: &DocumentId,
        resources: &[Uuid],
    ) -> ServiceResult<Vec<ResourceWrite>> {
        if resources.len() > 32 {
            return Err(invalid());
        }
        resources
            .iter()
            .map(|id| {
                let upload = self
                    .entries
                    .get(id)
                    .filter(|s| &s.document == document)
                    .ok_or_else(invalid)?;
                let mime = upload.mime.clone().ok_or_else(invalid)?;
                ResourceWrite::bytes(
                    id.to_string(),
                    upload.name.clone(),
                    mime,
                    upload.bytes.clone(),
                )
                .map_err(storage)
            })
            .collect()
    }
    pub async fn execute(
        &mut self,
        command: ImageCommand,
        queue: &WriteQueue,
    ) -> ServiceResult<ImageReply> {
        self.entries
            .retain(|_, s| s.touched.elapsed() < Duration::from_secs(30 * 60));
        self.reads
            .retain(|_, (_, touched)| touched.elapsed() < Duration::from_secs(60));
        match command {
            ImageCommand::BeginRead { scope, token } => {
                if self.reads.len() >= 16 || self.reads.contains_key(&token) {
                    return Err(invalid());
                }
                let ticket = queue
                    .submit(move |catalog| {
                        let note = scope.document.note().to_string();
                        let revision = scope.revision.to_string();
                        catalog
                            .notebook(&scope.document.notebook().to_string())?
                            .read()
                            .resource(
                                &scope.resource.to_string(),
                                Some(ResourceScope::note(&note).with_revision(&revision)),
                            )
                    })
                    .map_err(storage)?;
                let asset = tokio::task::spawn_blocking(move || ticket.wait())
                    .await
                    .map_err(|_| ServiceError::new(ErrorCode::Storage))?
                    .map_err(storage)?;
                let info = asset.info().clone();
                if info.size > codec::MAX_BYTES as u64 {
                    return Err(invalid());
                }
                self.reads.insert(token, (asset, Instant::now()));
                return Ok(ImageReply::Info {
                    hash: info.hash,
                    length: info.size,
                    mime: info.mime,
                });
            }
            ImageCommand::Read {
                token,
                offset,
                length,
            } => {
                if length == 0 || length as usize > MAX_CHUNK_BYTES {
                    return Err(invalid());
                }
                let (asset, touched) = self
                    .reads
                    .get_mut(&token)
                    .ok_or_else(|| ServiceError::new(ErrorCode::InvalidToken))?;
                *touched = Instant::now();
                let hash = asset.info().hash.clone();
                return Ok(ImageReply::Chunk {
                    bytes: asset
                        .read_range(&hash, offset, length as usize)
                        .map_err(storage)?,
                });
            }
            ImageCommand::EndRead { token } => {
                self.reads.remove(&token);
                return Ok(ImageReply::Ack);
            }
            ImageCommand::Release {
                document,
                resources,
            } => {
                for id in resources {
                    if self
                        .entries
                        .get(&id)
                        .is_some_and(|s| s.document == document)
                    {
                        self.entries.remove(&id);
                    }
                }
                return Ok(ImageReply::Ack);
            }
            ImageCommand::Upload {
                document,
                resource,
                name,
                offset,
                bytes,
                complete,
            } => {
                if bytes.len() > MAX_CHUNK_BYTES
                    || name.chars().count() > 240
                    || self.entries.values().map(|s| s.bytes.len()).sum::<usize>() + bytes.len()
                        > 100 * 1024 * 1024
                {
                    return Err(invalid());
                }
                if offset == 0 {
                    if self.entries.len() >= 32 || self.entries.contains_key(&resource) {
                        return Err(invalid());
                    }
                    self.entries.insert(
                        resource,
                        Upload {
                            document: document.clone(),
                            name,
                            bytes: vec![],
                            mime: None,
                            touched: Instant::now(),
                        },
                    );
                }
                let upload = self
                    .entries
                    .get_mut(&resource)
                    .filter(|s| {
                        s.document == document && s.mime.is_none() && s.bytes.len() as u64 == offset
                    })
                    .ok_or_else(invalid)?;
                if upload.bytes.len() + bytes.len() > codec::MAX_BYTES {
                    return Err(invalid());
                }
                upload.bytes.extend(bytes);
                upload.touched = Instant::now();
                if complete {
                    match codec::inspect(&upload.bytes) {
                        Ok(metadata) => upload.mime = Some(metadata.mime),
                        Err(_) => {
                            self.entries.remove(&resource);
                            return Err(invalid());
                        }
                    }
                }
                return Ok(ImageReply::Uploaded { resource });
            }
            _ => {}
        }
        let ticket = queue
            .submit(move |catalog| {
                let scope = match &command {
                    ImageCommand::Info { scope }
                    | ImageCommand::Annotations { scope }
                    | ImageCommand::Annotate { scope, .. }
                    | ImageCommand::DeleteAnnotation { scope, .. }
                    | ImageCommand::Revisions { scope } => scope,
                    _ => unreachable!(),
                };
                let book = catalog.notebook(&scope.document.notebook().to_string())?;
                let note = scope.document.note().to_string();
                let revision = scope.revision.to_string();
                let resource = scope.resource.to_string();
                let asset = book.read().resource(
                    &resource,
                    Some(ResourceScope::note(&note).with_revision(&revision)),
                )?;
                let info = asset.info().clone();
                Ok(match command {
                    ImageCommand::Info { .. } => ImageReply::Info {
                        hash: info.hash,
                        length: info.size,
                        mime: info.mime,
                    },
                    ImageCommand::Annotations { .. } => ImageReply::Annotations {
                        annotations: book
                            .read()
                            .annotations(&note, false)?
                            .into_iter()
                            .map(|a| {
                                Ok(ImageAnnotation {
                                    id: Uuid::parse_str(&a.id)
                                        .expect("storage validates annotation IDs"),
                                    hash: a.target_asset_hash,
                                    rectangles: serde_json::from_value(a.selector)?,
                                    body: a.body,
                                })
                            })
                            .collect::<ReadResult<_>>()?,
                    },
                    ImageCommand::Annotate {
                        hash,
                        rectangle: r,
                        body,
                        ..
                    } => {
                        book.add_image_annotation(
                            &note,
                            &revision,
                            &resource,
                            &AnnotationInput {
                                asset_hash: hash,
                                page: 1,
                                selector: vec![Rectangle {
                                    x: r.x,
                                    y: r.y,
                                    width: r.width,
                                    height: r.height,
                                }],
                                quote: String::new(),
                                body,
                                color: "yellow".into(),
                            },
                        )?;
                        ImageReply::Ack
                    }
                    ImageCommand::DeleteAnnotation { annotation, .. } => {
                        if book.read().annotations(&note, false)?.iter().any(|a| {
                            a.id == annotation.to_string() && a.target_asset_hash == info.hash
                        }) {
                            book.delete_annotation(&annotation.to_string())?;
                        }
                        ImageReply::Ack
                    }
                    ImageCommand::Revisions { .. } => {
                        let mut revisions = vec![];
                        for rev in book.read().history(&note)? {
                            let bindings = book.read().resources_at_revision(&note, &rev.id)?;
                            if let Some(r) = bindings
                                .iter()
                                .find(|r| r.revision_id == rev.id && r.resource_id == resource)
                            {
                                revisions.push(ImageRevision {
                                    revision: Uuid::parse_str(&rev.id)
                                        .expect("storage validates revision IDs"),
                                    hash: r.asset_hash.clone(),
                                    created_at: rev.created_at,
                                });
                            }
                        }
                        ImageReply::Revisions { revisions }
                    }
                    _ => unreachable!(),
                })
            })
            .map_err(storage)?;
        tokio::task::spawn_blocking(move || ticket.wait())
            .await
            .map_err(|_| ServiceError::new(ErrorCode::Storage))?
            .map_err(storage)
    }
}

pub async fn request(
    client: &crate::backend_client::BackendClient,
    command: Command,
) -> codec::Result<Reply> {
    use crate::backend_client::Response;
    match client
        .submit(command, Duration::from_secs(30))
        .map_err(|e| format!("图片服务不可用：{:?}", e.code()))?
        .receive()
        .await
        .map_err(|e| format!("图片操作失败：{:?}", e.code()))?
    {
        Response::Reply(reply) => Ok(reply),
        _ => Err("图片服务响应无效".into()),
    }
}
pub async fn read(
    client: &crate::backend_client::BackendClient,
    scope: &ImageScope,
    cancel: &std::sync::atomic::AtomicBool,
) -> codec::Result<(String, Vec<u8>)> {
    let token = Uuid::new_v4();
    let _lease = ReadLease {
        client: client.clone(),
        token,
    };
    let Reply::Image(ImageReply::Info { hash, length, .. }) = request(
        client,
        Command::Image(ImageCommand::BeginRead {
            scope: scope.clone(),
            token,
        }),
    )
    .await?
    else {
        return Err("图片信息无效".into());
    };
    if length > codec::MAX_BYTES as u64 {
        return Err("图片超过 50 MiB 上限".into());
    }
    let mut bytes = Vec::with_capacity(length as usize);
    while bytes.len() < length as usize {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("图片操作已取消".into());
        }
        let count = (length as usize - bytes.len()).min(MAX_CHUNK_BYTES);
        let Reply::Image(ImageReply::Chunk { bytes: part }) = request(
            client,
            Command::Image(ImageCommand::Read {
                token,
                offset: bytes.len() as u64,
                length: count as u32,
            }),
        )
        .await?
        else {
            return Err("图片读取失败".into());
        };
        if part.len() != count {
            return Err("图片数据不完整".into());
        }
        bytes.extend(part);
    }
    Ok((hash, bytes))
}
pub async fn upload(
    client: &crate::backend_client::BackendClient,
    document: DocumentId,
    resource: Uuid,
    name: String,
    bytes: &[u8],
) -> codec::Result<()> {
    let result = async {
        for (ix, part) in bytes.chunks(MAX_CHUNK_BYTES).enumerate() {
            let offset = ix * MAX_CHUNK_BYTES;
            request(
                client,
                Command::Image(ImageCommand::Upload {
                    document: document.clone(),
                    resource,
                    name: name.clone(),
                    offset: offset as u64,
                    bytes: part.to_vec(),
                    complete: offset + part.len() == bytes.len(),
                }),
            )
            .await?;
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = request(
            client,
            Command::Image(ImageCommand::Release {
                document,
                resources: vec![resource],
            }),
        )
        .await;
    }
    result
}

pub(crate) struct UploadLease {
    pub client: crate::backend_client::BackendClient,
    pub document: DocumentId,
    pub resources: Vec<Uuid>,
}
impl Drop for UploadLease {
    fn drop(&mut self) {
        if !self.resources.is_empty() {
            let _ = self.client.submit(
                Command::Image(ImageCommand::Release {
                    document: self.document.clone(),
                    resources: std::mem::take(&mut self.resources),
                }),
                Duration::from_secs(10),
            );
        }
    }
}

struct ReadLease {
    client: crate::backend_client::BackendClient,
    token: Uuid,
}
impl Drop for ReadLease {
    fn drop(&mut self) {
        let _ = self.client.submit(
            Command::Image(ImageCommand::EndRead { token: self.token }),
            Duration::from_secs(10),
        );
    }
}
