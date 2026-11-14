mod view;
pub(crate) use view::bundled_asset;
pub use view::{BoardView, install_actions};
pub mod persistence;
mod session;
pub use session::{BoardEvent, BoardSession};
