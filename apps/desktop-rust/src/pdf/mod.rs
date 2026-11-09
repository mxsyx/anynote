//! Native PDF reading, selection, annotations and bounded text indexing.
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

mod index;
mod search;
pub mod selection;
pub(crate) mod service;
