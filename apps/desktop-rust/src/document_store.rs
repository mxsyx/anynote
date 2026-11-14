//! Backend-only adapter. Every document operation uses the single storage queue.
use anynote_core::{backend::*, document_session::*};
use anynote_storage::{notebook::*, runtime_state::RuntimeState};
use std::path::Path;
use uuid::Uuid;

pub(crate) struct DocumentStore {
    pub(crate) queue: WriteQueue,
    images: crate::image::service::Uploads,
    readers: crate::asset_reader::AssetReaders,
}
fn storage(error: ReadError) -> ServiceError {
    ServiceError::new(match error.kind() {
        ReadErrorKind::Conflict => ErrorCode::Conflict,
        ReadErrorKind::NotFound => ErrorCode::NotFound,
        ReadErrorKind::Busy => ErrorCode::Busy,
        ReadErrorKind::InvalidInput | ReadErrorKind::InvalidRange => ErrorCode::InvalidRequest,
        _ => ErrorCode::Storage,
    })
}
fn snapshot(book: Uuid, note: Note, reader: &ReadonlyNotebook) -> ServiceResult<DocumentSnapshot> {
    if note.node.deleted_at.is_some()
        || note.node.kind != NodeKind::Note
        || !matches!(
            note.node.note_type,
            Some(NoteType::Markdown | NoteType::Image | NoteType::Pdf)
        )
    {
        return Err(ServiceError::new(ErrorCode::InvalidRequest));
    }
    let parse = |id: &str| Uuid::parse_str(id).map_err(|_| ServiceError::new(ErrorCode::Storage));
    let resources = reader
        .resources_at_revision(
            &note.node.id,
            note.head_revision_id
                .as_deref()
                .ok_or_else(|| ServiceError::new(ErrorCode::Storage))?,
        )
        .map_err(storage)?
        .into_iter()
        .map(|r| Ok((parse(&r.resource_id)?, r.asset_hash)))
        .collect::<ServiceResult<_>>()?;
    let primary_image = if note.node.note_type == Some(NoteType::Image) {
        note.primary_resource_id.as_deref().map(parse).transpose()?
    } else {
        None
    };
    let primary_pdf = if note.node.note_type == Some(NoteType::Pdf) {
        note.primary_resource_id.as_deref().map(parse).transpose()?
    } else {
        None
    };
    Ok(DocumentSnapshot::new(
        DocumentId::new(book, parse(&note.node.id)?),
        note.node.revision,
        parse(
            note.head_revision_id
                .as_deref()
                .ok_or_else(|| ServiceError::new(ErrorCode::Storage))?,
        )?,
        DocumentContent::new(
            note.node.title,
            note.body,
            note.node.tags,
            note.node.favorite != 0,
        ),
    )
    .with_resources(resources)
    .with_primary_image(primary_image)
    .with_primary_pdf(primary_pdf))
}
impl DocumentStore {
    pub(crate) fn reading_job(
        &self,
        request: anynote_core::builtin::ReadingRequest,
    ) -> impl std::future::Future<Output = ServiceResult<Reply>> + Send + use<> {
        let queue = self.queue.clone();
        async move {
            let book = request.base().id().notebook();
            let note =
                anynote_services::builtin::execute(&queue, request, &Default::default()).await?;
            let ticket = queue
                .submit(move |catalog| {
                    Ok(snapshot(
                        book,
                        note,
                        catalog.notebook(&book.to_string())?.read(),
                    ))
                })
                .map_err(storage)?;
            tokio::task::spawn_blocking(move || ticket.wait())
                .await
                .map_err(|_| ServiceError::new(ErrorCode::Storage))?
                .map_err(storage)?
                .map(Reply::Reading)
        }
    }
    pub(crate) fn open(directory: &Path) -> ServiceResult<Self> {
        let root = directory.join("workspace");
        std::fs::create_dir_all(&root).map_err(|_| ServiceError::new(ErrorCode::Storage))?;
        Ok(Self {
            queue: WriteQueue::open(&root, 8).map_err(storage)?,
            images: Default::default(),
            readers: Default::default(),
        })
    }
    pub(crate) async fn execute(
        &mut self,
        command: Command,
        state: &RuntimeState,
    ) -> ServiceResult<Reply> {
        if let Command::Asset(command) = command {
            return self
                .readers
                .execute(command, &self.queue)
                .await
                .map(Reply::Asset);
        }
        if let Command::Image(command) = command {
            return self
                .images
                .execute(command, &self.queue)
                .await
                .map(Reply::Image);
        }
        if let Command::RunReading(request) = command {
            return self.reading_job(request).await;
        }
        let command = if matches!(command, Command::OpenLastDocument) {
            let bytes = state
                .read("document.last.identity")?
                .ok_or_else(|| ServiceError::new(ErrorCode::NotFound))?;
            Command::OpenDocument {
                id: serde_json::from_slice(&bytes)
                    .map_err(|_| ServiceError::new(ErrorCode::Storage))?,
            }
        } else {
            command
        };
        let default_book = if matches!(command, Command::CreateDocument) {
            let key = "document.default.notebook";
            if let Some(bytes) = state.read(key)? {
                Some(
                    serde_json::from_slice::<Uuid>(&bytes)
                        .map_err(|_| ServiceError::new(ErrorCode::Storage))?,
                )
            } else {
                let ticket = self
                    .queue
                    .submit(|catalog| catalog.create_notebook("草稿"))
                    .map_err(storage)?;
                let book = tokio::task::spawn_blocking(move || ticket.wait())
                    .await
                    .map_err(|_| ServiceError::new(ErrorCode::Storage))?
                    .map_err(storage)?;
                let id =
                    Uuid::parse_str(&book.id).map_err(|_| ServiceError::new(ErrorCode::Storage))?;
                state.write(
                    key,
                    &serde_json::to_vec(&id).map_err(|_| ServiceError::new(ErrorCode::Storage))?,
                )?;
                Some(id)
            }
        } else {
            None
        };
        let remember_document = matches!(
            command,
            Command::CreateDocument | Command::OpenDocument { .. }
        );
        let resources = if let Command::SaveDocument(request) = &command {
            self.images
                .resources(request.snapshot().id(), request.resources())?
        } else if let Command::SaveBoard(request) = &command {
            let mut ids = request.images().to_vec();
            ids.push(request.preview());
            self.images.resources(request.base().id(), &ids)?
        } else {
            vec![]
        };
        let ticket = self
            .queue
            .submit(move |catalog| {
                // Service validation stays outside the storage result channel.
                Ok(match command {
                    Command::GetNotebookPreferences { notebook } => {
                        let reader = catalog.notebook(&notebook.to_string())?.read();
                        reader.ensure_builtin_migrated("notebook.preferences")?;
                        let (revision, preferences) = reader.builtin_preferences()?;
                        Ok(Reply::NotebookPreferences {
                            revision,
                            preferences,
                        })
                    }
                    Command::SetNotebookPreferences {
                        notebook,
                        expected,
                        preferences,
                    } => {
                        let revision = catalog
                            .notebook(&notebook.to_string())?
                            .set_builtin_preferences(expected, &preferences)?;
                        Ok(Reply::NotebookPreferences {
                            revision,
                            preferences,
                        })
                    }
                    Command::CreateDocument => {
                        let book = default_book.unwrap();
                        let note = catalog
                            .notebook(&book.to_string())?
                            .create_node(&CreateNode::note("未命名笔记", ""), &[])?;
                        snapshot(book, note, catalog.notebook(&book.to_string())?.read())
                            .map(Reply::Document)
                    }
                    Command::OpenDocument { id } => {
                        let note = catalog
                            .notebook(&id.notebook().to_string())?
                            .read()
                            .note(&id.note().to_string())?;
                        snapshot(
                            id.notebook(),
                            note,
                            catalog.notebook(&id.notebook().to_string())?.read(),
                        )
                        .map(Reply::Document)
                    }
                    Command::SaveBoard(request) => {
                        let id = request.base().id();
                        let book = catalog.notebook(&id.notebook().to_string())?;
                        crate::board::persistence::commit(book, &request, resources)
                            .and_then(|note| snapshot(id.notebook(), note, book.read()))
                            .map(Reply::Document)
                    }
                    Command::SaveDocument(request) => {
                        let base = request.snapshot();
                        let id = base.id();
                        let book = catalog.notebook(&id.notebook().to_string())?;
                        let current = book.read().note(&id.note().to_string())?;
                        if current.head_revision_id.as_deref() != Some(&base.head().to_string())
                            || current.node.revision != base.revision()
                        {
                            Err(ServiceError::new(ErrorCode::Conflict))
                        } else if current.node.kind != NodeKind::Note
                            || !matches!(
                                current.node.note_type,
                                Some(NoteType::Markdown | NoteType::Image)
                            )
                        {
                            Err(ServiceError::new(ErrorCode::InvalidRequest))
                        } else {
                            let content = base.content();
                            let note = book.save_note(
                                &id.note().to_string(),
                                base.revision(),
                                &NotePatch {
                                    title: Some(content.title().to_owned()),
                                    body: Some(content.body().to_owned()),
                                    tags: Some(content.tags().to_vec()),
                                    favorite: Some(content.favorite()),
                                },
                                &resources,
                            )?;
                            snapshot(id.notebook(), note, book.read()).map(|saved| {
                                Reply::DocumentSaved(SaveDocument::new(
                                    request.epoch(),
                                    request.generation(),
                                    saved,
                                ))
                            })
                        }
                    }
                    Command::DocumentResource {
                        id,
                        revision,
                        resource,
                        offset,
                        length,
                    } => {
                        if length as usize > MAX_CHUNK_BYTES {
                            return Ok(Err(ServiceError::new(ErrorCode::InvalidRequest)));
                        }
                        let note = id.note().to_string();
                        let revision = revision.to_string();
                        let mut asset = catalog
                            .notebook(&id.notebook().to_string())?
                            .read()
                            .resource(
                                &resource.to_string(),
                                Some(ResourceScope::note(&note).with_revision(&revision)),
                            )?;
                        let hash = asset.info().hash.clone();
                        Ok(Reply::DocumentResource {
                            bytes: asset.read_range(&hash, offset, length as usize)?,
                        })
                    }
                    _ => Err(ServiceError::new(ErrorCode::InvalidRequest)),
                })
            })
            .map_err(storage)?;
        let reply = tokio::task::spawn_blocking(move || ticket.wait())
            .await
            .map_err(|_| ServiceError::new(ErrorCode::Storage))?
            .map_err(storage)??;
        if remember_document && let Reply::Document(snapshot) = &reply {
            state.write(
                "document.last.identity",
                &serde_json::to_vec(snapshot.id())
                    .map_err(|_| ServiceError::new(ErrorCode::Storage))?,
            )?;
        }
        Ok(reply)
    }
}
