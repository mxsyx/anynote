//! Offline package health check. Never acquires the user's catalog or writes data.
use std::borrow::Cow;

pub(crate) const FONT: &[u8] = include_bytes!("../assets/fonts/NotoSans-Regular.ttf");

pub fn register_fonts(cx: &gpui_kit::App) -> Result<(), Box<dyn std::error::Error>> {
    cx.text_system()
        .add_fonts(vec![Cow::Borrowed(FONT)])
        .map_err(Into::into)
}

pub fn check() -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let mut fonts = resvg::usvg::fontdb::Database::new();
    fonts.load_font_data(FONT.to_vec());
    if fonts.faces().next().is_none() {
        return Err("bundled font is invalid".into());
    }
    if crate::board::bundled_asset("index.html").is_none_or(|b| b.is_empty())
        || crate::board::bundled_asset("THIRD_PARTY_NOTICES.txt").is_none_or(|b| b.is_empty())
    {
        return Err("bundled whiteboard assets are missing".into());
    }
    Ok(serde_json::json!({
        "format": "anynote.release-check.v1",
        "appId": "app.anynote.desktop",
        "version": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "notebookSchema": 5,
        "pdfViewer": "system-webview",
        "font": "passed",
        "whiteboard": "passed",
        "userData": "untouched"
    }))
}
