use super::*;
use anynote_core::{
    document_session::DocumentId,
    workspace::{Preferences, WorkspaceCommand as C, WorkspaceReply as R},
};
use anynote_storage::notebook::{ReadError, ReadErrorKind};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

fn storage(error: ReadError) -> ServiceError {
    ServiceError::new(match error.kind() {
        ReadErrorKind::Conflict => ErrorCode::Conflict,
        ReadErrorKind::Busy => ErrorCode::Busy,
        ReadErrorKind::NotFound => ErrorCode::NotFound,
        ReadErrorKind::Cancelled => ErrorCode::Cancelled,
        ReadErrorKind::InvalidInput => ErrorCode::InvalidRequest,
        _ => ErrorCode::Storage,
    })
}
impl Backend {
    pub(super) async fn workspace_command(
        &mut self,
        request: u64,
        command: C,
    ) -> ServiceResult<Option<Reply>> {
        let preference_key = "workspace.preferences";
        let reply = match command {
            C::Preferences => Some(R::Preferences(
                self.store
                    .read(preference_key)?
                    .map(|bytes| {
                        serde_json::from_slice(&bytes)
                            .map_err(|_| ServiceError::new(ErrorCode::Storage))
                    })
                    .transpose()?
                    .unwrap_or_else(Preferences::default),
            )),
            C::SetPreferences(value) => {
                if !value.is_valid() {
                    return Err(ServiceError::new(ErrorCode::InvalidRequest));
                }
                self.store.write(
                    preference_key,
                    &serde_json::to_vec(&value)
                        .map_err(|_| ServiceError::new(ErrorCode::InvalidRequest))?,
                )?;
                Some(R::Done)
            }
            C::CancelSearch { token } => {
                if let Some(cancel) = self
                    .searches
                    .values()
                    .find(|(id, _)| *id == token)
                    .map(|(_, cancel)| cancel)
                {
                    cancel.store(true, Ordering::Release);
                }
                Some(R::Done)
            }
            command => {
                if self.reading_workers.len() >= MAX_ACTIVE_TASKS {
                    return Err(ServiceError::new(ErrorCode::Busy));
                }
                if self.documents.is_none() {
                    self.documents =
                        Some(crate::document_store::DocumentStore::open(&self.directory)?);
                }
                let queue = self.documents.as_ref().unwrap().queue.clone();
                let temporary = self.directory.clone();
                let input = self.input.clone();
                let cancel = Arc::new(AtomicBool::new(false));
                if let C::Search(search) = &command {
                    if self
                        .searches
                        .values()
                        .any(|(token, _)| *token == search.token)
                    {
                        return Err(ServiceError::new(ErrorCode::InvalidRequest));
                    }
                    self.searches
                        .insert(request, (search.token, cancel.clone()));
                }
                self.reading_workers.insert(
                    request,
                    tokio::spawn(async move {
                        let result = async {
                            match command {
                                C::Search(search) => {
                                    let ticket = queue
                                        .submit(move |catalog| {
                                            anynote_services::workspace::search(
                                                catalog, search, cancel,
                                            )
                                        })
                                        .map_err(storage)?;
                                    tokio::task::spawn_blocking(move || ticket.wait())
                                        .await
                                        .map_err(|_| ServiceError::new(ErrorCode::Storage))?
                                        .map_err(storage)
                                }
                                C::Backlinks { id } => {
                                    let ticket = queue
                                        .submit(move |catalog| {
                                            anynote_services::workspace::backlinks(catalog, &id)
                                        })
                                        .map_err(storage)?;
                                    tokio::task::spawn_blocking(move || ticket.wait())
                                        .await
                                        .map_err(|_| ServiceError::new(ErrorCode::Storage))?
                                        .map_err(storage)
                                }
                                C::Transfer {
                                    id,
                                    expected,
                                    target,
                                    parent,
                                    copy,
                                    operation,
                                } => {
                                    use anynote_services::transfer::*;
                                    let ticket = transfer_node(
                                        &queue,
                                        TransferRequest {
                                            notebook_id: id.notebook().to_string(),
                                            id: id.note().to_string(),
                                            target_notebook_id: target.to_string(),
                                            target_parent_id: parent.map(|id| id.to_string()),
                                            mode: if copy {
                                                TransferMode::Copy
                                            } else {
                                                TransferMode::Move
                                            },
                                            operation_id: operation.to_string(),
                                            expected_revision: expected,
                                        },
                                    )
                                    .map_err(storage)?;
                                    let result = tokio::task::spawn_blocking(move || ticket.wait())
                                        .await
                                        .map_err(|_| ServiceError::new(ErrorCode::Storage))?
                                        .map_err(storage)?;
                                    Ok(R::Transferred {
                                        id: DocumentId::new(
                                            target,
                                            Uuid::parse_str(&result.id).map_err(|_| {
                                                ServiceError::new(ErrorCode::Storage)
                                            })?,
                                        ),
                                        complete: matches!(
                                            result.status,
                                            TransferStatus::Completed | TransferStatus::Copied
                                        ),
                                    })
                                }
                                C::Import { book, parent, path } => {
                                    tokio::task::spawn_blocking(move || {
                                        use anynote_services::importer::*;
                                        let runtime = tokio::runtime::Builder::new_current_thread()
                                            .enable_all()
                                            .build()
                                            .map_err(|_| ServiceError::new(ErrorCode::Storage))?;
                                        runtime.block_on(async {
                                            let fail = |_| ServiceError::new(ErrorCode::Storage);
                                            let mut importer =
                                                ImportService::new(&temporary).map_err(fail)?;
                                            let file =
                                                std::fs::File::open(&path).map_err(|_| {
                                                    ServiceError::new(ErrorCode::Storage)
                                                })?;
                                            let target = PreviewTarget {
                                                notebook_id: book.to_string(),
                                                parent_id: parent.map(|id| id.to_string()),
                                            };
                                            let cancel = Default::default();
                                            let preview = importer
                                                .preview(
                                                    target.clone(),
                                                    ImportInput::File {
                                                        file,
                                                        name: path
                                                            .file_name()
                                                            .unwrap_or_default()
                                                            .to_string_lossy()
                                                            .into_owned(),
                                                    },
                                                    Default::default(),
                                                    &cancel,
                                                )
                                                .await
                                                .map_err(fail)?;
                                            importer
                                                .commit(&queue, &target, &preview.id, &cancel)
                                                .map_err(fail)?;
                                            Ok(R::Done)
                                        })
                                    })
                                    .await
                                    .map_err(|_| ServiceError::new(ErrorCode::Storage))?
                                }
                                command => {
                                    let ticket = queue
                                        .submit(move |catalog| {
                                            anynote_services::workspace::execute(catalog, command)
                                        })
                                        .map_err(storage)?;
                                    tokio::task::spawn_blocking(move || ticket.wait())
                                        .await
                                        .map_err(|_| ServiceError::new(ErrorCode::Storage))?
                                        .map_err(storage)
                                }
                            }
                        }
                        .await
                        .map(Reply::Workspace);
                        let _ = input.send(Input::ReadingFinished(request, result)).await;
                    }),
                );
                None
            }
        };
        Ok(reply.map(Reply::Workspace))
    }
}
