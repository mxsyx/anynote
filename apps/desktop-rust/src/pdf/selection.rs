use super::PageRaster;
use anynote_core::{image::ImageRect, pdf::AnnotationDraft};
use std::ops::Range;

pub fn hit(raster: &PageRaster, point: [f64; 2]) -> Option<usize> {
    raster
        .glyphs()
        .iter()
        .filter_map(|g| {
            let rect = rectangle(raster, g.bounds()?)?;
            let dx = (rect.x - point[0])
                .max(0.)
                .max(point[0] - rect.x - rect.width);
            let dy = (rect.y - point[1])
                .max(0.)
                .max(point[1] - rect.y - rect.height);
            Some((g.index(), dx * dx + dy * dy))
        })
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(ix, _)| ix)
}
fn rectangle(raster: &PageRaster, bounds: [f32; 4]) -> Option<ImageRect> {
    let quad = raster.geometry().normalized_quad(bounds);
    let x = quad
        .iter()
        .map(|p| p[0])
        .fold(f64::INFINITY, f64::min)
        .clamp(0., 1.);
    let y = quad
        .iter()
        .map(|p| p[1])
        .fold(f64::INFINITY, f64::min)
        .clamp(0., 1.);
    let right = quad
        .iter()
        .map(|p| p[0])
        .fold(f64::NEG_INFINITY, f64::max)
        .clamp(0., 1.);
    let bottom = quad
        .iter()
        .map(|p| p[1])
        .fold(f64::NEG_INFINITY, f64::max)
        .clamp(0., 1.);
    let rect = ImageRect {
        x,
        y,
        width: right - x,
        height: bottom - y,
    };
    rect.is_valid().then_some(rect)
}
pub fn select(raster: &PageRaster, range: Range<usize>, body: String) -> AnnotationDraft {
    let mut quote = String::new();
    let mut rectangles: Vec<ImageRect> = vec![];
    for glyph in raster
        .glyphs()
        .iter()
        .filter(|g| range.contains(&g.index()))
    {
        quote.push_str(glyph.text());
        if let Some(rect) = glyph.bounds().and_then(|r| rectangle(raster, r)) {
            if let Some(last) = rectangles.last_mut() {
                let horizontal = (last.y - rect.y).abs() < last.height.min(rect.height) * 0.6
                    && rect.x >= last.x
                    && rect.x - last.x - last.width < last.height;
                let vertical = (last.x - rect.x).abs() < last.width.min(rect.width) * 0.6
                    && rect.y >= last.y
                    && rect.y - last.y - last.height < last.width;
                if horizontal || vertical {
                    let right = (last.x + last.width).max(rect.x + rect.width);
                    let bottom = (last.y + last.height).max(rect.y + rect.height);
                    last.x = last.x.min(rect.x);
                    last.y = last.y.min(rect.y);
                    last.width = right - last.x;
                    last.height = bottom - last.y;
                    continue;
                }
            }
            rectangles.push(rect);
        }
    }
    AnnotationDraft::new(raster.page() + 1, rectangles, quote, body)
}
pub fn utf16_selection(raster: &PageRaster, range: Range<usize>) -> Option<Range<usize>> {
    let mut glyphs = raster
        .glyphs()
        .iter()
        .filter(|g| g.utf16_range().start < range.end && g.utf16_range().end > range.start);
    let first = glyphs.next()?.index();
    let last = glyphs.next_back().map_or(first, |g| g.index());
    Some(first..last + 1)
}
#[derive(Clone, Debug)]
pub struct SearchHit {
    page: u16,
    range: Range<usize>,
}
impl SearchHit {
    pub fn page(&self) -> u16 {
        self.page
    }
    pub fn range(&self) -> Range<usize> {
        self.range.clone()
    }
}
pub fn find(text: &str, query: &str, page: u16) -> Vec<SearchHit> {
    anynote_core::pdf::search_ranges(text, query)
        .into_iter()
        .map(|range| SearchHit { page, range })
        .collect()
}
