use super::{Glyph, PageGeometry, PageRaster, PdfError};
use pdfium_render::prelude::*;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Seek},
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

fn error(error: PdfiumError) -> PdfError {
    match error {
        PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::PasswordError) => {
            PdfError::Password
        }
        _ => PdfError::Invalid,
    }
}
/// Pdfium initialization is process-global. All documents borrow this single engine.
fn native() -> Result<&'static Pdfium, PdfError> {
    static ENGINE: OnceLock<Pdfium> = OnceLock::new();
    if let Some(engine) = ENGINE.get() {
        return Ok(engine);
    }
    let engine = (|| {
        let directory = std::env::var_os("ANYNOTE_PDFIUM_DIR")
            .map(PathBuf::from)
            .or_else(|| {
                let executable = std::env::current_exe().ok()?;
                Some(executable.parent()?.join(if cfg!(target_os = "macos") {
                    "../Resources/pdfium"
                } else {
                    "pdfium"
                }))
            })
            .ok_or(PdfError::Unavailable)?;
        if !directory.is_absolute() {
            return Err(PdfError::Unavailable);
        }
        let version = std::fs::read_to_string(directory.join("VERSION"))
            .map_err(|_| PdfError::Unavailable)?;
        if !version.lines().any(|line| line == "BUILD=7350") {
            return Err(PdfError::Unavailable);
        }
        let platform = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("macos", "aarch64") => "pdfium-mac-arm64.tgz",
            ("macos", "x86_64") => "pdfium-mac-x64.tgz",
            ("linux", "x86_64") => "pdfium-linux-x64.tgz",
            ("windows", "aarch64") => "pdfium-win-arm64.tgz",
            ("windows", "x86_64") => "pdfium-win-x64.tgz",
            _ => return Err(PdfError::Unavailable),
        };
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../native/pdfium.json"))
                .map_err(|_| PdfError::Unavailable)?;
        let asset = manifest["assets"]
            .as_array()
            .and_then(|assets| assets.iter().find(|asset| asset["name"] == platform))
            .ok_or(PdfError::Unavailable)?;
        let path = directory.join(
            asset["library_path"]
                .as_str()
                .ok_or(PdfError::Unavailable)?,
        );
        let mut file = std::fs::File::open(&path).map_err(|_| PdfError::Unavailable)?;
        let mut digest = Sha256::new();
        let mut buffer = [0; 64 * 1024];
        loop {
            let length = file.read(&mut buffer).map_err(|_| PdfError::Unavailable)?;
            if length == 0 {
                break;
            }
            digest.update(&buffer[..length]);
        }
        // Signing changes the library bytes. Release builds pin the already signed
        // library at compile time, after the packager checks the upstream pin.
        let expected = option_env!("ANYNOTE_PACKAGED_PDFIUM_SHA256")
            .or_else(|| asset["library_sha256"].as_str());
        if expected != Some(format!("{:x}", digest.finalize()).as_str()) {
            return Err(PdfError::Unavailable);
        }
        Pdfium::bind_to_library(path)
            .map(Pdfium::new)
            .map_err(|_| PdfError::Unavailable)
    })()?;
    let _ = ENGINE.set(engine);
    ENGINE.get().ok_or(PdfError::Unavailable)
}
// 7350's font mapper can race across complete API sequences despite binding-level locks.
// Keep open/page/text/render/drop mutually exclusive, without locking an idle session.
static OPERATIONS: Mutex<()> = Mutex::new(());
pub struct NativeDocument<'a> {
    document: Option<PdfDocument<'a>>,
}
impl NativeDocument<'_> {
    pub fn page_count(&self) -> u16 {
        let _operation = OPERATIONS.lock().unwrap_or_else(|e| e.into_inner());
        self.document.as_ref().unwrap().pages().len()
    }
}
impl Drop for NativeDocument<'_> {
    fn drop(&mut self) {
        let _operation = OPERATIONS.lock().unwrap_or_else(|e| e.into_inner());
        drop(self.document.take());
    }
}
pub fn open<R: Read + Seek + 'static>(
    reader: R,
    password: Option<&str>,
) -> Result<NativeDocument<'_>, PdfError> {
    let _operation = OPERATIONS.lock().unwrap_or_else(|e| e.into_inner());
    native()?
        .load_pdf_from_reader(reader, password)
        .map(|document| NativeDocument {
            document: Some(document),
        })
        .map_err(error)
}
fn rect(rect: PdfRect) -> [f32; 4] {
    [
        rect.left().value,
        rect.bottom().value,
        rect.right().value,
        rect.top().value,
    ]
}

