//! Pipe and runtime ownership for the private backend mode. All state I/O stays off GPUI.
use crate::wire::{Frame, read_frame, write_frame};
use anynote_core::backend::*;
use anynote_services::{diagnostics::Diagnostics, resources::Resources, tasks::TaskHistory};
use anynote_storage::runtime_state::RuntimeState;
use std::{
    collections::HashMap,
    path::Path,
    time::{Duration, Instant},
};
use uuid::Uuid;

enum Input {
    Frame(Frame),
    Closed,
    Invalid(ServiceError),
    Finished(Uuid),
    ReadingFinished(u64, ServiceResult<Reply>),
}
struct Backend {
    epoch: Uuid,
    directory: std::path::PathBuf,
    documents: Option<crate::document_store::DocumentStore>,
    last_request: u64,
    store: RuntimeState,
    tasks: TaskHistory,
    diagnostics: Diagnostics,
    resources: Resources,
    workers: HashMap<Uuid, tokio::task::JoinHandle<()>>,
    reading_workers: HashMap<u64, tokio::task::JoinHandle<()>>,
    waits: HashMap<u64, Uuid>,
    input: async_channel::Sender<Input>,
    output: async_channel::Sender<Frame>,
}
impl Backend {
    async fn send(&self, message: ServerMessage) -> ServiceResult<()> {
        self.output
            .send(Frame::control(&message)?)
            .await
            .map_err(|_| ServiceError::new(ErrorCode::Disconnected))
    }
    async fn respond(&self, id: u64, result: ServiceResult<Reply>) -> ServiceResult<()> {
        self.send(ServerMessage::Response {
            epoch: self.epoch,
            request_id: id,
            result,
        })
        .await
    }
    async fn publish(&mut self, task: TaskRecord) -> ServiceResult<()> {
        self.send(ServerMessage::TaskEvent {
            epoch: self.epoch,
            task: task.clone(),
        })
        .await?;
        if !task.status().is_active() {
            let requests: Vec<_> = self
                .waits
                .iter()
                .filter_map(|(id, task_id)| (*task_id == task.id()).then_some(*id))
                .collect();
            for id in requests {
                self.waits.remove(&id);
                self.respond(id, Ok(Reply::Task(task.clone()))).await?;
            }
        }
        Ok(())
    }
    async fn command(&mut self, request: &Request) -> ServiceResult<Option<Reply>> {
        Ok(Some(match request.command() {
            Command::RunReading(reading) => {
                if self.reading_workers.len() >= MAX_ACTIVE_TASKS {
                    return Err(ServiceError::new(ErrorCode::Busy));
                }
                if self.documents.is_none() {
                    self.documents =
                        Some(crate::document_store::DocumentStore::open(&self.directory)?);
                }
                let job = self
                    .documents
                    .as_ref()
                    .unwrap()
                    .reading_job(reading.clone());
                let id = request.id();
                let input = self.input.clone();
                self.reading_workers.insert(
                    id,
                    tokio::spawn(async move {
                        let result = job.await;
                        let _ = input.send(Input::ReadingFinished(id, result)).await;
                    }),
                );
                return Ok(None);
            }
            Command::CreateDocument
            | Command::Image(_)
            | Command::GetNotebookPreferences { .. }
            | Command::SetNotebookPreferences { .. }
            | Command::OpenLastDocument
            | Command::OpenDocument { .. }
            | Command::SaveDocument(_)
            | Command::SaveBoard(_)
            | Command::DocumentResource { .. } => {
                if self.documents.is_none() {
                    self.documents =
                        Some(crate::document_store::DocumentStore::open(&self.directory)?);
                }
                self.documents
                    .as_mut()
                    .unwrap()
                    .execute(request.command().clone(), &self.store)
                    .await?
            }
            Command::Ping => Reply::Pong,
            Command::StartHealthCheck { delay_ms } => {
                if *delay_ms > 60_000 {
                    return Err(ServiceError::new(ErrorCode::InvalidRequest));
                }
                let task = self.tasks.start(&self.store, RecoveryPolicy::ReadOnly)?;
                let id = task.id();
                let delay = *delay_ms;
                let input = self.input.clone();
                let worker = tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                    let _ = input.send(Input::Finished(id)).await;
                });
                self.workers.insert(id, worker);
                Reply::Task(task)
            }
            Command::CancelTask { task_id } => {
                let task = self
                    .tasks
                    .transition(&self.store, *task_id, TaskStatus::Cancelled)?;
                if let Some(worker) = self.workers.remove(task_id) {
                    worker.abort();
                }
                self.publish(task.clone()).await?;
                Reply::Task(task)
            }
            Command::ListTasks => Reply::Tasks(self.tasks.list()),
            Command::WaitTask { task_id } => {
                let task = self
                    .tasks
                    .list()
                    .into_iter()
                    .find(|t| t.id() == *task_id)
                    .ok_or_else(|| ServiceError::new(ErrorCode::NotFound))?;
                if task.status().is_active() {
                    if self.waits.len() >= QUEUE_CAPACITY {
                        return Err(ServiceError::new(ErrorCode::Busy));
                    }
                    self.waits.insert(request.id(), *task_id);
                    return Ok(None);
                }
                Reply::Task(task)
            }
            Command::CancelWait { request_id } => {
                if self.waits.remove(request_id).is_some() {
                    self.respond(*request_id, Err(ServiceError::new(ErrorCode::Cancelled)))
                        .await?;
                }
                Reply::Ack
            }
            Command::GetDiagnostics => Reply::Diagnostics(self.diagnostics.snapshot()),
            Command::SetDiagnosticLevel { level } => {
                self.diagnostics.set_level(&self.store, *level)?;
                Reply::Ack
            }
            Command::ClearDiagnostics => {
                self.diagnostics.clear(&self.store)?;
                Reply::Ack
            }
            Command::ExportDiagnostics => {
                let (token, length) = self
                    .resources
                    .grant(self.diagnostics.export()?, Instant::now())?;
                Reply::Resource { token, length }
            }
            Command::ReadResource {
                token,
                offset,
                length,
            } => {
                let (bytes, end) = self
                    .resources
                    .read(*token, *offset, *length, Instant::now())?;
                self.output
                    .send(Frame::Binary(
                        StreamHeader::new(self.epoch, request.id(), *token, *offset, end),
                        bytes,
                    ))
                    .await
                    .map_err(|_| ServiceError::new(ErrorCode::Disconnected))?;
                return Ok(None);
            }
            Command::ReleaseResource { token } => {
                self.resources.release(*token)?;
                Reply::Ack
            }
            Command::Shutdown => {
                if self
                    .tasks
                    .list()
                    .iter()
                    .any(|task| task.status() == TaskStatus::Committing)
                {
                    return Err(ServiceError::new(ErrorCode::Busy));
                }
                // Cancel read-only work, persist terminal states and reply to waiters before the exit acknowledgement.
                for task in self
                    .tasks
                    .list()
                    .into_iter()
                    .filter(|t| t.status().is_active())
                {
                    let status = if task.status() == TaskStatus::Committing {
                        TaskStatus::Interrupted
                    } else {
                        TaskStatus::Cancelled
                    };
                    if let Some(worker) = self.workers.remove(&task.id()) {
                        worker.abort();
                    }
                    let terminal = self.tasks.transition(&self.store, task.id(), status)?;
                    self.publish(terminal).await?;
                }
                Reply::Ack
            }
        }))
    }
    async fn run(&mut self, incoming: async_channel::Receiver<Input>) -> ServiceResult<()> {
        self.send(ServerMessage::Ready {
            version: PROTOCOL_VERSION,
            epoch: self.epoch,
        })
        .await?;
        while let Ok(input) = incoming.recv().await {
            match input {
                Input::Closed => break,
                Input::Invalid(error) => {
                    self.send(ServerMessage::ProtocolError { error }).await?;
                    break;
                }
                Input::Finished(id) => {
                    if self.workers.remove(&id).is_some() {
                        let task = self
                            .tasks
                            .transition(&self.store, id, TaskStatus::Completed)?;
                        self.publish(task).await?;
                    }
                }
                Input::ReadingFinished(id, result) => {
                    self.reading_workers.remove(&id);
                    self.respond(id, result).await?;
                }
                Input::Frame(frame) => {
                    let request = match frame.decode::<Request>() {
                        Ok(request) => request,
                        Err(error) => {
                            self.send(ServerMessage::ProtocolError { error }).await?;
                            break;
                        }
                    };
                    if !request.is_current(self.epoch) || request.id() <= self.last_request {
                        self.respond(
                            request.id(),
                            Err(ServiceError::new(ErrorCode::StaleSession)),
                        )
                        .await?;
                        continue;
                    }
                    self.last_request = request.id();
                    let started = Instant::now();
                    let result = self.command(&request).await;
                    // Telemetry failure must never turn a committed operation into a false failure/retry.
                    if !matches!(
                        request.command(),
                        Command::ClearDiagnostics
                            | Command::GetDiagnostics
                            | Command::ExportDiagnostics
                    ) {
                        let event = DiagnosticEvent::new(
                            if result.is_ok() {
                                DiagnosticKind::RequestCompleted
                            } else {
                                DiagnosticKind::RequestRejected
                            },
                            result.as_ref().err().map(ServiceError::code),
                            started.elapsed().as_millis() as u64,
                            0,
                        );
                        if self.diagnostics.record(&self.store, event).is_err() {
                            eprintln!("backend diagnostics: storage failure");
                        }
                    }
                    let shutdown = matches!(request.command(), Command::Shutdown) && result.is_ok();
                    match result {
                        Ok(Some(reply)) => self.respond(request.id(), Ok(reply)).await?,
                        Ok(None) => (),
                        Err(error) => self.respond(request.id(), Err(error)).await?,
                    }
                    if shutdown {
                        return Ok(());
                    }
                }
            }
        }
        // EOF is not successful completion. Recovery preserves the original recovery policy.
        for task in self
            .tasks
            .list()
            .into_iter()
            .filter(|t| t.status().is_active())
        {
            self.tasks
                .transition(&self.store, task.id(), TaskStatus::Interrupted)?;
        }
        Ok(())
    }
}

