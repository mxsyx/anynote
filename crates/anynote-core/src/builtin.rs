//! Statically shipped notebook commands and settings. No executable declarations.
use crate::document_session::DocumentSnapshot;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReadingCommand {
    CreateRecord,
    AppendTemplate,
    Count,
    Related,
    AsyncRelated,
    AppendGoal,
    RecordSession,
    PublicText { url: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadingRequest {
    operation: Uuid,
    base: DocumentSnapshot,
    command: ReadingCommand,
}
impl ReadingRequest {
    pub fn new(operation: Uuid, base: DocumentSnapshot, command: ReadingCommand) -> Self {
        Self {
            operation,
            base,
            command,
        }
    }
    pub fn operation(&self) -> Uuid {
        self.operation
    }
    pub fn base(&self) -> &DocumentSnapshot {
        &self.base
    }
    pub fn command(&self) -> &ReadingCommand {
        &self.command
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[non_exhaustive]
pub struct NotebookPreferences {
    pub heading: String,
    pub goal: u32,
    pub enabled: bool,
    pub whiteboard: bool,
    pub video: bool,
    pub html: bool,
    pub remote_embed: bool,
}
impl Default for NotebookPreferences {
    fn default() -> Self {
        Self {
            heading: "阅读目标".into(),
            goal: 3,
            enabled: true,
            whiteboard: true,
            video: true,
            html: true,
            remote_embed: false,
        }
    }
}
impl NotebookPreferences {
    pub fn is_valid(&self) -> bool {
        self.heading.encode_utf16().count() <= 80 && (1..=100).contains(&self.goal)
    }
}
