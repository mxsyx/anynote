//! Services boundary for the native AnyNote desktop.
pub mod diagnostics;
pub mod resources;
pub mod scheduler;
pub mod tasks;

pub mod config_migration;
pub mod importer;
pub mod migration;
pub mod network;

pub mod transfer;

pub mod archive;
pub mod cloud;
pub mod open_export;

pub mod builtin;
pub mod local_backup;

pub mod video;

pub mod workspace;

pub mod management;
