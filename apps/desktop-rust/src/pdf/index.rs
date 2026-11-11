use super::PdfError;
#[cfg(feature = "media")]
use super::service;
use crate::backend_client::BackendClient;
use anynote_core::{asset::AssetScope, backend::Command, pdf::*};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use uuid::Uuid;

pub struct IndexJob {
    cancelled: Arc<AtomicBool>,
    task: Arc<std::sync::Mutex<Option<Uuid>>>,
    client: BackendClient,
}
impl IndexJob {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        if let Some(task_id) = *self.task.lock().unwrap() {
            let _ = self.client.submit(
                Command::CancelTask { task_id },
                std::time::Duration::from_secs(10),
            );
        }
    }
}
impl Drop for IndexJob {
    fn drop(&mut self) {
        self.cancel();
    }
}
#[cfg(feature = "media")]
pub(crate) fn run(
    client: BackendClient,
    scope: AssetScope,
    password: String,
) -> (
    IndexJob,
    async_channel::Receiver<Result<IndexCoverage, PdfError>>,
) {
    let cancelled = Arc::new(AtomicBool::new(false));
    let task = Arc::new(std::sync::Mutex::new(None));
    let job = IndexJob {
        cancelled: cancelled.clone(),
        task: task.clone(),
        client: client.clone(),
    };
    let (send, receive) = async_channel::bounded(1);
    std::thread::spawn(move || {
        let result = (|| {
            let check = || cancelled.load(Ordering::Acquire);
            if check() {
                return Err(PdfError::Cancelled);
            }
            let reader = super::ResourceReader::open(client.clone(), scope.clone())?;
            let hash = reader.hash().to_owned();
            if check() {
                return Err(PdfError::Cancelled);
            }
            let doc =
                super::engine::open(reader, (!password.is_empty()).then_some(password.as_str()))?;
            if check() {
                return Err(PdfError::Cancelled);
            }
            let total = doc.page_count()?;
            let PdfReply::IndexStarted { task: id } =
                service::blocking(&client, PdfCommand::BeginIndex { scope, hash, total })?
            else {
                return Err(PdfError::Resource);
            };
            *task.lock().unwrap() = Some(id);
            let mut remaining = MAX_INDEX_UTF16;
            for page in 0..total.min(MAX_INDEX_PAGES as u16) {
                if check() {
                    return Err(PdfError::Cancelled);
                }
                remaining -= page_marker(page).encode_utf16().count();
                let (text, mut truncated) = super::engine::extract(&doc, page, remaining, check)?;
                remaining -= text.encode_utf16().count();
                if page + 1 < total && remaining < page_marker(page + 1).encode_utf16().count() {
                    truncated = true;
                }
                if check() {
                    return Err(PdfError::Cancelled);
                }
                service::blocking(
                    &client,
                    PdfCommand::IndexPage {
                        task: id,
                        page,
                        text,
                        truncated,
                    },
                )?;
                if truncated {
                    break;
                }
            }
            if check() {
                return Err(PdfError::Cancelled);
            }
            match service::blocking(&client, PdfCommand::FinishIndex { task: id })? {
                PdfReply::Indexed { coverage } => Ok(coverage),
                _ => Err(PdfError::Resource),
            }
        })();
        if let Some(id) = task.lock().unwrap().take() {
            if matches!(result, Err(PdfError::Cancelled)) {
                let _ = client.submit(
                    Command::CancelTask { task_id: id },
                    std::time::Duration::from_secs(10),
                );
            } else if result.is_err() {
                let _ = service::blocking(&client, PdfCommand::FailIndex { task: id });
            }
        }
        let _ = send.try_send(result);
    });
    (job, receive)
}
#[cfg(not(feature = "media"))]
pub(crate) fn run(
    client: BackendClient,
    _: AssetScope,
    _: String,
) -> (
    IndexJob,
    async_channel::Receiver<Result<IndexCoverage, PdfError>>,
) {
    let (send, receive) = async_channel::bounded(1);
    let _ = send.try_send(Err(PdfError::Unavailable));
    (
        IndexJob {
            cancelled: Arc::new(AtomicBool::new(false)),
            task: Default::default(),
            client,
        },
        receive,
    )
}
