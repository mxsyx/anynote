mod capture;
mod directory;
mod html;
mod media;
mod preview;
pub use anynote_core::protocol::import::*;
pub use capture::canonical;
pub use directory::DirectoryGrant;
pub use html::{ConvertedHtml, convert_html, decode_html};
pub use preview::{ImportInput, ImportOptions, ImportService, PreviewSummary, PreviewTarget};
pub use tokio_util::sync::CancellationToken;

#[derive(Debug)]
pub struct ImportError {
    pub message: String,
    pub cancelled: bool,
}
impl ImportError {
    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            cancelled: false,
        }
    }
    pub(crate) fn cancelled() -> Self {
        Self {
            message: "导入已取消".into(),
            cancelled: true,
        }
    }
}
impl std::fmt::Display for ImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for ImportError {}
macro_rules! from_error {($($ty:ty),*)=>{$(impl From<$ty> for ImportError {fn from(e:$ty)->Self{Self::invalid(e.to_string())}})*};}
from_error!(
    std::io::Error,
    serde_json::Error,
    reqwest::Error,
    zip::result::ZipError,
    anynote_storage::notebook::ReadError
);
pub type ImportResult<T> = Result<T, ImportError>;
pub(crate) fn check(ok: bool, message: &str) -> ImportResult<()> {
    if ok {
        Ok(())
    } else {
        Err(ImportError::invalid(message))
    }
}
pub(crate) fn cancelled(token: &CancellationToken) -> ImportResult<()> {
    if token.is_cancelled() {
        Err(ImportError::cancelled())
    } else {
        Ok(())
    }
}
pub(crate) fn timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub(crate) fn truncate_utf16(text: &str, max: usize) -> String {
    let mut units = 0;
    text.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= max
        })
        .collect()
}
