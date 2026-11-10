//! Typed management commands and presentation data shared by the backend and GPUI.
use crate::backend::{TaskRecord, TaskStatus};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    Overview,
    AttachRestored {
        path: PathBuf,
    },
    Integrity {
        notebook: String,
    },
    CleanupPreview {
        notebook: String,
        keep: usize,
        days: u32,
    },
    CleanupApply {
        notebook: String,
        plan: String,
    },
    CleanupRecover {
        notebook: String,
        plan: String,
    },
    CleanupPurge {
        notebook: String,
        plan: String,
    },
    AddLocal {
        directory: PathBuf,
        name: String,
        notebooks: Vec<String>,
        interval_minutes: u32,
    },
    ConnectLocal {
        directory: PathBuf,
        name: String,
    },
    LocalContents {
        target: String,
        offset: usize,
    },
    UpdateLocal {
        target: String,
        notebooks: Vec<String>,
        interval_minutes: u32,
    },
    LocalBackup {
        target: String,
    },
    LocalVerify {
        target: String,
        notebook: String,
    },
    LocalRestore {
        target: String,
        notebook: String,
        destination: PathBuf,
    },
    ArchiveRestore {
        archive: PathBuf,
        destination: PathBuf,
    },
    SaveConnection {
        name: String,
        endpoint: String,
        token: String,
    },
    TestConnection {
        connection: String,
    },
    Discover {
        connection: String,
        cursor: Option<String>,
    },
    AddCloud {
        connection: String,
        notebook: String,
        interval_minutes: u32,
    },
    SetPaused {
        target: String,
        paused: bool,
    },
    CloudBackup {
        target: String,
    },
    CloudStatus {
        target: String,
    },
    CloudRestore {
        connection: String,
        notebook: String,
        lineage: String,
        generation: String,
        destination: PathBuf,
    },
    WriterPreview {
        target: String,
    },
    WriterTakeover {
        target: String,
        head: String,
        epoch: u64,
        request: String,
    },
    WriterResume {
        target: String,
    },
    RetentionSave {
        target: String,
        keep: u16,
        days: u16,
        weeks: u16,
        months: u16,
    },
    RetentionPreview {
        target: String,
    },
    RetentionApply {
        target: String,
        plan: String,
    },
    RetentionResume {
        target: String,
    },
    RetentionRecover {
        target: String,
        plan: String,
    },
    Maintenance {
        target: String,
    },
    ReleaseLegacyLock {
        target: String,
        plan: String,
        execution: String,
    },
    Devices {
        connection: String,
    },
    PairDevice {
        target: String,
    },
    RevokeDevice {
        connection: String,
        device: String,
    },
    ConsumeCaptures {
        target: String,
    },
    RunScheduled,
}
impl Operation {
    pub fn title(&self) -> &'static str {
        match self {
            Self::Overview => "刷新管理页",
            Self::AttachRestored { .. } => "登记已恢复笔记本",
            Self::Integrity { .. } => "检查笔记本完整性",
            Self::CleanupPreview { .. } => "预览本地清理",
            Self::CleanupApply { .. } => "隔离过期快照",
            Self::CleanupRecover { .. } => "恢复隔离快照",
            Self::CleanupPurge { .. } => "永久删除隔离快照",
            Self::AddLocal { .. } => "添加本地备份目标",
            Self::ConnectLocal { .. } => "连接已有备份磁盘",
            Self::UpdateLocal { .. } => "修改本地备份范围",
            Self::LocalContents { .. } => "浏览本地备份",
            Self::LocalBackup { .. } => "备份到本地磁盘",
            Self::LocalVerify { .. } => "校验本地备份",
            Self::LocalRestore { .. } => "从本地备份恢复",
            Self::ArchiveRestore { .. } => "从归档恢复",
            Self::SaveConnection { .. } => "保存云连接",
            Self::TestConnection { .. } => "测试云连接",
            Self::Discover { .. } => "浏览云备份",
            Self::AddCloud { .. } => "添加云备份目标",
            Self::SetPaused { paused: true, .. } => "暂停自动备份",
            Self::SetPaused { .. } => "启用自动备份",
            Self::CloudBackup { .. } => "备份到云端",
            Self::CloudStatus { .. } => "查看云备份状态",
            Self::CloudRestore { .. } => "从云备份恢复",
            Self::WriterPreview { .. } => "查看云端写入设备",
            Self::WriterTakeover { .. } => "接管云端写入",
            Self::WriterResume { .. } => "核对写入接管结果",
            Self::RetentionSave { .. } => "保存云端保留策略",
            Self::RetentionPreview { .. } => "预览云端清理",
            Self::RetentionApply { .. } => "执行云端清理",
            Self::RetentionResume { .. } => "继续已确认的云端清理",
            Self::RetentionRecover { .. } => "恢复云端维护任务",
            Self::Maintenance { .. } => "检查云端维护",
            Self::ReleaseLegacyLock { .. } => "释放旧维护锁",
            Self::Devices { .. } => "查看采集设备",
            Self::PairDevice { .. } => "配对采集设备",
            Self::RevokeDevice { .. } => "撤销采集设备",
            Self::ConsumeCaptures { .. } => "接收采集内容",
            Self::RunScheduled => "检查自动备份",
        }
    }
    pub fn confirmation(&self) -> Option<String> {
        Some(match self {
            Self::CleanupApply { notebook, plan } => {
                format!("将笔记本 {notebook} 的预览 {plan} 所列快照移入隔离区。隔离后仍可恢复。")
            }
            Self::CleanupPurge { notebook, plan } => {
                format!("永久删除笔记本 {notebook} 隔离区 {plan} 的文件，无法撤销。")
            }
            Self::WriterTakeover { target, epoch, .. } => format!(
                "接管目标 {target} 的云端写入权限（当前版本 {epoch}）。其他设备将无法继续写入，自动备份保持暂停。"
            ),
            Self::RetentionApply { target, plan } => format!(
                "执行目标 {target} 的清理计划 {plan}。仅删除本次预览列出的版本，删除后无法恢复。"
            ),
            Self::RetentionRecover { target, plan } => {
                format!("继续目标 {target} 已在云端确认的清理计划 {plan}。")
            }
            Self::ReleaseLegacyLock { target, .. } => format!(
                "只有确认目标 {target} 的旧维护请求已经停止，才能释放锁。确认旧请求已停止？"
            ),
            Self::RevokeDevice { device, .. } => {
                format!("撤销设备 {device} 的采集权限。重新使用需要再次配对。")
            }
            Self::LocalRestore { destination, .. }
            | Self::ArchiveRestore { destination, .. }
            | Self::CloudRestore { destination, .. } => format!(
                "校验后在 {} 创建新的笔记本。源笔记本和备份会保留。",
                destination.display()
            ),
            _ => return None,
        })
    }
    /// Retry only operations whose services reconcile durable identity or are read-only.
    pub fn retryable(&self) -> bool {
        matches!(
            self,
            Self::Overview
                | Self::Integrity { .. }
                | Self::LocalBackup { .. }
                | Self::LocalVerify { .. }
                | Self::TestConnection { .. }
                | Self::Discover { .. }
                | Self::CloudBackup { .. }
                | Self::CloudStatus { .. }
                | Self::CloudRestore { .. }
                | Self::WriterPreview { .. }
                | Self::WriterResume { .. }
                | Self::RetentionResume { .. }
                | Self::Maintenance { .. }
                | Self::Devices { .. }
                | Self::ConsumeCaptures { .. }
        )
    }
    pub fn durable(&self) -> bool {
        !matches!(self, Self::SaveConnection { .. } | Self::PairDevice { .. })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ManagementCommand {
    Start {
        operation: Operation,
        confirmed: bool,
    },
    Jobs,
    Retry {
        task: Uuid,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReportAction {
    label: String,
    operation: Operation,
}
impl ReportAction {
    pub fn new(label: impl Into<String>, operation: Operation) -> Self {
        Self {
            label: label.into(),
            operation,
        }
    }
    pub fn label(&self) -> &str {
        &self.label
    }
    pub fn operation(&self) -> &Operation {
        &self.operation
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Report {
    summary: String,
    lines: Vec<(String, String)>,
    actions: Vec<ReportAction>,
    choices: Vec<Choice>,
}
impl Report {
    pub fn new(summary: impl Into<String>) -> Self {
        Self {
            summary: summary.into(),
            ..Default::default()
        }
    }
    pub fn line(mut self, label: impl Into<String>, value: impl ToString) -> Self {
        self.lines.push((label.into(), value.to_string()));
        self
    }
    pub fn action(mut self, label: impl Into<String>, operation: Operation) -> Self {
        self.actions.push(ReportAction::new(label, operation));
        self
    }
    pub fn choice(mut self, choice: Choice) -> Self {
        self.choices.push(choice);
        self
    }
    pub fn choices(&self) -> &[Choice] {
        &self.choices
    }
    pub fn compact(&mut self) {
        self.lines.truncate(3);
        self.actions.retain(|a| {
            matches!(
                a.operation,
                Operation::CleanupRecover { .. }
                    | Operation::CleanupPurge { .. }
                    | Operation::WriterResume { .. }
                    | Operation::RetentionResume { .. }
                    | Operation::AttachRestored { .. }
            )
        });
        self.choices.clear();
    }
    pub fn summary(&self) -> &str {
        &self.summary
    }
    pub fn lines(&self) -> &[(String, String)] {
        &self.lines
    }
    pub fn actions(&self) -> &[ReportAction] {
        &self.actions
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JobDetails {
    task: TaskRecord,
    title: String,
    operation: Option<Operation>,
    report: Report,
    cancel_requested: bool,
}
impl JobDetails {
    pub fn new(task: TaskRecord, operation: &Operation) -> Self {
        Self {
            task,
            title: operation.title().into(),
            operation: operation.durable().then(|| operation.clone()),
            report: Report::new("等待服务执行"),
            cancel_requested: false,
        }
    }
    pub fn task(&self) -> &TaskRecord {
        &self.task
    }
    pub fn title(&self) -> &str {
        &self.title
    }
    pub fn operation(&self) -> Option<&Operation> {
        self.operation.as_ref()
    }
    pub fn report(&self) -> &Report {
        &self.report
    }
    pub fn cancel_requested(&self) -> bool {
        self.cancel_requested
    }
    pub fn request_cancel(&mut self) {
        self.cancel_requested = true;
    }
    pub fn update(&mut self, task: TaskRecord, report: Report) {
        self.task = task;
        self.report = report;
    }
    pub fn progress(&mut self, report: Report) {
        self.report = report;
    }
    pub fn sync_task(&mut self, task: TaskRecord) {
        self.task = task;
    }
    pub fn persisted(&self, compact: bool) -> Self {
        let mut saved = self.clone();
        if self.operation.is_none() {
            saved.report = Report::new("敏感结果仅在本次会话显示；需要时重新操作。");
        }
        if compact {
            saved.report.compact();
        }
        saved
    }
    pub fn can_retry(&self) -> bool {
        matches!(
            self.task.status(),
            TaskStatus::Failed | TaskStatus::Cancelled | TaskStatus::Interrupted
        ) && self.operation.as_ref().is_some_and(Operation::retryable)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum ManagementReply {
    Started(TaskRecord),
    Jobs(Vec<JobDetails>),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum ChoiceKind {
    Notebook,
    Connection,
    LocalTarget,
    CloudTarget,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Choice {
    id: String,
    name: String,
    kind: ChoiceKind,
}
impl Choice {
    pub fn new(id: impl Into<String>, name: impl Into<String>, kind: ChoiceKind) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            kind,
        }
    }
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn kind(&self) -> &ChoiceKind {
        &self.kind
    }
}