pub fn run(directory: &Path) -> ServiceResult<()> {
    let store = RuntimeState::open(directory)?;
    let tasks = TaskHistory::load(&store)?;
    let mut diagnostics = Diagnostics::load(&store)?;
    diagnostics.record(
        &store,
        DiagnosticEvent::new(DiagnosticKind::BackendStarted, None, 0, 0),
    )?;
    let (input, incoming) = async_channel::bounded(QUEUE_CAPACITY);
    let (output, outgoing) = async_channel::bounded(QUEUE_CAPACITY);
    let reader_input = input.clone();
    std::thread::spawn(move || {
        let mut reader = std::io::stdin().lock();
        loop {
            let next = match read_frame(&mut reader) {
                Ok(Some(frame)) => Input::Frame(frame),
                Ok(None) => Input::Closed,
                Err(error) => Input::Invalid(error),
            };
            let closed = matches!(next, Input::Closed | Input::Invalid(_));
            if reader_input.send_blocking(next).is_err() || closed {
                break;
            }
        }
    });
    let writer_input = input.clone();
    let writer = std::thread::spawn(move || {
        let mut writer = std::io::stdout().lock();
        while let Ok(frame) = outgoing.recv_blocking() {
            if let Err(error) = write_frame(&mut writer, &frame) {
                let _ = writer_input.try_send(Input::Closed);
                return Err(error);
            }
        }
        Ok(())
    });
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| ServiceError::new(ErrorCode::Storage))?;
    let mut backend = Backend {
        epoch: Uuid::new_v4(),
        directory: directory.to_owned(),
        documents: None,
        last_request: 0,
        store,
        tasks,
        diagnostics,
        resources: Resources::default(),
        workers: HashMap::new(),
        reading_workers: HashMap::new(),
        waits: HashMap::new(),
        input,
        output,
    };
    let result = runtime.block_on(backend.run(incoming));
    for (_, worker) in backend.workers.drain() {
        worker.abort();
    }
    for (_, worker) in backend.reading_workers.drain() {
        worker.abort();
    }
    backend.input.close();
    backend.output.close();
    let written = writer
        .join()
        .map_err(|_| ServiceError::new(ErrorCode::Disconnected))?;
    result.and(written)
}
