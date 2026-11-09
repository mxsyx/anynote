//! Native whiteboard with explicit revision-scoped persistence.
mod assets;
mod clipboard;
mod geometry;
mod input;
mod paint;
#[cfg(test)]
mod tests;
mod text;
mod view;

pub use geometry::{Viewport, hit_test};
pub use input::{BoardInput, Tool};
pub use view::{BoardView, install_actions};

pub mod persistence;

pub mod preview;

mod session;
pub use session::{BoardEvent, BoardSession};
