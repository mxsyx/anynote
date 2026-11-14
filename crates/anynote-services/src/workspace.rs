//! Organization adapter; storage owns validation, ordering, revisions and leases.
use anynote_core::{document_session::DocumentId, workspace::*};
use anynote_storage::notebook::*;
use std::sync::{Arc, atomic::AtomicBool};
use uuid::Uuid;

fn uuid(value: &str) -> ReadResult<Uuid> {
    Uuid::parse_str(value).map_err(|_| ReadError::invalid_input("记录身份无效"))
}
fn entry(book: Uuid, node: Node) -> ReadResult<Entry> {
    let mut result = Entry::new(DocumentId::new(book, uuid(&node.id)?), node.title);
    result.parent = node.parent_id.as_deref().map(uuid).transpose()?;
    result.folder = node.kind == NodeKind::Folder;
    result.kind = match node.note_type {
        Some(NoteType::Pdf) => "pdf",
        Some(NoteType::Image) => "image",
        _ => "markdown",
    }
    .into();
    result.revision = node.revision;
    result.updated = node.updated_at;
    result.favorite = node.favorite != 0;
    result.tags = node.tags;
    result.deleted = node.deleted_at.is_some();
    Ok(result)
}
fn book(meta: NotebookMeta) -> ReadResult<Book> {
    let mut result = Book::new(uuid(&meta.id)?, meta.name);
    result.icon = meta.icon;
    result.color = meta.cover_color;
    Ok(result)
}
pub fn execute(
    catalog: &mut WriteCatalog,
    command: WorkspaceCommand,
) -> ReadResult<WorkspaceReply> {
    use WorkspaceCommand as C;
    Ok(match command {
        C::Books => WorkspaceReply::Books(
            catalog
                .catalog_entries()?
                .into_iter()
                .map(|e| {
                    let mut result = if let Some(meta) = e.metadata {
                        book(meta)?
                    } else {
                        Book::new(uuid(&e.id)?, e.name)
                    };
                    result.external = e.external;
                    result.unavailable = e.unavailable;
                    result.error = e.error.map(|error| format!("{error:?}"));
                    Ok(result)
                })
                .collect::<ReadResult<_>>()?,
        ),
        C::CreateBook { title } => WorkspaceReply::Book(book(catalog.create_notebook(&title)?)?),
        C::RenameBook {
            book: id,
            title,
            icon,
            color,
        } => WorkspaceReply::Book(book(catalog.rename_notebook(
            &id.to_string(),
            &title,
            Some(&icon),
            Some(&color),
        )?)?),
        C::Attach { path } => WorkspaceReply::Book(book(catalog.attach_directory(&path)?)?),
        C::Detach { book } => {
            catalog.detach_directory(&book.to_string())?;
            WorkspaceReply::Done
        }
        C::Nodes {
            book,
            trash,
            offset,
        } => {
            let reader = catalog.notebook(&book.to_string())?.read();
            let nodes = reader.node_page(trash, offset)?;
            let next = (nodes.len() > 200).then_some(offset.saturating_add(200));
            WorkspaceReply::Nodes {
                entries: nodes
                    .into_iter()
                    .take(200)
                    .map(|n| entry(book, n))
                    .collect::<ReadResult<_>>()?,
                next,
            }
        }
        C::CreateNode {
            book,
            parent,
            title,
            folder,
        } => {
            let mut request = CreateNode::note(title, "");
            request.parent_id = parent.map(|id| id.to_string());
            if folder {
                request.kind = NodeKind::Folder;
                request.note_type = None;
            }
            WorkspaceReply::Node(entry(
                book,
                catalog
                    .notebook(&book.to_string())?
                    .create_node(&request, &[])?
                    .node,
            )?)
        }
        C::Patch {
            id,
            expected,
            title,
            tags,
            favorite,
        } => WorkspaceReply::Node(entry(
            id.notebook(),
            catalog
                .notebook(&id.notebook().to_string())?
                .save_note(
                    &id.note().to_string(),
                    expected,
                    &NotePatch {
                        title,
                        tags,
                        favorite,
                        body: None,
                    },
                    &[],
                )?
                .node,
        )?),
        C::Place {
            id,
            expected,
            parent,
            before,
        } => WorkspaceReply::Node(entry(
            id.notebook(),
            catalog
                .notebook(&id.notebook().to_string())?
                .place_node(
                    &id.note().to_string(),
                    expected,
                    parent.map(|i| i.to_string()).as_deref(),
                    before.map(|i| i.to_string()).as_deref(),
                )?
                .node,
        )?),
        C::Trash { id, restore } => {
            let notebook = catalog.notebook(&id.notebook().to_string())?;
            if restore {
                notebook.restore_node(&id.note().to_string())?;
            } else {
                notebook.trash_node(&id.note().to_string())?;
            }
            WorkspaceReply::Done
        }
        C::History { id, offset } => {
            let revisions = catalog
                .notebook(&id.notebook().to_string())?
                .read()
                .revision_page(&id.note().to_string(), offset)?;
            let next = (revisions.len() > 100).then_some(offset.saturating_add(100));
            WorkspaceReply::History {
                entries: revisions
                    .into_iter()
                    .take(100)
                    .map(|r| Ok(HistoryEntry::new(uuid(&r.id)?, r.created_at, r.actor)))
                    .collect::<ReadResult<_>>()?,
                next,
            }
        }
        C::Revision { id, revision } => WorkspaceReply::Revision(
            catalog
                .notebook(&id.notebook().to_string())?
                .read()
                .revision_body(&id.note().to_string(), &revision.to_string())?,
        ),
        C::RestoreRevision {
            id,
            expected,
            revision,
        } => WorkspaceReply::Node(entry(
            id.notebook(),
            catalog
                .notebook(&id.notebook().to_string())?
                .restore_revision(&id.note().to_string(), expected, &revision.to_string())?
                .node,
        )?),
        _ => return Err(ReadError::invalid_input("此命令需要工作区会话")),
    })
}
pub fn search(
    catalog: &mut WriteCatalog,
    request: Search,
    cancelled: Arc<AtomicBool>,
) -> ReadResult<WorkspaceReply> {
    let mut query = SearchRequest::new(request.token.to_string(), request.query);
    query.notebook_ids = request.book.map(|id| vec![id.to_string()]);
    query.tag = request.tag;
    query.updated_after = request.updated_after;
    query.after = request.after;
    query.note_type = match request.kind.as_deref() {
        None => None,
        Some("markdown") => Some(NoteType::Markdown),
        Some("image") => Some(NoteType::Image),
        Some("pdf") => Some(NoteType::Pdf),
        _ => return Err(ReadError::invalid_input("搜索类型无效")),
    };
    query.limit = 200;
    let response = catalog.search(&query, cancelled)?;
    let complete = response.warnings.is_empty()
        && response.searched == request.book.map_or(catalog.entries().len(), |_| 1);
    Ok(WorkspaceReply::Search {
        complete,
        token: request.token,
        hits: response
            .results
            .into_iter()
            .map(|hit| {
                Ok(Hit::new(
                    entry(uuid(&hit.notebook_id)?, hit.node)?,
                    hit.snippet,
                    hit.notebook_name,
                    None,
                ))
            })
            .collect::<ReadResult<_>>()?,
        warnings: response.warnings.into_iter().map(|w| w.message).collect(),
        truncated: response.truncated,
        cancelled: response.cancelled,
    })
}
pub fn backlinks(catalog: &mut WriteCatalog, id: &DocumentId) -> ReadResult<WorkspaceReply> {
    Ok(WorkspaceReply::Backlinks(
        catalog
            .backlinks(&id.notebook().to_string(), &id.note().to_string())?
            .into_iter()
            .map(|b| {
                Ok(Entry::new(
                    DocumentId::new(uuid(&b.notebook_id)?, uuid(&b.id)?),
                    b.title,
                ))
            })
            .collect::<ReadResult<_>>()?,
    ))
}
