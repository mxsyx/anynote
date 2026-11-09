#[cfg(feature = "media")]
use super::ResourceReader;
use super::{PageRaster, PdfError};
use crate::backend_client::BackendClient;
use anynote_core::asset::AssetScope;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, Ordering},
};

struct RenderRequest {
    #[cfg(feature = "media")]
    pub(crate) page: u16,
    #[cfg(feature = "media")]
    pub(crate) edge: u32,
    #[cfg(feature = "media")]
    pub(crate) text: bool,
    #[cfg(feature = "media")]
    generation: u64,
    reply: async_channel::Sender<Result<PageRaster, PdfError>>,
}
pub type OpenResult = async_channel::Receiver<Result<(u16, String), PdfError>>;

pub struct PdfWorker {
    sender: async_channel::Sender<RenderRequest>,
    pending: async_channel::Receiver<RenderRequest>,
    closed: Arc<AtomicBool>,
    generation: Arc<AtomicU64>,
}
impl PdfWorker {
    pub fn open(client: BackendClient, scope: AssetScope, password: String) -> (Self, OpenResult) {
        let (sender, pending) = async_channel::bounded::<RenderRequest>(1);
        let closed = Arc::new(AtomicBool::new(false));
        let generation = Arc::new(AtomicU64::new(0));
        let worker = Self {
            sender,
            pending: pending.clone(),
            closed: closed.clone(),
            generation: generation.clone(),
        };
        let (ready, receiver) = async_channel::bounded(1);
        let _ = std::thread::Builder::new()
            .name("anynote-pdf".into())
            .spawn(move || {
                #[cfg(feature = "media")]
                {
                    let result = (|| {
                        let reader = ResourceReader::open(client, scope, closed.clone())?;
                        let hash = reader.hash().to_owned();
                        let failed = reader.failure_flag();
                        let document = super::engine::open(
                            reader,
                            (!password.is_empty()).then_some(password.as_str()),
                        )?;
                        if failed.load(Ordering::Acquire) {
                            return Err(PdfError::Resource);
                        }
                        let count = document.page_count();
                        if count == 0 {
                            return Err(PdfError::Invalid);
                        }
                        if closed.load(Ordering::Acquire) {
                            return Err(PdfError::Cancelled);
                        }
                        let _ = ready.send_blocking(Ok((count, hash)));
                        while let Ok(job) = pending.recv_blocking() {
                            let cancelled = || {
                                closed.load(Ordering::Acquire)
                                    || generation.load(Ordering::Acquire) != job.generation
                            };
                            if closed.load(Ordering::Acquire) {
                                break;
                            }
                            let result = super::engine::render(
                                &document, job.page, job.edge, job.text, cancelled,
                            );
                            let result = if failed.load(Ordering::Acquire) {
                                Err(PdfError::Resource)
                            } else {
                                result
                            };
                            let _ = job.reply.try_send(result);
                        }
                        Ok(())
                    })();
                    if let Err(error) = result {
                        let _ = ready.try_send(Err(error));
                    }
                }
                #[cfg(not(feature = "media"))]
                {
                    let _ = (client, scope, password, closed, generation, pending);
                    let _ = ready.try_send(Err(PdfError::Unavailable));
                }
            });
        (worker, receiver)
    }
    pub fn render(
        &self,
        page: u16,
        edge: u32,
        text: bool,
    ) -> async_channel::Receiver<Result<PageRaster, PdfError>> {
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        #[cfg(not(feature = "media"))]
        let _ = (page, edge, text, generation);
        let (reply, receiver) = async_channel::bounded(1);
        if let Ok(old) = self.pending.try_recv() {
            let _ = old.reply.try_send(Err(PdfError::Cancelled));
        }
        if self
            .sender
            .try_send(RenderRequest {
                #[cfg(feature = "media")]
                page,
                #[cfg(feature = "media")]
                edge,
                #[cfg(feature = "media")]
                text,
                #[cfg(feature = "media")]
                generation,
                reply: reply.clone(),
            })
            .is_err()
        {
            let _ = reply.try_send(Err(PdfError::Cancelled));
        }
        receiver
    }
    pub fn cancel(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        if let Ok(old) = self.pending.try_recv() {
            let _ = old.reply.try_send(Err(PdfError::Cancelled));
        }
    }
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.cancel();
        self.sender.close();
    }
}
impl Drop for PdfWorker {
    fn drop(&mut self) {
        self.close();
    }
}
