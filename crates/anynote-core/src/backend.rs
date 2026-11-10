//! Versioned private desktop protocol; no arbitrary method names or executable payloads.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const PROTOCOL_VERSION: u32 = 6;
// A storage body allows two million UTF-16 units; JSON escapes can use six bytes each.
pub const MAX_CONTROL_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_CHUNK_BYTES: usize = 256 * 1024;
pub const QUEUE_CAPACITY: usize = 16;
pub const MAX_PENDING_REQUESTS: usize = QUEUE_CAPACITY - 2;
pub const MAX_ACTIVE_TASKS: usize = 8;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidRequest,
    FrameTooLarge,
    InvalidToken,
    StaleSession,
    Busy,
    Cancelled,
    Timeout,
    Disconnected,
    Storage,
    Conflict,
    NotFound,
    ShuttingDown,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ServiceError {
    code: ErrorCode,
}
impl ServiceError {
    pub fn new(code: ErrorCode) -> Self {
        Self { code }
    }
    pub fn code(&self) -> ErrorCode {
        self.code
    }
}
impl std::fmt::Display for ServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "backend: {:?}", self.code)
    }
}
impl std::error::Error for ServiceError {}
pub type ServiceResult<T> = Result<T, ServiceError>;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticLevel {
    Off,
    Minimal,
    Full,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticKind {
    BackendStarted,
    RequestCompleted,
    RequestRejected,
    TaskChanged,
    ConfigRecovered,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticEvent {
    timestamp_ms: u64,
    kind: DiagnosticKind,
    code: Option<ErrorCode>,
    elapsed_ms: u64,
    bytes: u64,
}
impl DiagnosticEvent {
    pub fn new(kind: DiagnosticKind, code: Option<ErrorCode>, elapsed_ms: u64, bytes: u64) -> Self {
        Self {
            timestamp_ms: timestamp_ms(),
            kind,
            code,
            elapsed_ms,
            bytes,
        }
    }
    pub fn timestamp_ms(&self) -> u64 {
        self.timestamp_ms
    }
    pub fn elapsed_ms(&self) -> u64 {
        self.elapsed_ms
    }
    pub fn bytes(&self) -> u64 {
        self.bytes
    }
    pub fn kind(&self) -> DiagnosticKind {
        self.kind
    }
    pub fn code(&self) -> Option<ErrorCode> {
        self.code
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticSnapshot {
    level: DiagnosticLevel,
    events: Vec<DiagnosticEvent>,
    dropped: u64,
    samples: u64,
}
impl DiagnosticSnapshot {
    pub fn new(
        level: DiagnosticLevel,
        events: Vec<DiagnosticEvent>,
        dropped: u64,
        samples: u64,
    ) -> Self {
        Self {
            level,
            events,
            dropped,
            samples,
        }
    }
    pub fn level(&self) -> DiagnosticLevel {
        self.level
    }
    pub fn events(&self) -> &[DiagnosticEvent] {
        &self.events
    }
    pub fn dropped(&self) -> u64 {
        self.dropped
    }
    pub fn samples(&self) -> u64 {
        self.samples
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RecoveryPolicy {
    ReadOnly,
    Receipt {
        operation_id: Uuid,
    },
    Revision {
        notebook_id: Uuid,
        node_id: Uuid,
        expected_revision: u64,
    },
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Running,
    Committing,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}
impl TaskStatus {
    pub fn is_active(self) -> bool {
        matches!(self, Self::Running | Self::Committing)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskRecord {
    created_at_ms: u64,
    updated_at_ms: u64,
    id: Uuid,
    sequence: u64,
    status: TaskStatus,
    recovery: RecoveryPolicy,
}
impl TaskRecord {
    pub fn new(id: Uuid, recovery: RecoveryPolicy) -> Self {
        let now = timestamp_ms();
        Self {
            created_at_ms: now,
            updated_at_ms: now,
            id,
            sequence: 1,
            status: TaskStatus::Running,
            recovery,
        }
    }
    pub fn created_at_ms(&self) -> u64 {
        self.created_at_ms
    }
    pub fn updated_at_ms(&self) -> u64 {
        self.updated_at_ms
    }
    pub fn id(&self) -> Uuid {
        self.id
    }
    pub fn sequence(&self) -> u64 {
        self.sequence
    }
    pub fn status(&self) -> TaskStatus {
        self.status
    }
    pub fn recovery(&self) -> &RecoveryPolicy {
        &self.recovery
    }
    pub fn transition(&mut self, next: TaskStatus) -> ServiceResult<()> {
        let valid = match self.status {
            TaskStatus::Running => matches!(
                next,
                TaskStatus::Committing
                    | TaskStatus::Completed
                    | TaskStatus::Failed
                    | TaskStatus::Cancelled
                    | TaskStatus::Interrupted
            ),
            TaskStatus::Committing => matches!(
                next,
                TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Interrupted
            ),
            _ => false,
        };
        if !valid {
            return Err(ServiceError::new(ErrorCode::Conflict));
        }
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or_else(|| ServiceError::new(ErrorCode::Storage))?;
        self.updated_at_ms = timestamp_ms();
        self.status = next;
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "op",
    content = "input",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Command {
    Management(crate::management::ManagementCommand),
    Workspace(crate::workspace::WorkspaceCommand),
    VideoMetadata {
        card: crate::video::VideoCard,
    },
    Pdf(crate::pdf::PdfCommand),
    Asset(crate::asset::AssetCommand),
    Image(crate::image::ImageCommand),
    RunReading(crate::builtin::ReadingRequest),
    GetNotebookPreferences {
        notebook: Uuid,
    },
    SetNotebookPreferences {
        notebook: Uuid,
        expected: i64,
        preferences: crate::builtin::NotebookPreferences,
    },
    CreateDocument,
    OpenLastDocument,
    OpenDocument {
        id: crate::document_session::DocumentId,
    },
    SaveDocument(crate::document_session::SaveDocument),
    SaveBoard(crate::board::BoardSave),
    DocumentResource {
        id: crate::document_session::DocumentId,
        revision: Uuid,
        resource: Uuid,
        offset: u64,
        length: u32,
    },
    Ping,
    StartHealthCheck {
        delay_ms: u64,
    },
    CancelTask {
        task_id: Uuid,
    },
    ListTasks,
    WaitTask {
        task_id: Uuid,
    },
    CancelWait {
        request_id: u64,
    },
    GetDiagnostics,
    SetDiagnosticLevel {
        level: DiagnosticLevel,
    },
    ClearDiagnostics,
    ExportDiagnostics,
    ReadResource {
        token: Uuid,
        offset: u64,
        length: u32,
    },
    ReleaseResource {
        token: Uuid,
    },
    Shutdown,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    version: u32,
    epoch: Uuid,
    request_id: u64,
    command: Command,
}
impl Request {
    pub fn new(epoch: Uuid, request_id: u64, command: Command) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            epoch,
            request_id,
            command,
        }
    }
    pub fn epoch(&self) -> Uuid {
        self.epoch
    }
    pub fn id(&self) -> u64 {
        self.request_id
    }
    pub fn command(&self) -> &Command {
        &self.command
    }
    pub fn is_current(&self, epoch: Uuid) -> bool {
        self.version == PROTOCOL_VERSION && self.epoch == epoch && self.request_id > 0
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Reply {
    Management(crate::management::ManagementReply),
    Workspace(crate::workspace::WorkspaceReply),
    VideoMetadata(crate::video::Metadata),
    Pdf(crate::pdf::PdfReply),
    Asset(crate::asset::AssetReply),
    Image(crate::image::ImageReply),
    Reading(crate::document_session::DocumentSnapshot),
    NotebookPreferences {
        revision: i64,
        preferences: crate::builtin::NotebookPreferences,
    },
    Document(crate::document_session::DocumentSnapshot),
    DocumentSaved(crate::document_session::SaveDocument),
    DocumentResource {
        bytes: Vec<u8>,
    },
    Pong,
    Task(TaskRecord),
    Tasks(Vec<TaskRecord>),
    Diagnostics(DiagnosticSnapshot),
    Resource {
        token: Uuid,
        length: u64,
    },
    Ack,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ServerMessage {
    Ready {
        version: u32,
        epoch: Uuid,
    },
    Response {
        epoch: Uuid,
        request_id: u64,
        result: ServiceResult<Reply>,
    },
    TaskEvent {
        epoch: Uuid,
        task: TaskRecord,
    },
    ProtocolError {
        error: ServiceError,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct StreamHeader {
    epoch: Uuid,
    request_id: u64,
    token: Uuid,
    offset: u64,
    end: bool,
}
impl StreamHeader {
    pub fn new(epoch: Uuid, request_id: u64, token: Uuid, offset: u64, end: bool) -> Self {
        Self {
            epoch,
            request_id,
            token,
            offset,
            end,
        }
    }
    pub fn epoch(&self) -> Uuid {
        self.epoch
    }
    pub fn request_id(&self) -> u64 {
        self.request_id
    }
    pub fn token(&self) -> Uuid {
        self.token
    }
    pub fn offset(&self) -> u64 {
        self.offset
    }
    pub fn is_end(&self) -> bool {
        self.end
    }
}

fn timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
