//! Offline package health check. Never acquires the user's catalog or writes data.
use std::borrow::Cow;
#[cfg(feature = "media")]
use std::io::Cursor;

pub(crate) const FONT: &[u8] = include_bytes!("../assets/fonts/NotoSans-Regular.ttf");

pub fn register_fonts(cx: &gpui_kit::App) -> Result<(), Box<dyn std::error::Error>> {
    cx.text_system()
        .add_fonts(vec![Cow::Borrowed(FONT)])
        .map_err(Into::into)
}

pub fn check() -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    #[cfg(not(feature = "media"))]
    return Err("release requires the media feature".into());
    #[cfg(feature = "media")]
    {
        let mut fonts = resvg::usvg::fontdb::Database::new();
        fonts.load_font_data(FONT.to_vec());
        if fonts.faces().next().is_none() {
            return Err("bundled font is invalid".into());
        }
        // A tiny generated document exercises the packaged ABI and rasterizer.
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] >>",
        ];
        let mut pdf = String::from("%PDF-1.4\n");
        let mut offsets = Vec::new();
        for (ix, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.push_str(&format!("{} 0 obj\n{object}\nendobj\n", ix + 1));
        }
        let xref = pdf.len();
        pdf.push_str("xref\n0 4\n0000000000 65535 f \n");
        for offset in offsets {
            pdf.push_str(&format!("{offset:010} 00000 n \n"));
        }
        pdf.push_str(&format!(
            "trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
        ));
        let document = crate::pdf::engine::open(Cursor::new(pdf.into_bytes()), None)
            .map_err(|_| "packaged Pdfium failed to load/open")?;
        crate::pdf::engine::render(&document, 0, 32, false, || false)
            .map_err(|_| "packaged Pdfium failed to render")?;
        Ok(serde_json::json!({
            "format": "anynote.release-check.v1",
            "appId": "app.anynote.desktop",
            "version": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "notebookSchema": 5,
            "pdfium": "passed",
            "font": "passed",
            "userData": "untouched"
        }))
    }
}
