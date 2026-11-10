use super::*;
use anynote_core::management::*;
use anynote_services::management::{ManagementCancellation, Outcome};
const KEY: &str = "management.jobs.v1";
pub(super) struct ActiveJob {
    cancellation: ManagementCancellation,
    worker: tokio::task::JoinHandle<()>,
}
impl ActiveJob {
    pub(super) fn cancel(&self) {
        self.cancellation.cancel();
    }
}
pub(super) fn load(store: &RuntimeState, tasks: &TaskHistory) -> ServiceResult<Vec<JobDetails>> {
    let mut jobs: Vec<JobDetails> = store
        .read(KEY)?
        .map(|b| serde_json::from_slice(&b).map_err(|_| ServiceError::new(ErrorCode::Storage)))
        .transpose()?
        .unwrap_or_default();
    let history = tasks.list();
    jobs.retain(|job| history.iter().any(|t| t.id() == job.task().id()));
    for job in &mut jobs {
        if let Some(task) = history.iter().find(|t| t.id() == job.task().id()) {
            job.sync_task(task.clone());
        }
        if job.task().status() == TaskStatus::Interrupted {
            let mut report = job.report().clone().line(
                "重启核对",
                "任务曾被中断。先核对备份或恢复目的地，不能推定失败或自动重复恢复。",
            );
            if let Some(Operation::CleanupApply { notebook, plan }) = job.operation() {
                report = report.action(
                    "恢复隔离快照",
                    Operation::CleanupRecover {
                        notebook: notebook.clone(),
                        plan: plan.clone(),
                    },
                );
            }
            job.progress(report);
        }
    }
    Ok(jobs)
}
impl Backend {
    fn persist_management(&mut self) -> ServiceResult<()> {
        let history = self.tasks.list();
        self.management_jobs
            .retain(|j| history.iter().any(|t| t.id() == j.task().id()));
        let count = self.management_jobs.len();
        let mut saved = self
            .management_jobs
            .iter()
            .enumerate()
            .map(|(ix, job)| job.persisted(ix + 5 < count))
            .collect::<Vec<_>>();
        let encode = |jobs: &[JobDetails]| {
            serde_json::to_vec(jobs).map_err(|_| ServiceError::new(ErrorCode::Storage))
        };
        let mut bytes = encode(&saved)?;
        if bytes.len() > anynote_storage::runtime_state::MAX_STATE_BYTES / 2 {
            saved = saved.iter().map(|job| job.persisted(true)).collect();
            bytes = encode(&saved)?;
            while bytes.len() > anynote_storage::runtime_state::MAX_STATE_BYTES / 2
                && saved.len() > 1
            {
                let Some(ix) = saved
                    .iter()
                    .position(|job| !job.task().status().is_active())
                else {
                    break;
                };
                saved.remove(ix);
                bytes = encode(&saved)?;
            }
        }
        self.store.write(KEY, &bytes)
    }
    pub(super) fn management_command(
        &mut self,
        command: ManagementCommand,
    ) -> ServiceResult<Reply> {
        let (operation, confirmed) = match command {
            ManagementCommand::Jobs => {
                return Ok(Reply::Management(ManagementReply::Jobs(
                    self.management_jobs.clone(),
                )));
            }
            ManagementCommand::Start {
                operation,
                confirmed,
            } => (operation, confirmed),
            ManagementCommand::Retry { task } => {
                let job = self
                    .management_jobs
                    .iter()
                    .find(|j| j.task().id() == task)
                    .ok_or_else(|| ServiceError::new(ErrorCode::NotFound))?;
                if !job.can_retry() {
                    return Err(ServiceError::new(ErrorCode::Conflict));
                }
                (job.operation().unwrap().clone(), true)
            }
        };
        if operation.confirmation().is_some() && !confirmed {
            return Err(ServiceError::new(ErrorCode::InvalidRequest));
        }
        if !self.management_active.is_empty() {
            return Err(ServiceError::new(ErrorCode::Busy));
        }
        if self.documents.is_none() {
            self.documents = Some(crate::document_store::DocumentStore::open(&self.directory)?);
        }
        let task = self.tasks.start(
            &self.store,
            RecoveryPolicy::Receipt {
                operation_id: Uuid::new_v4(),
            },
        )?;
        let id = task.id();
        self.management_jobs
            .push(JobDetails::new(task.clone(), &operation));
        if let Err(e) = self.persist_management() {
            self.tasks.transition(&self.store, id, TaskStatus::Failed)?;
            return Err(e);
        }
        let directory = self.directory.clone();
        let queue = self.documents.as_ref().unwrap().queue.clone();
        let cancellation = ManagementCancellation::default();
        let cancel = cancellation.clone();
        let input = self.input.clone();
        let progress = self.input.clone();
        let worker = tokio::spawn(async move {
            let outcome = tokio::task::spawn_blocking(move || {
                anynote_services::management::execute(
                    &directory,
                    &queue,
                    operation,
                    confirmed,
                    &cancel,
                    &anynote_services::config_migration::credentials::OsSecretStore,
                    &|report| {
                        // A slow UI must not stall copying. Terminal results use the reliable channel.
                        let _ = progress.try_send(Input::ManagementProgress(id, report));
                    },
                )
            })
            .await
            .unwrap_or_else(|_| {
                Outcome::new(
                    TaskStatus::Interrupted,
                    Report::new("服务工作线程中断，请核对目标后再决定是否重试。"),
                )
            });
            let _ = input.send(Input::ManagementFinished(id, outcome)).await;
        });
        self.management_active.insert(
            id,
            ActiveJob {
                cancellation,
                worker,
            },
        );
        Ok(Reply::Management(ManagementReply::Started(task)))
    }
    pub(super) async fn finish_management(
        &mut self,
        id: Uuid,
        outcome: Outcome,
    ) -> ServiceResult<()> {
        if self.management_active.remove(&id).is_none() {
            return Ok(());
        }
        // Persist the result before the terminal task state, so restart never erases a receipt.
        if let Some(job) = self
            .management_jobs
            .iter_mut()
            .find(|j| j.task().id() == id)
        {
            job.progress(outcome.report().clone());
        }
        self.persist_management()?;
        let task = self.tasks.transition(&self.store, id, outcome.status())?;
        if let Some(job) = self
            .management_jobs
            .iter_mut()
            .find(|j| j.task().id() == id)
        {
            job.sync_task(task.clone());
        }
        self.persist_management()?;
        self.publish(task).await
    }
    pub(super) fn cancel_management(&mut self, id: Uuid) -> ServiceResult<Option<TaskRecord>> {
        let Some(active) = self.management_active.get(&id) else {
            return Ok(None);
        };
        active.cancel();
        let job = self
            .management_jobs
            .iter_mut()
            .find(|j| j.task().id() == id)
            .ok_or_else(|| ServiceError::new(ErrorCode::NotFound))?;
        job.request_cancel();
        let task = job.task().clone();
        self.persist_management()?;
        Ok(Some(task))
    }
    pub(super) async fn drain_management(&mut self) {
        for (_, job) in self.management_active.drain() {
            job.cancel();
            // The queue may already be committing. Do not detach a blocking writer on exit.
            let _ = job.worker.await;
        }
    }
}
