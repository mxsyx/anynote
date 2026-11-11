//! Excalidraw scene data and atomic, reversible edits, independent of any view.
//!
//! The original JSON is returned verbatim until an effective edit. Unknown fields
//! remain data; this module never resolves file URLs or executes embedded content.
mod binding;
mod command;
mod crop;
mod frame;
mod geometry;
mod operation;
mod order;
mod path;
mod rough_path;
mod scene;

pub use command::{Alignment, Axis, Board, Command, EditStamp, Layer};
pub use crop::CropHandle;
pub use geometry::{Geometry, Point};
pub use scene::{BoardError, Element, ElementKind, Scene};
