//! Backend management adapter. One admitted job owns configuration; notebook writes
//! still use the application's existing WriteQueue. TaskHistory remains host-owned.
mod cloud;
mod local;
use crate::{cloud::*, config_migration::credentials::SecretStore, scheduler::*};
use anynote_core::{backend::TaskStatus, management::*};
use anynote_storage::{notebook::*, runtime_state::RuntimeState};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Default)]
pub struct ManagementCancellation {
    storage: Cancellation,
    network: CancellationToken,
}
impl ManagementCancellation {
    pub fn cancel(&self) {
        self.storage.cancel();
        self.network.cancel();
    }
}
pub struct Outcome {
    status: TaskStatus,
    report: Report,
}
impl Outcome {
    pub fn new(status: TaskStatus, report: Report) -> Self {
        Self { status, report }
    }
    pub fn status(&self) -> TaskStatus {
        self.status
    }
    pub fn report(&self) -> &Report {
        &self.report
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct LocalTarget {
    name: String,
    target: crate::local_backup::Target,
    notebooks: Vec<String>,
    interval_minutes: u32,
    paused: bool,
}
#[derive(Clone, Serialize, Deserialize)]
struct CloudTarget {
    id: String,
    name: String,
    identity: TransferIdentity,
    interval_minutes: u32,
    paused: bool,
}
#[derive(Default, Serialize, Deserialize)]
struct Settings {
    local: Vec<LocalTarget>,
    cloud: Vec<CloudTarget>,
}
const SETTINGS: &str = "management.settings.v1";
struct Manager<'a> {
    directory: &'a Path,
    queue: &'a WriteQueue,
    state: RuntimeState,
    settings: Settings,
    vault: &'a dyn SecretStore,
    cancel: &'a ManagementCancellation,
    progress: &'a dyn Fn(Report),
}
fn local_error(e: crate::local_backup::Error) -> CloudError {
    CloudError::new(&e.code)
}
impl Manager<'_> {
    fn save(&self) -> CloudResult<()> {
        self.state
            .write(SETTINGS, &serde_json::to_vec(&self.settings)?)?;
        Ok(())
    }
    fn temporary(&self) -> CloudResult<PathBuf> {
        let path = self.directory.join("management.temporary");
        std::fs::create_dir_all(&path)?;
        Ok(path)
    }
    fn books(&self) -> CloudResult<Vec<CatalogEntry>> {
        Ok(self
            .queue
            .submit(|catalog| {
                let mut entries = catalog.catalog_entries()?;
                for entry in &mut entries {
                    if let Ok(book) = catalog.notebook(&entry.id) {
                        entry.metadata = Some(book.read().metadata().clone());
                        entry.name = book.read().metadata().name.clone();
                        entry.unavailable = false;
                        entry.error = None;
                    }
                }
                Ok(entries)
            })?
            .wait()?)
    }
    fn local(&self, id: &str) -> CloudResult<LocalTarget> {
        self.settings
            .local
            .iter()
            .find(|t| t.target.id == id)
            .cloned()
            .ok_or_else(|| CloudError::new("TARGET_NOT_FOUND"))
    }
    fn cloud(&self, id: &str) -> CloudResult<CloudTarget> {
        self.settings
            .cloud
            .iter()
            .find(|t| t.id == id)
            .cloned()
            .ok_or_else(|| CloudError::new("TARGET_NOT_FOUND"))
    }
    fn client(&self, id: &str) -> CloudResult<CloudClient> {
        let connection = recovery_connections(&self.state)?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| CloudError::new("CONNECTION_NOT_FOUND"))?;
        CloudClient::from_vault(connection, self.vault)
    }
    fn configure(&self, id: &str) -> CloudResult<()> {
        let target = if let Ok(t) = self.local(id) {
            ScheduledTarget {
                id: id.into(),
                binding: serde_json::to_string(&t.target)?,
                kind: BackupKind::Local,
                enabled: !t.paused,
                interval_ms: u64::from(t.interval_minutes) * 60_000,
                on_mount: true,
                last_task_bytes: 0,
            }
        } else {
            let t = self.cloud(id)?;
            ScheduledTarget {
                id: id.into(),
                binding: serde_json::to_string(&t.identity)?,
                kind: BackupKind::Remote,
                enabled: !t.paused,
                interval_ms: u64::from(t.interval_minutes) * 60_000,
                on_mount: false,
                last_task_bytes: 0,
            }
        };
        BackupScheduler::load(&self.state)?.configure(&self.state, target)
    }
    fn overview(&self) -> CloudResult<Report> {
        let mut report =
            Report::new("选择笔记本、备份目标或云连接进行管理。恢复会创建新的笔记本。");
        let books = self.books()?;
        for book in &books {
            report = report.line(
                &book.name,
                if book.unavailable {
                    "离线或无权限；重新连接后刷新"
                } else {
                    "可用"
                },
            );
            if !book.unavailable {
                report = report.choice(Choice::new(&book.id, &book.name, ChoiceKind::Notebook));
            }
        }
        let scheduler = BackupScheduler::load(&self.state)?;
        for t in &self.settings.local {
            let status = t.target.status(&crate::local_backup::NativeVolumes);
            report = report
                .choice(Choice::new(&t.target.id, &t.name, ChoiceKind::LocalTarget))
                .line(
                    &t.name,
                    format!(
                        "{} · {} · 自动备份{} · {} 分钟",
                        t.target.path.display(),
                        status.message,
                        if t.paused { "暂停" } else { "启用" },
                        t.interval_minutes
                    ),
                );
            let names = t
                .notebooks
                .iter()
                .map(|id| {
                    books
                        .iter()
                        .find(|b| &b.id == id)
                        .map(|b| b.name.clone())
                        .unwrap_or_else(|| id.clone())
                })
                .collect::<Vec<_>>()
                .join("、");
            report = report.line(
                &t.name,
                format!(
                    "备份范围：{}",
                    if names.is_empty() {
                        "仅用于浏览和恢复"
                    } else {
                        &names
                    }
                ),
            );
            if let Some(s) = scheduler.state(&t.target.id) {
                report = schedule_line(report, &t.name, s);
            }
        }
        for c in recovery_connections(&self.state)? {
            report = report
                .choice(Choice::new(&c.id, &c.name, ChoiceKind::Connection))
                .line(&c.name, &c.endpoint);
        }
        for t in &self.settings.cloud {
            report = report
                .choice(Choice::new(&t.id, &t.name, ChoiceKind::CloudTarget))
                .line(
                    &t.name,
                    format!(
                        "{} · 自动备份{} · {} 分钟",
                        t.identity.endpoint,
                        if t.paused { "暂停" } else { "启用" },
                        t.interval_minutes
                    ),
                );
            let policy = remote_retention_policy(&self.state, &t.id)?;
            report = report.line(
                &t.name,
                format!(
                    "保留策略：至少 {} 个版本；每日 {} 天、每周 {} 周、每月 {} 月",
                    policy.keep,
                    policy.calendar.daily_days,
                    policy.calendar.weekly_weeks,
                    policy.calendar.monthly_months
                ),
            );
            if let Some(s) = scheduler.state(&t.id) {
                report = schedule_line(report, &t.name, s);
            }
        }
        Ok(report)
    }
    async fn execute(&mut self, operation: Operation) -> CloudResult<Outcome> {
        use Operation::*;
        self.cancel.storage.check()?;
        let report = match operation.clone() {
            Overview => self.overview()?,
            AttachRestored { .. }
            | UpdateLocal { .. }
            | ConnectLocal { .. }
            | LocalContents { .. }
            | Integrity { .. }
            | CleanupPreview { .. }
            | CleanupApply { .. }
            | CleanupRecover { .. }
            | CleanupPurge { .. }
            | AddLocal { .. }
            | LocalBackup { .. }
            | LocalVerify { .. }
            | LocalRestore { .. }
            | ArchiveRestore { .. } => return self.execute_local(operation),
            SetPaused { target, paused } => {
                if let Some(t) = self
                    .settings
                    .local
                    .iter_mut()
                    .find(|t| t.target.id == target)
                {
                    t.paused = paused;
                } else if let Some(t) = self.settings.cloud.iter_mut().find(|t| t.id == target) {
                    t.paused = paused;
                } else {
                    return Err(CloudError::new("TARGET_NOT_FOUND"));
                }
                self.save()?;
                self.configure(&target)?;
                Report::new(if paused {
                    "自动备份已暂停"
                } else {
                    "自动备份已启用；等待调度条件满足"
                })
            }
            RunScheduled => return self.run_scheduled().await,
            _ => return self.execute_cloud(operation).await,
        };
        Ok(Outcome::new(TaskStatus::Completed, report))
    }
    async fn run_scheduled(&self) -> CloudResult<Outcome> {
        let mut scheduler = BackupScheduler::load(&self.state)?;
        let books = self.books()?;
        let enabled: Vec<_> = self
            .settings
            .local
            .iter()
            .filter(|t| !t.paused)
            .map(|t| t.target.id.clone())
            .chain(
                self.settings
                    .cloud
                    .iter()
                    .filter(|t| !t.paused)
                    .map(|t| t.id.clone()),
            )
            .collect();
        let mut env = anynote_core::environment::Environment::default();
        // An HTTP response observes reachability, including denied credentials. Power
        // and metered state remain unknown until a platform provider supplies them.
        for t in self.settings.cloud.iter().filter(|t| !t.paused) {
            if let Ok(client) = self.client(&t.identity.connection_id) {
                let response = client.test(&self.cancel.network).await;
                let online = response
                    .as_ref()
                    .map(|_| true)
                    .unwrap_or_else(|e| e.status.is_some());
                env.apply(
                    anynote_core::environment::EnvironmentEvent::NetworkChanged {
                        online: Some(online),
                        metered: None,
                    },
                );
                if online {
                    break;
                }
            }
        }
        let results = std::cell::RefCell::new(Vec::new());
        let executions = &results;
        let count = scheduler
            .tick(
                &self.state,
                &env,
                super::cloud::now_ms(),
                |target| {
                    if let Ok(t) = self.local(&target.id) {
                        Availability {
                            notebook: t
                                .notebooks
                                .iter()
                                .all(|id| books.iter().any(|b| &b.id == id && !b.unavailable)),
                            disk: t.target.status(&crate::local_backup::NativeVolumes).status
                                == "ready",
                        }
                    } else if let Ok(t) = self.cloud(&target.id) {
                        Availability {
                            notebook: books
                                .iter()
                                .any(|b| b.id == t.identity.notebook_id && !b.unavailable),
                            disk: true,
                        }
                    } else {
                        Availability {
                            notebook: false,
                            disk: false,
                        }
                    }
                },
                &self.cancel.network,
                |target, _| async move {
                    (self.progress)(Report::new("正在自动备份").line("目标", &target.id));
                    let result = if target.kind == BackupKind::Local {
                        self.backup_local(&target.id)
                    } else {
                        self.backup_cloud(&target.id)
                            .await
                            .map(|report| Outcome::new(TaskStatus::Completed, report))
                    };
                    match result {
                        Ok(outcome) => {
                            let status = outcome.status;
                            executions.borrow_mut().push((target.id, outcome));
                            if status == TaskStatus::Completed {
                                Ok(0)
                            } else {
                                Err(CloudError::new(if status == TaskStatus::Cancelled {
                                    "CANCELLED"
                                } else {
                                    "LOCAL_IO"
                                }))
                            }
                        }
                        Err(error) => {
                            let status = if error.code == "CANCELLED" {
                                TaskStatus::Cancelled
                            } else {
                                TaskStatus::Failed
                            };
                            executions
                                .borrow_mut()
                                .push((target.id, Outcome::new(status, Report::new(&error.code))));
                            Err(error)
                        }
                    }
                },
            )
            .await?;
        let mut report = Report::new(format!("本次执行 {count} 个自动备份目标"));
        let mut status = TaskStatus::Completed;
        for (id, outcome) in results.into_inner() {
            if outcome.status != TaskStatus::Completed && status != TaskStatus::Failed {
                status = outcome.status;
            }
            report = report.line(&id, outcome.report.summary());
            for (label, value) in outcome.report.lines() {
                report = report.line(label, value);
            }
            for action in outcome.report.actions() {
                report = report.action(action.label(), action.operation().clone());
            }
        }
        for id in enabled {
            if let Some(state) = scheduler.state(&id) {
                report = schedule_line(report, &id, state);
            }
        }
        Ok(Outcome::new(status, report))
    }
}
fn schedule_line(report: Report, name: &str, state: &ScheduleState) -> Report {
    let status = match state.paused {
        Some(PauseReason::Observation) => "等待网络或电源状态；可手动备份",
        Some(PauseReason::Offline) => "等待网络连接",
        Some(PauseReason::Disk) => "等待备份磁盘",
        Some(PauseReason::Notebook) => "等待笔记本可用",
        Some(PauseReason::Auth) => "凭据或权限已失效；更新连接后重试",
        Some(PauseReason::Battery) => "等待接通电源",
        Some(PauseReason::Metered) => "等待非计费网络",
        Some(PauseReason::LargeTask) => "大任务已暂停",
        Some(PauseReason::Cancelled) => "已取消；重新启用以恢复",
        Some(_) => "备份已暂停；检查任务错误后重新启用",
        None if state.running => "正在备份",
        None => "等待下次备份",
    };
    report.line(format!("{name} · 调度"), status)
}

