use super::geometry::number;
use anynote_editor::board::Element;
use resvg::{tiny_skia::Path, usvg};
use std::sync::{Arc, LazyLock};

static BOARD_FONTS: LazyLock<Arc<usvg::fontdb::Database>> = LazyLock::new(|| {
    let mut fonts = crate::image::codec::font_database().as_ref().clone();
    // LastResort advertises every scalar but draws a missing-glyph box. Let the
    // fallback resolver reach real CJK/emoji fonts before accepting a placeholder.
    let placeholders: Vec<_> = fonts
        .faces()
        .filter(|face| {
            face.families
                .iter()
                .any(|(family, _)| family.contains("LastResort"))
        })
        .map(|face| face.id)
        .collect();
    for id in placeholders {
        fonts.remove_face(id);
    }
    Arc::new(fonts)
});

pub(super) struct TextLayout {
    pub paths: Vec<Path>,
    pub width: f64,
    pub height: f64,
}
fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
pub(super) fn layout(element: &Element, text: &str) -> Result<TextLayout, String> {
    if text.len() > 256 * 1024 {
        return Err("白板文字超过 256 KiB 上限".into());
    }
    let size = number(element, "fontSize", 20.).clamp(1., 512.);
    let height = size * number(element, "lineHeight", 1.25).clamp(0.5, 4.);
    let family = match element
        .field("fontFamily")
        .and_then(serde_json::Value::as_u64)
    {
        Some(3 | 8) => "monospace",
        _ => "sans-serif",
    };
    let mut svg = String::from(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100000\" height=\"100000\">",
    );
    for (i, line) in text.split('\n').enumerate() {
        svg.push_str(&format!("<text xml:space=\"preserve\" x=\"0\" y=\"{}\" font-family=\"{family}\" font-size=\"{size}\">{}</text>",size+i as f64*height,escape(line)));
    }
    svg.push_str("</svg>");
    let options = usvg::Options {
        fontdb: BOARD_FONTS.clone(),
        ..Default::default()
    };
    let tree = usvg::Tree::from_str(&svg, &options).map_err(|e| e.to_string())?;
    let mut paths = vec![];
    collect(tree.root(), &mut paths);
    let width = tree.root().abs_bounding_box().right() as f64;
    Ok(TextLayout {
        paths,
        width: width.max(1.),
        height: height * text.split('\n').count() as f64,
    })
}
fn collect(group: &usvg::Group, paths: &mut Vec<Path>) {
    for node in group.children() {
        match node {
            usvg::Node::Group(g) => collect(g, paths),
            usvg::Node::Text(t) => collect(t.flattened(), paths),
            usvg::Node::Path(p) => {
                if let Some(path) = p.data().clone().transform(p.abs_transform()) {
                    paths.push(path);
                }
            }
            _ => {}
        }
    }
}
