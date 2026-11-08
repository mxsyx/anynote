//! Manual jobs reuse RM03 history; the host owns worker execution and cancellation.
use super::*;
use crate::tasks::TaskHistory;
use anynote_core::backend::{RecoveryPolicy, TaskRecord, TaskStatus};
use anynote_storage::runtime_state::RuntimeState;
use serde_json::{Value, json};

pub enum LocalJob {
    Backup {
        notebook_ids: Vec<String>,
    },
    Verify {
        notebook_id: String,
    },
    Restore {
        notebook_ids: Vec<String>,
        destination: PathBuf,
    },
}
pub struct JobContext<'a> {
    pub target: &'a Target,
    pub queue: &'a WriteQueue,
    pub temporary: &'a Path,
    pub cancel: &'a Cancellation,
    pub volumes: &'a dyn VolumeProbe,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobReceipt {
    pub task_id: uuid::Uuid,
    pub status: String,
    pub result: Option<Value>,
    pub error: Option<String>,
}
fn task_error(e: anynote_core::backend::ServiceError) -> Error {
    Error::new("TASK_STATE", e.to_string())
}
pub fn prepare_job(history: &mut TaskHistory, state: &RuntimeState) -> Result<TaskRecord> {
    history
        .start(
            state,
            RecoveryPolicy::Receipt {
                operation_id: uuid::Uuid::new_v4(),
            },
        )
        .map_err(task_error)
}
fn receipt_key(record: &TaskRecord) -> Result<String> {
    let RecoveryPolicy::Receipt { operation_id } = record.recovery() else {
        return Err(Error::new("TASK_STATE", "任务缺少回执身份"));
    };
    Ok(format!("backup.local.receipt.{operation_id}"))
}
pub fn job_receipt(state: &RuntimeState, record: &TaskRecord) -> Result<Option<JobReceipt>> {
    state
        .read(&receipt_key(record)?)
        .map_err(task_error)?
        .map(|b| serde_json::from_slice(&b).map_err(Error::from))
        .transpose()
}
impl LocalBackupService {
    /// The returned handle from prepare_job can be exposed before dispatching this worker call.
    pub fn execute_job(
        &mut self,
        history: &mut TaskHistory,
        state: &RuntimeState,
        record: &TaskRecord,
        job: LocalJob,
        context: JobContext<'_>,
    ) -> Result<JobReceipt> {
        require(
            history.list().iter().any(|r| {
                r.id() == record.id()
                    && r.status() == TaskStatus::Running
                    && r.recovery() == record.recovery()
            }),
            "TASK_STATE",
            "任务不处于运行状态",
        )?;
        let key = receipt_key(record)?;
        require(
            state.read(&key).map_err(task_error)?.is_none(),
            "TASK_STATE",
            "已有回执，禁止重复执行",
        )?;
        let result: Result<(String, Value)> = (|| match job {
            LocalJob::Backup { notebook_ids } => {
                let results = self.backup_group(
                    context.target,
                    context.queue,
                    &notebook_ids,
                    context.temporary,
                    context.cancel,
                    context.volumes,
                )?;
                let status = group_status(results.iter().map(|r| r.status.as_str()));
                Ok((status, serde_json::to_value(results)?))
            }
            LocalJob::Verify { notebook_id } => {
                let report = self.verify(
                    context.target,
                    &notebook_id,
                    context.temporary,
                    context.cancel,
                    context.volumes,
                )?;
                let status = match report.status.as_str() {
                    "passed" => "completed",
                    "interrupted" => "cancelled",
                    _ => "failed",
                };
                Ok((status.into(), serde_json::to_value(report)?))
            }
            LocalJob::Restore {
                notebook_ids,
                destination,
            } => {
                require(
                    !notebook_ids.is_empty()
                        && notebook_ids.len() <= 1000
                        && notebook_ids.iter().collect::<BTreeSet<_>>().len() == notebook_ids.len(),
                    "INVALID_INPUT",
                    "无效恢复分组",
                )?;
                let mut results = Vec::new();
                let mut statuses = Vec::new();
                for id in notebook_ids {
                    match self.restore(
                        context.target,
                        &id,
                        &destination,
                        context.cancel,
                        context.volumes,
                    ) {
                        Ok(meta) => {
                            statuses.push("completed");
                            results.push(json!({"notebookId": id, "status":"completed", "restoredId": meta.id}));
                        }
                        Err(e) => {
                            let status = error_status(&e);
                            statuses.push(status);
                            results.push(json!({"notebookId":id,"status":status,"errorCode":e.code,"error":e.message}));
                        }
                    }
                }
                Ok((group_status(statuses.into_iter()), json!(results)))
            }
        })();
        let receipt = match result {
            Ok((status, result)) => JobReceipt {
                task_id: record.id(),
                status,
                result: Some(result),
                error: None,
            },
            Err(e) => JobReceipt {
                task_id: record.id(),
                status: error_status(&e).into(),
                result: None,
                error: Some(e.to_string()),
            },
        };
        // A published backup remains valid even if the local task store fails. Leave it interrupted for reconciliation.
        if let Err(e) = state.write(&key, &serde_json::to_vec(&receipt)?) {
            let _ = history.transition(state, record.id(), TaskStatus::Interrupted);
            return Err(task_error(e));
        }
        let status = match receipt.status.as_str() {
            "completed" => TaskStatus::Completed,
            "cancelled" => TaskStatus::Cancelled,
            "waiting-disk" => TaskStatus::Interrupted,
            _ => TaskStatus::Failed,
        };
        history
            .transition(state, record.id(), status)
            .map_err(task_error)?;
        Ok(receipt)
    }
}
fn error_status(error: &Error) -> &'static str {
    match error.code.as_str() {
        "TARGET_OFFLINE" => "waiting-disk",
        "CANCELLED" => "cancelled",
        _ => "failed",
    }
}
fn group_status<'a>(statuses: impl Iterator<Item = &'a str>) -> String {
    let statuses: Vec<_> = statuses.collect();
    if statuses.iter().all(|s| *s == "completed") {
        "completed"
    } else if statuses.contains(&"failed") {
        "failed"
    } else if statuses.contains(&"waiting-disk") {
        "waiting-disk"
    } else {
        "cancelled"
    }
    .into()
}