pub fn render(
    document: &NativeDocument<'_>,
    page: u16,
    edge: u32,
    text: bool,
    cancelled: impl Fn() -> bool,
) -> Result<PageRaster, PdfError> {
    let _operation = OPERATIONS.lock().unwrap_or_else(|e| e.into_inner());
    let document = document.document.as_ref().unwrap();
    if cancelled() {
        return Err(PdfError::Cancelled);
    }
    if !(32..=4096).contains(&edge) {
        return Err(PdfError::Budget);
    }
    let page_handle = document.pages().get(page).map_err(error)?;
    let size = [page_handle.width().value, page_handle.height().value];
    if size
        .iter()
        .any(|v| !v.is_finite() || *v <= 0. || *v > 100_000.)
    {
        return Err(PdfError::Invalid);
    }
    let scale = edge as f32 / size[0].max(size[1]);
    let width = (size[0] * scale).round().max(1.) as i32;
    let height = (size[1] * scale).round().max(1.) as i32;
    let config = PdfRenderConfig::new()
        .set_target_size(width, height)
        .limit_render_image_cache_size(true);
    let point = |x, y| {
        page_handle
            .pixels_to_points(x, y, &config)
            .map(|(x, y)| [f64::from(x.value), f64::from(y.value)])
            .map_err(error)
    };
    let crop = page_handle
        .boundaries()
        .crop()
        .or_else(|_| page_handle.boundaries().media())
        .map_err(error)?;
    let rotation = match page_handle.rotation().map_err(error)? {
        PdfPageRenderRotation::None => 0,
        PdfPageRenderRotation::Degrees90 => 90,
        PdfPageRenderRotation::Degrees180 => 180,
        PdfPageRenderRotation::Degrees270 => 270,
    };
    let geometry = PageGeometry::new(
        size,
        rect(crop.bounds),
        rotation,
        [point(0, 0)?, point(width, 0)?, point(0, height)?],
    );
    let mut glyphs = Vec::new();
    let mut content = String::new();
    if text {
        let text_page = page_handle.text().map_err(error)?;
        let chars = text_page.chars();
        if chars.len() > 100_000 {
            return Err(PdfError::Budget);
        }
        let mut utf16 = 0;
        for ch in chars.iter() {
            if cancelled() {
                return Err(PdfError::Cancelled);
            }
            let value = ch.unicode_char().map(|c| c.to_string()).unwrap_or_default();
            let end = utf16 + value.encode_utf16().count();
            content.push_str(&value);
            glyphs.push(Glyph {
                index: ch.index(),
                text: value,
                utf16: utf16..end,
                bounds: ch.tight_bounds().ok().map(rect),
                angle: ch.angle_degrees().unwrap_or(0.),
            });
            utf16 = end;
        }
    }
    if cancelled() {
        return Err(PdfError::Cancelled);
    }
    let bitmap = page_handle.render_with_config(&config).map_err(error)?;
    if cancelled() {
        return Err(PdfError::Cancelled);
    }
    let pixels = image::RgbaImage::from_raw(
        bitmap.width() as u32,
        bitmap.height() as u32,
        bitmap.as_rgba_bytes(),
    )
    .ok_or(PdfError::Invalid)?;
    Ok(PageRaster {
        page,
        geometry,
        pixels,
        glyphs,
        text: content,
    })
}

/// Extract text without allocating a page bitmap. The remaining budget counts UTF-16 units.
pub fn extract(
    document: &NativeDocument<'_>,
    page: u16,
    budget: usize,
    cancelled: impl Fn() -> bool,
) -> Result<(String, bool), PdfError> {
    let _operation = OPERATIONS.lock().unwrap_or_else(|e| e.into_inner());
    if cancelled() {
        return Err(PdfError::Cancelled);
    }
    let page = document
        .document
        .as_ref()
        .unwrap()
        .pages()
        .get(page)
        .map_err(error)?;
    let text = page.text().map_err(error)?;
    let mut body = String::new();
    let mut units = 0;
    for ch in text.chars().iter() {
        if cancelled() {
            return Err(PdfError::Cancelled);
        }
        if let Some(c) = ch.unicode_char() {
            if units + c.len_utf16() > budget {
                return Ok((body, true));
            }
            units += c.len_utf16();
            body.push(c);
        }
    }
    Ok((body, false))
}
