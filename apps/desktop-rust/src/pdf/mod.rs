//! Native PDF reading. Domain selection, annotations and indexing are added in RM26.
#[cfg(feature = "media")]
pub mod engine;
mod geometry;
mod reader;
mod view;
mod worker;
pub use geometry::{Glyph, PageGeometry, PageRaster, PdfError, Zoom};
pub use reader::ResourceReader;
pub use view::PdfView;
pub use worker::PdfWorker;
