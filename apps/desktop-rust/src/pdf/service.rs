use crate::backend_client::{BackendClient, Response};
use anynote_core::{backend::*, pdf::*};
use anynote_storage::notebook::*;
use std::time::Duration;
pub(crate) async fn execute(queue: &WriteQueue, command: PdfCommand) -> ServiceResult<PdfReply> {
    let scope = match &command {
        PdfCommand::Load { scope, .. }
        | PdfCommand::Annotate { scope, .. }
        | PdfCommand::Delete { scope, .. }
        | PdfCommand::Reanchor { scope, .. }
        | PdfCommand::ReadingNote { scope, .. } => scope,
        _ => return Err(ServiceError::new(ErrorCode::InvalidRequest)),
    };
    let book = scope.document().notebook().to_string();
    let ticket = queue
        .submit(move |catalog| catalog.notebook(&book)?.execute_pdf(command))
        .map_err(anynote_services::builtin::storage_error)?;
    tokio::task::spawn_blocking(move || ticket.wait())
        .await
        .map_err(|_| ServiceError::new(ErrorCode::Storage))?
        .map_err(anynote_services::builtin::storage_error)
}
pub async fn request(client: &BackendClient, command: PdfCommand) -> Result<PdfReply, String> {
    match client
        .submit(Command::Pdf(command), Duration::from_secs(60))
        .map_err(|e| e.to_string())?
        .receive()
        .await
        .map_err(|e| e.to_string())?
    {
        Response::Reply(Reply::Pdf(reply)) => Ok(reply),
        _ => Err("PDF 服务响应无效".into()),
    }
}
#[cfg(feature = "media")]
pub fn blocking(client: &BackendClient, command: PdfCommand) -> Result<PdfReply, super::PdfError> {
    match client
        .submit(Command::Pdf(command), Duration::from_secs(60))
        .map_err(|_| super::PdfError::Resource)?
        .receive_blocking()
        .map_err(|e| {
            if e.code() == ErrorCode::Cancelled {
                super::PdfError::Cancelled
            } else {
                super::PdfError::Resource
            }
        })? {
        Response::Reply(Reply::Pdf(reply)) => Ok(reply),
        _ => Err(super::PdfError::Resource),
    }
}
