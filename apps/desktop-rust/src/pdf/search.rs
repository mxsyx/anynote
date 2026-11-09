use super::{PdfError, selection::SearchHit};
use crate::backend_client::BackendClient;
use anynote_core::asset::AssetScope;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
type SearchResult = async_channel::Receiver<Result<(Vec<SearchHit>, bool), PdfError>>;
pub(crate) struct SearchJob(Arc<AtomicBool>);
impl Drop for SearchJob {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}
pub(crate) fn run(
    client: BackendClient,
    scope: AssetScope,
    password: String,
    query: String,
) -> (SearchJob, SearchResult) {
    let cancelled = Arc::new(AtomicBool::new(false));
    let job = SearchJob(cancelled.clone());
    let (send, receive) = async_channel::bounded(1);
    std::thread::spawn(move || {
        #[cfg(feature = "media")]
        let result = (|| {
            let reader = super::ResourceReader::open(client, scope, cancelled.clone())?;
            let failure = reader.failure_flag();
            let doc =
                super::engine::open(reader, (!password.is_empty()).then_some(password.as_str()))?;
            let mut remaining = anynote_core::pdf::MAX_INDEX_UTF16;
            let total = doc.page_count();
            let pages = total.min(anynote_core::pdf::MAX_INDEX_PAGES as u16);
            let mut hits = vec![];
            let mut partial = pages < total;
            for page in 0..pages {
                let (text, truncated) = super::engine::extract(&doc, page, remaining, || {
                    cancelled.load(Ordering::Acquire)
                })?;
                remaining -= text.encode_utf16().count();
                hits.extend(super::selection::find(&text, &query, page));
                if failure.load(Ordering::Acquire) {
                    return Err(PdfError::Resource);
                }
                if truncated || hits.len() >= 1000 {
                    hits.truncate(1000);
                    partial = true;
                    break;
                }
            }
            if cancelled.load(Ordering::Acquire) {
                return Err(PdfError::Cancelled);
            }
            Ok((hits, partial))
        })();
        #[cfg(not(feature = "media"))]
        let result = {
            let _ = (client, scope, password, query, cancelled);
            Err(PdfError::Unavailable)
        };
        let _ = send.try_send(result);
    });
    (job, receive)
}
