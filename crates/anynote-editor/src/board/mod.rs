//! Excalidraw scene data and atomic, reversible edits, independent of any view.
//!
//! The original JSON is returned verbatim until an effective edit. Unknown fields
//! remain data; this module never resolves file URLs or executes embedded content.
mod binding;
mod command;
mod crop;
mod frame;
mod geometry;
mod library;
mod operation;
mod order;
mod path;
mod rough_path;
mod scene;
mod transfer;

pub use command::{Alignment, Axis, Board, Command, EditStamp, Layer};
pub use crop::CropHandle;
pub use geometry::{Geometry, Point};
pub use library::Library;
pub use rough_path::linear_strokes;
pub use scene::{BoardError, Element, ElementKind, Scene};
pub use transfer::{Clipboard, TransferIds};
