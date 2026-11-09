use super::*;
use anynote_core::{asset::AssetScope, pdf::*};
pub(super) struct IndexSession {
    scope: AssetScope,
    hash: String,
    builder: IndexBuilder,
}
impl Backend {
    pub(super) async fn pdf_command(&mut self, command: PdfCommand) -> ServiceResult<Reply> {
        if self.documents.is_none() {
            self.documents = Some(crate::document_store::DocumentStore::open(&self.directory)?);
        }
        let invalid = || ServiceError::new(ErrorCode::InvalidRequest);
        let reply = match command {
            PdfCommand::BeginIndex { scope, hash, total } => {
                let builder = IndexBuilder::new(total).ok_or_else(invalid)?;
                let loaded = self
                    .documents
                    .as_mut()
                    .unwrap()
                    .execute(
                        Command::Pdf(PdfCommand::Load {
                            scope: scope.clone(),
                            hash: hash.clone(),
                        }),
                        &self.store,
                    )
                    .await?;
                if !matches!(loaded, Reply::Pdf(PdfReply::Loaded { current: true, .. })) {
                    return Err(ServiceError::new(ErrorCode::Conflict));
                }
                if self
                    .pdf_indexes
                    .values()
                    .any(|s| s.scope.document() == scope.document())
                {
                    return Err(ServiceError::new(ErrorCode::Busy));
                }
                let task = self.tasks.start(&self.store, RecoveryPolicy::ReadOnly)?;
                self.pdf_indexes.insert(
                    task.id(),
                    IndexSession {
                        scope,
                        hash,
                        builder,
                    },
                );
                self.publish(task.clone()).await?;
                PdfReply::IndexStarted { task: task.id() }
            }
            PdfCommand::IndexPage {
                task,
                page,
                text,
                truncated,
            } => {
                let session = self
                    .pdf_indexes
                    .get_mut(&task)
                    .ok_or_else(|| ServiceError::new(ErrorCode::Cancelled))?;
                if !session.builder.push(page, text, truncated) {
                    self.pdf_indexes.remove(&task);
                    let record = self
                        .tasks
                        .transition(&self.store, task, TaskStatus::Failed)?;
                    self.publish(record).await?;
                    return Err(invalid());
                }
                PdfReply::Ack
            }
            PdfCommand::FinishIndex { task } => {
                let session = self
                    .pdf_indexes
                    .remove(&task)
                    .ok_or_else(|| ServiceError::new(ErrorCode::Cancelled))?;
                let Some((body, coverage)) = session.builder.finish() else {
                    let record = self
                        .tasks
                        .transition(&self.store, task, TaskStatus::Failed)?;
                    self.publish(record).await?;
                    return Err(invalid());
                };
                let record = self
                    .tasks
                    .transition(&self.store, task, TaskStatus::Committing)?;
                self.publish(record).await?;
                let saved_coverage = coverage.clone();
                let result = async {
                    let ticket = self
                        .documents
                        .as_ref()
                        .unwrap()
                        .queue
                        .submit(move |catalog| {
                            catalog
                                .notebook(&session.scope.document().notebook().to_string())?
                                .publish_pdf_index(
                                    &session.scope,
                                    &session.hash,
                                    &body,
                                    &saved_coverage,
                                )
                        })
                        .map_err(anynote_services::builtin::storage_error)?;
                    tokio::task::spawn_blocking(move || ticket.wait())
                        .await
                        .map_err(|_| ServiceError::new(ErrorCode::Storage))?
                        .map_err(anynote_services::builtin::storage_error)
                }
                .await;
                let record = self.tasks.transition(
                    &self.store,
                    task,
                    if result.is_ok() {
                        TaskStatus::Completed
                    } else {
                        TaskStatus::Failed
                    },
                )?;
                self.publish(record).await?;
                result?;
                PdfReply::Indexed { coverage }
            }
            PdfCommand::FailIndex { task } => {
                if self.pdf_indexes.remove(&task).is_some() {
                    let record = self
                        .tasks
                        .transition(&self.store, task, TaskStatus::Failed)?;
                    self.publish(record).await?;
                }
                PdfReply::Ack
            }
            command => {
                return self
                    .documents
                    .as_mut()
                    .unwrap()
                    .execute(Command::Pdf(command), &self.store)
                    .await;
            }
        };
        Ok(Reply::Pdf(reply))
    }
}
