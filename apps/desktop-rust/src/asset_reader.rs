//! Backend-owned leases keep range reads pinned to a verified CAS file handle.
use anynote_core::{asset::*, backend::*};
use anynote_storage::notebook::*;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use uuid::Uuid;

#[derive(Default)]
pub(crate) struct AssetReaders(HashMap<Uuid, (VerifiedAsset, Instant)>);
fn storage(error: ReadError) -> ServiceError {
    ServiceError::new(match error.kind() {
        ReadErrorKind::Conflict => ErrorCode::Conflict,
        ReadErrorKind::NotFound => ErrorCode::NotFound,
        ReadErrorKind::InvalidInput | ReadErrorKind::InvalidRange => ErrorCode::InvalidRequest,
        _ => ErrorCode::Storage,
    })
}
impl AssetReaders {
    pub async fn execute(
        &mut self,
        command: AssetCommand,
        queue: &WriteQueue,
    ) -> ServiceResult<AssetReply> {
        self.0
            .retain(|_, (_, touched)| touched.elapsed() < Duration::from_secs(30 * 60));
        match command {
            AssetCommand::Open { scope, token } => {
                if self.0.len() >= 16 || self.0.contains_key(&token) {
                    return Err(ServiceError::new(ErrorCode::Busy));
                }
                let ticket = queue
                    .submit(move |catalog| {
                        let note = scope.document().note().to_string();
                        let revision = scope.revision().to_string();
                        catalog
                            .notebook(&scope.document().notebook().to_string())?
                            .read()
                            .resource(
                                &scope.resource().to_string(),
                                Some(ResourceScope::note(&note).with_revision(&revision)),
                            )
                    })
                    .map_err(storage)?;
                let asset = tokio::task::spawn_blocking(move || ticket.wait())
                    .await
                    .map_err(|_| ServiceError::new(ErrorCode::Storage))?
                    .map_err(storage)?;
                let info = asset.info().clone();
                self.0.insert(token, (asset, Instant::now()));
                Ok(AssetReply::Opened {
                    hash: info.hash,
                    length: info.size,
                    mime: info.mime,
                })
            }
            AssetCommand::Read {
                token,
                offset,
                length,
            } => {
                if length == 0 || length as usize > MAX_CHUNK_BYTES {
                    return Err(ServiceError::new(ErrorCode::InvalidRequest));
                }
                let (asset, touched) = self
                    .0
                    .get_mut(&token)
                    .ok_or_else(|| ServiceError::new(ErrorCode::InvalidToken))?;
                *touched = Instant::now();
                let hash = asset.info().hash.clone();
                Ok(AssetReply::Chunk {
                    bytes: asset
                        .read_range(&hash, offset, length as usize)
                        .map_err(storage)?,
                })
            }
            AssetCommand::Close { token } => {
                self.0.remove(&token);
                Ok(AssetReply::Closed)
            }
        }
    }
}
