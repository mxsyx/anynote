//! System PDF preview. The viewer owns navigation, selection and document-local search.
mod reader;
mod server;
mod view;
pub use server::PdfServer;
pub use view::PdfView;
