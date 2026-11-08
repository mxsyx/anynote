//! Services boundary for the native AnyNote desktop.
pub mod diagnostics;
pub mod resources;
pub mod scheduler;
pub mod tasks;

pub mod config_migration;
pub mod importer;
pub mod network;

pub mod transfer;

pub mod archive;
pub mod open_export;
pub mod cloud;

pub mod local_backup;
