//! Nonblocking UI boundary. Pipe I/O, deadlines, process startup and reaping belong to workers.
use crate::wire::{Frame, read_frame, write_frame};
use anynote_core::backend::*;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::{Command as ProcessCommand, Stdio},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use uuid::Uuid;

#[derive(Debug)]
pub enum Response {
    Reply(Reply),
    Chunk(StreamHeader, Vec<u8>),
}
struct Pending {
    command: Command,
    deadline: Instant,
    reply: async_channel::Sender<ServiceResult<Response>>,
}
struct Requests {
    next_id: u64,
    pending: HashMap<u64, Pending>,
    tasks: HashMap<Uuid, TaskRecord>,
}
struct Shared {
    epoch: Uuid,
    requests: Mutex<Requests>,
    outgoing: async_channel::Sender<Frame>,
    disconnected: AtomicBool,
    exited: AtomicBool,
}
struct Owner {
    shared: Arc<Shared>,
    stop: async_channel::Sender<()>,
    executable: PathBuf,
    directory: PathBuf,
    pid: u32,
}
impl Drop for Owner {
    fn drop(&mut self) {
        let _ = self.stop.try_send(());
    }
}
#[derive(Clone)]
pub struct BackendClient {
    owner: Arc<Owner>,
}
pub struct RequestHandle {
    id: u64,
    shared: Weak<Shared>,
    reply: async_channel::Receiver<ServiceResult<Response>>,
}
impl RequestHandle {
    pub fn id(&self) -> u64 {
        self.id
    }
    pub async fn receive(self) -> ServiceResult<Response> {
        self.reply
            .recv()
            .await
            .map_err(|_| ServiceError::new(ErrorCode::Disconnected))?
    }
    pub fn receive_blocking(self) -> ServiceResult<Response> {
        self.reply
            .recv_blocking()
            .map_err(|_| ServiceError::new(ErrorCode::Disconnected))?
    }
}
impl Drop for RequestHandle {
    fn drop(&mut self) {
        if let Some(shared) = self.shared.upgrade() {
            let mut requests = shared.requests.lock().unwrap();
            if requests.pending.remove(&self.id).is_some() {
                cancel_wait(&shared, &mut requests, self.id);
            }
        }
    }
}
fn cancel_wait(shared: &Shared, requests: &mut Requests, id: u64) {
    let request_id = requests.next_id;
    requests.next_id += 1;
    if let Ok(frame) = Frame::control(&Request::new(
        shared.epoch,
        request_id,
        Command::CancelWait { request_id: id },
    )) {
        let _ = shared.outgoing.try_send(frame);
    }
}
fn disconnect(shared: &Shared) {
    shared.disconnected.store(true, Ordering::Release);
    shared.outgoing.close();
    for (_, request) in shared.requests.lock().unwrap().pending.drain() {
        let _ = request
            .reply
            .try_send(Err(ServiceError::new(ErrorCode::Disconnected)));
    }
}
fn matches_reply(command: &Command, reply: &Reply) -> bool {
    matches!(
        (command, reply),
        (
            Command::CreateDocument
                | Command::OpenLastDocument
                | Command::OpenDocument { .. }
                | Command::SaveBoard(_),
            Reply::Document(_)
        ) | (Command::SaveDocument(_), Reply::DocumentSaved(_))
            | (Command::Image(_), Reply::Image(_))
            | (Command::RunReading(_), Reply::Reading(_))
            | (
                Command::GetNotebookPreferences { .. } | Command::SetNotebookPreferences { .. },
                Reply::NotebookPreferences { .. }
            )
            | (
                Command::DocumentResource { .. },
                Reply::DocumentResource { .. }
            )
            | (Command::Ping, Reply::Pong)
            | (
                Command::StartHealthCheck { .. }
                    | Command::CancelTask { .. }
                    | Command::WaitTask { .. },
                Reply::Task(_)
            )
            | (Command::ListTasks, Reply::Tasks(_))
            | (Command::GetDiagnostics, Reply::Diagnostics(_))
            | (Command::ExportDiagnostics, Reply::Resource { .. })
            | (
                Command::SetDiagnosticLevel { .. }
                    | Command::ClearDiagnostics
                    | Command::ReleaseResource { .. }
                    | Command::CancelWait { .. }
                    | Command::Shutdown,
                Reply::Ack
            )
    )
}
fn accept(shared: &Shared, frame: Frame) -> ServiceResult<()> {
    let mut requests = shared.requests.lock().unwrap();
    match frame {
        Frame::Control(bytes) => match serde_json::from_slice::<ServerMessage>(&bytes)
            .map_err(|_| ServiceError::new(ErrorCode::InvalidRequest))?
        {
            ServerMessage::Response {
                epoch,
                request_id,
                result,
            } => {
                if epoch != shared.epoch {
                    return Ok(());
                }
                if let Some(pending) = requests.pending.remove(&request_id) {
                    let response = if pending.deadline <= Instant::now() {
                        Err(ServiceError::new(ErrorCode::Timeout))
                    } else {
                        result.and_then(|reply| {
                            if matches_reply(&pending.command, &reply) {
                                Ok(Response::Reply(reply))
                            } else {
                                Err(ServiceError::new(ErrorCode::InvalidRequest))
                            }
                        })
                    };
                    let _ = pending.reply.try_send(response);
                }
            }
            ServerMessage::TaskEvent { epoch, task } => {
                if epoch != shared.epoch {
                    return Ok(());
                }
                if requests
                    .tasks
                    .get(&task.id())
                    .is_some_and(|old| old.sequence() >= task.sequence())
                {
                    return Ok(());
                }
                if requests.tasks.len() >= 200 && !requests.tasks.contains_key(&task.id()) {
                    if let Some(id) = requests
                        .tasks
                        .iter()
                        .find_map(|(id, t)| (!t.status().is_active()).then_some(*id))
                    {
                        requests.tasks.remove(&id);
                    } else {
                        return Ok(());
                    }
                }
                requests.tasks.insert(task.id(), task);
            }
            _ => return Err(ServiceError::new(ErrorCode::InvalidRequest)),
        },
        Frame::Binary(header, bytes) => {
            if header.epoch() != shared.epoch {
                return Ok(());
            }
            if let Some(pending) = requests.pending.remove(&header.request_id()) {
                let valid = matches!(pending.command, Command::ReadResource { token, offset, length } if token == header.token() && offset == header.offset() && bytes.len() <= length as usize && (header.is_end() || bytes.len() == length as usize));
                let result = if pending.deadline <= Instant::now() {
                    Err(ServiceError::new(ErrorCode::Timeout))
                } else if valid {
                    Ok(Response::Chunk(header, bytes))
                } else {
                    Err(ServiceError::new(ErrorCode::InvalidRequest))
                };
                let _ = pending.reply.try_send(result);
            }
        }
    }
    Ok(())
}
impl BackendClient {
    pub fn launch(
        executable: PathBuf,
        directory: PathBuf,
    ) -> async_channel::Receiver<ServiceResult<Self>> {
        let (sender, receiver) = async_channel::bounded(1);
        std::thread::spawn(move || {
            let _ = sender.send_blocking(Self::connect(&executable, &directory));
        });
        receiver
    }
    fn connect(executable: &Path, directory: &Path) -> ServiceResult<Self> {
        let mut child = ProcessCommand::new(executable)
            .arg("--backend")
            .env("ANYNOTE_RUST_STATE_DIR", directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| ServiceError::new(ErrorCode::Disconnected))?;
        let pid = child.id();
        let mut reader = child
            .stdout
            .take()
            .ok_or_else(|| ServiceError::new(ErrorCode::Disconnected))?;
        let mut writer = child
            .stdin
            .take()
            .ok_or_else(|| ServiceError::new(ErrorCode::Disconnected))?;
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        let (shared_tx, shared_rx) = std::sync::mpsc::sync_channel::<Arc<Shared>>(1);
        let reader_thread = std::thread::spawn(move || {
            let ready = read_frame(&mut reader).and_then(|frame| {
                frame
                    .ok_or_else(|| ServiceError::new(ErrorCode::Disconnected))?
                    .decode::<ServerMessage>()
            });
            let _ = ready_tx.send(ready);
            if let Ok(shared) = shared_rx.recv() {
                while let Ok(Some(frame)) = read_frame(&mut reader) {
                    if accept(&shared, frame).is_err() {
                        break;
                    }
                }
                disconnect(&shared);
            }
        });
        let epoch = match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(ServerMessage::Ready {
                version: PROTOCOL_VERSION,
                epoch,
            })) => epoch,
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                drop(shared_tx);
                let _ = reader_thread.join();
                return Err(ServiceError::new(ErrorCode::Disconnected));
            }
        };
        let (outgoing, outgoing_rx) = async_channel::bounded(QUEUE_CAPACITY);
        let (stop, stopped) = async_channel::bounded(1);
        let shared = Arc::new(Shared {
            epoch,
            requests: Mutex::new(Requests {
                next_id: 1,
                pending: HashMap::new(),
                tasks: HashMap::new(),
            }),
            outgoing,
            disconnected: AtomicBool::new(false),
            exited: AtomicBool::new(false),
        });
        let writer_shared = shared.clone();
        let writer_thread = std::thread::spawn(move || {
            while let Ok(frame) = outgoing_rx.recv_blocking() {
                if write_frame(&mut writer, &frame).is_err() {
                    break;
                }
            }
            writer_shared.disconnected.store(true, Ordering::Release);
            writer_shared.outgoing.close();
        });
        let _ = shared_tx.send(shared.clone());
        let supervisor = shared.clone();
        std::thread::spawn(move || {
            loop {
                if stopped.try_recv().is_ok() || supervisor.disconnected.load(Ordering::Acquire) {
                    let _ = child.kill();
                    break;
                }
                match child.try_wait() {
                    Ok(Some(_)) | Err(_) => break,
                    Ok(None) => (),
                }
                let mut requests = supervisor.requests.lock().unwrap();
                let expired: Vec<_> = requests
                    .pending
                    .iter()
                    .filter_map(|(id, pending)| (pending.deadline <= Instant::now()).then_some(*id))
                    .collect();
                for id in expired {
                    if let Some(pending) = requests.pending.remove(&id) {
                        let _ = pending
                            .reply
                            .try_send(Err(ServiceError::new(ErrorCode::Timeout)));
                        cancel_wait(&supervisor, &mut requests, id);
                    }
                }
                drop(requests);
                std::thread::sleep(Duration::from_millis(5));
            }
            let _ = child.wait();
            // Drain stdout before failing pending requests: exit can race with a final commit response.
            let _ = reader_thread.join();
            disconnect(&supervisor);
            let _ = writer_thread.join();
            supervisor.exited.store(true, Ordering::Release);
        });
        Ok(Self {
            owner: Arc::new(Owner {
                shared,
                stop,
                executable: executable.to_path_buf(),
                directory: directory.to_path_buf(),
                pid,
            }),
        })
    }
    pub fn epoch(&self) -> Uuid {
        self.owner.shared.epoch
    }
    pub fn process_id(&self) -> u32 {
        self.owner.pid
    }
    pub fn is_connected(&self) -> bool {
        !self.owner.shared.disconnected.load(Ordering::Acquire)
    }
    pub fn has_exited(&self) -> bool {
        self.owner.shared.exited.load(Ordering::Acquire)
    }
    pub fn task_events(&self) -> Vec<TaskRecord> {
        self.owner
            .shared
            .requests
            .lock()
            .unwrap()
            .tasks
            .values()
            .cloned()
            .collect()
    }
    pub fn submit(&self, command: Command, timeout: Duration) -> ServiceResult<RequestHandle> {
        let shared = &self.owner.shared;
        let mut requests = shared.requests.lock().unwrap();
        if shared.disconnected.load(Ordering::Acquire) {
            return Err(ServiceError::new(ErrorCode::Disconnected));
        }
        let limit = if matches!(
            command,
            Command::CancelTask { .. } | Command::CancelWait { .. } | Command::Shutdown
        ) {
            QUEUE_CAPACITY
        } else {
            MAX_PENDING_REQUESTS
        };
        if requests.pending.len() >= limit {
            return Err(ServiceError::new(ErrorCode::Busy));
        }
        let id = requests.next_id;
        requests.next_id += 1;
        let frame = Frame::control(&Request::new(shared.epoch, id, command.clone()))?;
        let (reply, receiver) = async_channel::bounded(1);
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| ServiceError::new(ErrorCode::InvalidRequest))?;
        shared
            .outgoing
            .try_send(frame)
            .map_err(|_| ServiceError::new(ErrorCode::Busy))?;
        requests.pending.insert(
            id,
            Pending {
                command,
                deadline,
                reply,
            },
        );
        Ok(RequestHandle {
            id,
            shared: Arc::downgrade(shared),
            reply: receiver,
        })
    }
    pub fn terminate(&self) {
        let _ = self.owner.stop.try_send(());
    }
    pub fn reconnect(&self) -> async_channel::Receiver<ServiceResult<Self>> {
        self.terminate();
        let owner = self.owner.clone();
        let (sender, receiver) = async_channel::bounded(1);
        std::thread::spawn(move || {
            while !owner.shared.exited.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(5));
            }
            let _ = sender.send_blocking(Self::connect(&owner.executable, &owner.directory));
        });
        receiver
    }
    pub async fn shutdown(&self) -> ServiceResult<()> {
        let result = self
            .submit(Command::Shutdown, Duration::from_secs(3))?
            .receive()
            .await;
        if result
            .as_ref()
            .is_err_and(|error| error.code() != ErrorCode::Busy)
        {
            self.terminate();
        }
        result.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expired_epoch_and_task_sequence_never_replace_current_state() {
        let (outgoing, _) = async_channel::bounded(1);
        let shared = Shared {
            epoch: Uuid::new_v4(),
            requests: Mutex::new(Requests {
                next_id: 2,
                pending: HashMap::new(),
                tasks: HashMap::new(),
            }),
            outgoing,
            disconnected: AtomicBool::new(false),
            exited: AtomicBool::new(false),
        };
        let (reply, receiver) = async_channel::bounded(1);
        shared.requests.lock().unwrap().pending.insert(
            1,
            Pending {
                command: Command::Ping,
                deadline: Instant::now() + Duration::from_secs(1),
                reply,
            },
        );
        accept(
            &shared,
            Frame::control(&ServerMessage::Response {
                epoch: Uuid::new_v4(),
                request_id: 1,
                result: Ok(Reply::Pong),
            })
            .unwrap(),
        )
        .unwrap();
        assert!(receiver.try_recv().is_err());
        let mut task = TaskRecord::new(Uuid::new_v4(), RecoveryPolicy::ReadOnly);
        let old = task.clone();
        task.transition(TaskStatus::Completed).unwrap();
        for task in [task, old.clone()] {
            accept(
                &shared,
                Frame::control(&ServerMessage::TaskEvent {
                    epoch: shared.epoch,
                    task,
                })
                .unwrap(),
            )
            .unwrap();
        }
        assert_eq!(
            shared.requests.lock().unwrap().tasks[&old.id()].status(),
            TaskStatus::Completed
        );
        accept(
            &shared,
            Frame::control(&ServerMessage::Response {
                epoch: shared.epoch,
                request_id: 1,
                result: Ok(Reply::Pong),
            })
            .unwrap(),
        )
        .unwrap();
        assert!(matches!(
            receiver.try_recv().unwrap().unwrap(),
            Response::Reply(Reply::Pong)
        ));
    }
}