/// Called on a dedicated backend worker, never on the GPUI or pipe dispatch thread.
pub fn execute(
    directory: &Path,
    queue: &WriteQueue,
    operation: Operation,
    confirmed: bool,
    cancel: &ManagementCancellation,
    vault: &dyn SecretStore,
    progress: &dyn Fn(Report),
) -> Outcome {
    let run = || -> CloudResult<Outcome> {
        if operation.confirmation().is_some() && !confirmed {
            return Err(CloudError::new("CONFIRMATION_REQUIRED"));
        }
        let state = RuntimeState::open(&directory.join("management"))?;
        let settings: Settings = state
            .read(SETTINGS)?
            .map(|b| serde_json::from_slice(&b))
            .transpose()?
            .unwrap_or_default();
        if settings.local.len() + settings.cloud.len() > 100 {
            return Err(CloudError::new("TARGET_LIMIT"));
        }
        let mut manager = Manager {
            directory,
            queue,
            state,
            settings,
            vault,
            cancel,
            progress,
        };
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(manager.execute(operation))
    };
    match run() {
        Ok(outcome) => outcome,
        Err(e) => Outcome::new(
            if e.cancelled() {
                TaskStatus::Cancelled
            } else if e.code == "TARGET_OFFLINE" {
                TaskStatus::Interrupted
            } else {
                TaskStatus::Failed
            },
            Report::new(error_message(&e)).line("错误代码", &e.code),
        ),
    }
}
fn error_message(e: &CloudError) -> &'static str {
    match e.code.as_str() {
        "CANCELLED" => "任务已取消。已提交的结果会保留。",
        "TARGET_OFFLINE" => "备份磁盘未连接。连接原磁盘后重试。",
        "CREDENTIAL_UNAVAILABLE" | "TOKEN" => "无法读取凭据。解锁系统凭据库，或添加新的云连接。",
        "NETWORK" | "NETWORK_TIMEOUT" => "网络连接失败。检查连接后重试，未完成的云传输会保留。",
        "CONFIRMATION_REQUIRED" => "此操作需要先查看详情并确认。",
        "WRITER_REBIND_REQUIRED" => "写入身份已改变。请核对接管结果。",
        "TARGET_NOT_FOUND" => "备份目标已变化。刷新管理页后重新选择。",
        _ if matches!(e.status, Some(401 | 403)) => {
            "云连接权限已改变。检查令牌权限并添加有效连接。"
        }
        _ => "操作未完成。检查目标、权限及错误代码；可重试的任务会显示重试按钮。",
    }
}

/// Cheap admission probe used by the backend timer while no management job owns the state.
pub fn has_enabled_targets(directory: &Path) -> bool {
    if !directory.join("management/backend.state.sqlite").is_file() {
        return false;
    }
    let read = || -> CloudResult<bool> {
        let state = RuntimeState::open(&directory.join("management"))?;
        let settings: Settings = state
            .read(SETTINGS)?
            .map(|b| serde_json::from_slice(&b))
            .transpose()?
            .unwrap_or_default();
        Ok(settings.local.iter().any(|t| !t.paused) || settings.cloud.iter().any(|t| !t.paused))
    };
    read().unwrap_or(false)
}
