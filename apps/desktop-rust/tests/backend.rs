use anynote_core::backend::*;
use anynote_desktop::{
    backend_client::{BackendClient, Response},
    wire::{Frame, read_frame, write_frame},
};
use std::{
    io::Write,
    path::PathBuf,
    process::{Child, ChildStdin, Command as ProcessCommand, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};
use uuid::Uuid;
const TIMEOUT: Duration = Duration::from_secs(5);
struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tmp/rm03")
            .join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(&path).unwrap();
        Self(path.canonicalize().unwrap())
    }
    fn client(&self) -> BackendClient {
        BackendClient::launch(
            PathBuf::from(env!("CARGO_BIN_EXE_anynote-desktop")),
            self.0.clone(),
        )
        .recv_blocking()
        .unwrap()
        .unwrap()
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn reply(client: &BackendClient, command: Command) -> Reply {
    match client
        .submit(command, TIMEOUT)
        .unwrap()
        .receive_blocking()
        .unwrap()
    {
        Response::Reply(reply) => reply,
        _ => panic!("expected control reply"),
    }
}
fn start(client: &BackendClient, delay_ms: u64) -> TaskRecord {
    match reply(client, Command::StartHealthCheck { delay_ms }) {
        Reply::Task(task) => task,
        _ => panic!("expected task"),
    }
}
fn exited(client: &BackendClient) {
    let deadline = Instant::now() + TIMEOUT;
    while !client.has_exited() {
        assert!(Instant::now() < deadline, "backend did not exit");
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn close(client: &BackendClient) {
    assert!(matches!(reply(client, Command::Shutdown), Reply::Ack));
    exited(client);
}
struct Raw {
    child: Child,
    input: Option<ChildStdin>,
    frames: mpsc::Receiver<Frame>,
    epoch: Uuid,
}
impl Raw {
    fn new(directory: &Directory) -> Self {
        let mut child = ProcessCommand::new(env!("CARGO_BIN_EXE_anynote-desktop"))
            .arg("--backend")
            .env("ANYNOTE_RUST_STATE_DIR", &directory.0)
            .env_remove("DISPLAY")
            .env_remove("WAYLAND_DISPLAY")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let input = child.stdin.take();
        let mut output = child.stdout.take().unwrap();
        let (tx, frames) = mpsc::sync_channel(QUEUE_CAPACITY);
        std::thread::spawn(move || {
            while let Ok(Some(frame)) = read_frame(&mut output) {
                if tx.send(frame).is_err() {
                    break;
                }
            }
        });
        let ready = frames
            .recv_timeout(TIMEOUT)
            .unwrap()
            .decode::<ServerMessage>()
            .unwrap();
        let ServerMessage::Ready {
            epoch,
            version: PROTOCOL_VERSION,
        } = ready
        else {
            panic!("missing handshake")
        };
        Self {
            child,
            input,
            frames,
            epoch,
        }
    }
    fn send(&mut self, id: u64, command: Command) {
        write_frame(
            self.input.as_mut().unwrap(),
            &Frame::control(&Request::new(self.epoch, id, command)).unwrap(),
        )
        .unwrap();
    }
    fn message(&self) -> ServerMessage {
        self.frames.recv_timeout(TIMEOUT).unwrap().decode().unwrap()
    }
    fn wait(&mut self) {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            if self.child.try_wait().unwrap().is_some() {
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
impl Drop for Raw {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn concurrent_requests_cancel_timeout_and_exit_drain() {
    let directory = Directory::new();
    let client = directory.client();
    let task = start(&client, 60_000);
    let wait = client
        .submit(Command::WaitTask { task_id: task.id() }, TIMEOUT)
        .unwrap();
    let fast = start(&client, 1);
    let fast_wait = client
        .submit(Command::WaitTask { task_id: fast.id() }, TIMEOUT)
        .unwrap();
    assert!(
        matches!(fast_wait.receive_blocking().unwrap(), Response::Reply(Reply::Task(t)) if t.status() == TaskStatus::Completed)
    );
    assert!(
        matches!(reply(&client, Command::CancelTask { task_id: task.id() }), Reply::Task(t) if t.status() == TaskStatus::Cancelled)
    );
    assert!(
        matches!(wait.receive_blocking().unwrap(), Response::Reply(Reply::Task(t)) if t.status() == TaskStatus::Cancelled)
    );
    let task = start(&client, 60_000);
    let wait = client
        .submit(
            Command::WaitTask { task_id: task.id() },
            Duration::from_millis(20),
        )
        .unwrap();
    assert_eq!(
        wait.receive_blocking().unwrap_err().code(),
        ErrorCode::Timeout
    );
    assert!(matches!(reply(&client, Command::Ping), Reply::Pong));
    let draining = client
        .submit(Command::WaitTask { task_id: task.id() }, TIMEOUT)
        .unwrap();
    close(&client);
    assert!(
        matches!(draining.receive_blocking().unwrap(), Response::Reply(Reply::Task(t)) if t.status() == TaskStatus::Cancelled)
    );
    assert!(client.submit(Command::Ping, TIMEOUT).is_err());
}
#[test]
fn backpressure_is_bounded_and_drop_cancels_wait() {
    let directory = Directory::new();
    let client = directory.client();
    let task = start(&client, 60_000);
    let mut pending = vec![];
    for _ in 0..MAX_PENDING_REQUESTS {
        pending.push(
            client
                .submit(Command::WaitTask { task_id: task.id() }, TIMEOUT)
                .unwrap(),
        );
    }
    assert_eq!(
        client.submit(Command::Ping, TIMEOUT).err().unwrap().code(),
        ErrorCode::Busy
    );
    assert!(
        matches!(reply(&client, Command::CancelTask { task_id: task.id() }), Reply::Task(t) if t.status() == TaskStatus::Cancelled)
    );
    for request in pending {
        assert!(
            matches!(request.receive_blocking().unwrap(), Response::Reply(Reply::Task(t)) if t.status() == TaskStatus::Cancelled)
        );
    }
    let task = start(&client, 60_000);
    drop(
        client
            .submit(Command::WaitTask { task_id: task.id() }, TIMEOUT)
            .unwrap(),
    );
    std::thread::sleep(Duration::from_millis(50));
    assert!(matches!(reply(&client, Command::Ping), Reply::Pong));
    close(&client);
}
#[test]
fn crash_reconnect_marks_interrupted_and_invalidates_resource_tokens() {
    let directory = Directory::new();
    let client = directory.client();
    let task = start(&client, 60_000);
    let Reply::Resource { token, .. } = reply(&client, Command::ExportDiagnostics) else {
        panic!()
    };
    let chunk = client
        .submit(
            Command::ReadResource {
                token,
                offset: 0,
                length: 1,
            },
            TIMEOUT,
        )
        .unwrap()
        .receive_blocking()
        .unwrap();
    assert!(
        matches!(chunk, Response::Chunk(header, bytes) if !header.is_end() && bytes.len() == 1)
    );
    let wait = client
        .submit(Command::WaitTask { task_id: task.id() }, TIMEOUT)
        .unwrap();
    let epoch = client.epoch();
    let next = client.reconnect().recv_blocking().unwrap().unwrap();
    assert_ne!(next.epoch(), epoch);
    assert_eq!(
        wait.receive_blocking().unwrap_err().code(),
        ErrorCode::Disconnected
    );
    let Reply::Tasks(tasks) = reply(&next, Command::ListTasks) else {
        panic!()
    };
    let recovered = tasks.iter().find(|t| t.id() == task.id()).unwrap();
    assert_eq!(recovered.status(), TaskStatus::Interrupted);
    assert!(recovered.sequence() > task.sequence());
    assert_eq!(
        next.submit(
            Command::ReadResource {
                token,
                offset: 0,
                length: 10
            },
            TIMEOUT
        )
        .unwrap()
        .receive_blocking()
        .unwrap_err()
        .code(),
        ErrorCode::InvalidToken
    );
    close(&next);
}
#[test]
fn diagnostics_export_binary_restart_and_clear() {
    let directory = Directory::new();
    let client = directory.client();
    reply(
        &client,
        Command::SetDiagnosticLevel {
            level: DiagnosticLevel::Full,
        },
    );
    for _ in 0..5 {
        reply(&client, Command::Ping);
    }
    let Reply::Resource { token, length } = reply(&client, Command::ExportDiagnostics) else {
        panic!()
    };
    let mut bytes = vec![];
    while bytes.len() < length as usize {
        let offset = bytes.len() as u64;
        let Response::Chunk(header, part) = client
            .submit(
                Command::ReadResource {
                    token,
                    offset,
                    length: 37,
                },
                TIMEOUT,
            )
            .unwrap()
            .receive_blocking()
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(header.offset(), offset);
        bytes.extend(part);
        assert_eq!(header.is_end(), bytes.len() as u64 == length);
    }
    let snapshot: DiagnosticSnapshot = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(snapshot.level(), DiagnosticLevel::Full);
    assert!(!snapshot.events().is_empty());
    reply(&client, Command::ReleaseResource { token });
    assert!(
        client
            .submit(
                Command::ReadResource {
                    token,
                    offset: 0,
                    length: 1
                },
                TIMEOUT
            )
            .unwrap()
            .receive_blocking()
            .is_err()
    );
    close(&client);
    let client = directory.client();
    assert!(
        matches!(reply(&client, Command::GetDiagnostics), Reply::Diagnostics(s) if s.level() == DiagnosticLevel::Full)
    );
    reply(&client, Command::ClearDiagnostics);
    assert!(
        matches!(reply(&client, Command::GetDiagnostics), Reply::Diagnostics(s) if s.events().is_empty())
    );
    close(&client);
}
#[test]
fn wire_rejects_unknown_oversized_truncated_and_stale_input() {
    for invalid in [0, 1, 2] {
        let directory = Directory::new();
        let mut raw = Raw::new(&directory);
        match invalid {
            0 => {
                let bytes = serde_json::to_vec(&serde_json::json!({"version":1,"epoch":raw.epoch,"request_id":1,"command":{"op":"execute_plugin","input":{"secret":"never log me"}}})).unwrap();
                write_frame(raw.input.as_mut().unwrap(), &Frame::Control(bytes)).unwrap();
            }
            1 => {
                let input = raw.input.as_mut().unwrap();
                input.write_all(&[1]).unwrap();
                input
                    .write_all(&((MAX_CONTROL_BYTES + 1) as u32).to_be_bytes())
                    .unwrap();
                input.flush().unwrap();
            }
            _ => {
                let input = raw.input.as_mut().unwrap();
                input.write_all(&[2, 0, 0, 0, 50, 0]).unwrap();
                drop(raw.input.take());
            }
        }
        assert!(matches!(raw.message(), ServerMessage::ProtocolError { .. }));
        raw.wait();
    }
    let directory = Directory::new();
    let mut raw = Raw::new(&directory);
    write_frame(
        raw.input.as_mut().unwrap(),
        &Frame::control(&Request::new(Uuid::new_v4(), 1, Command::Ping)).unwrap(),
    )
    .unwrap();
    assert!(
        matches!(raw.message(), ServerMessage::Response { result: Err(e), .. } if e.code() == ErrorCode::StaleSession)
    );
    raw.send(2, Command::Ping);
    assert!(matches!(
        raw.message(),
        ServerMessage::Response {
            result: Ok(Reply::Pong),
            ..
        }
    ));
    raw.send(2, Command::Ping);
    assert!(
        matches!(raw.message(), ServerMessage::Response { result: Err(e), .. } if e.code() == ErrorCode::StaleSession)
    );
    drop(raw.input.take());
    raw.wait();
}
#[test]
fn parent_pipe_closure_interrupts_inflight_tasks() {
    let directory = Directory::new();
    let mut raw = Raw::new(&directory);
    raw.send(1, Command::StartHealthCheck { delay_ms: 60_000 });
    let ServerMessage::Response {
        result: Ok(Reply::Task(task)),
        ..
    } = raw.message()
    else {
        panic!()
    };
    drop(raw.input.take());
    raw.wait();
    let client = directory.client();
    assert!(
        matches!(reply(&client, Command::ListTasks), Reply::Tasks(tasks) if tasks.iter().any(|t| t.id() == task.id() && t.status() == TaskStatus::Interrupted))
    );
    close(&client);
}
#[test]
fn parallel_callers_and_ping_latency_sample() {
    let directory = Directory::new();
    let client = directory.client();
    std::thread::scope(|scope| {
        for _ in 0..8 {
            let client = &client;
            scope.spawn(move || {
                for _ in 0..10 {
                    assert!(matches!(reply(client, Command::Ping), Reply::Pong));
                }
            });
        }
    });
    let mut elapsed = vec![];
    for _ in 0..50 {
        let start = Instant::now();
        reply(&client, Command::Ping);
        elapsed.push(start.elapsed().as_micros());
    }
    elapsed.sort();
    std::fs::write(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm03/ipc-latency.json"), serde_json::json!({"samples":50,"ping_p95_us":elapsed[47],"scope":"warm debug backend ping only; excludes save validation and SQLite business commit"}).to_string()).unwrap();
    close(&client);
}

fn document(
    client: &BackendClient,
    command: Command,
) -> anynote_core::document_session::DocumentSnapshot {
    match reply(client, command) {
        Reply::Document(snapshot) => snapshot,
        _ => panic!("document expected"),
    }
}
fn save_request(
    base: &anynote_core::document_session::DocumentSnapshot,
    generation: u64,
    body: &str,
) -> anynote_core::document_session::SaveDocument {
    use anynote_core::document_session::*;
    SaveDocument::new(
        Uuid::new_v4(),
        generation,
        DocumentSnapshot::new(
            base.id().clone(),
            base.revision(),
            base.head(),
            base.content().with_body(body.into()),
        ),
    )
}
#[test]
fn document_cas_lost_ack_restart_and_large_source() {
    let dir = Directory::new();
    let client = dir.client();
    let initial = document(&client, Command::CreateDocument);
    let body = "中文🦀\r\n".repeat(100_000);
    let pending = save_request(&initial, 4, &body);
    // Cancel only response delivery; a submitted write may still commit.
    drop(
        client
            .submit(Command::SaveDocument(pending.clone()), TIMEOUT)
            .unwrap(),
    );
    let saved = document(
        &client,
        Command::OpenDocument {
            id: initial.id().clone(),
        },
    );
    assert_eq!(saved.revision(), initial.revision() + 1);
    assert_eq!(saved.content().body(), body);
    let error = client
        .submit(Command::SaveDocument(pending), TIMEOUT)
        .unwrap()
        .receive_blocking()
        .unwrap_err();
    assert_eq!(error.code(), ErrorCode::Conflict);
    let other = document(&client, Command::CreateDocument);
    let next = save_request(&saved, 5, "latest");
    match reply(&client, Command::SaveDocument(next.clone())) {
        Reply::DocumentSaved(ack) => {
            assert_eq!(ack.epoch(), next.epoch());
            assert_eq!(ack.generation(), 5);
            assert_eq!(ack.snapshot().id(), initial.id());
        }
        _ => panic!("save ack expected"),
    }
    assert_eq!(
        document(
            &client,
            Command::OpenDocument {
                id: other.id().clone()
            }
        )
        .content()
        .body(),
        ""
    );
    close(&client);
    let client = dir.client();
    assert_eq!(
        document(
            &client,
            Command::OpenDocument {
                id: initial.id().clone()
            }
        )
        .content()
        .body(),
        "latest"
    );
    assert_eq!(
        document(&client, Command::OpenLastDocument).id(),
        initial.id()
    );
    close(&client);
}
#[test]
fn document_resources_are_bound_to_original_note_and_revision() {
    use anynote_core::document_session::DocumentId;
    use anynote_storage::notebook::{CreateNode, NotePatch, ResourceWrite, WriteQueue};
    let dir = Directory::new();
    let root = dir.0.join("workspace");
    std::fs::create_dir_all(&root).unwrap();
    let queue = WriteQueue::open(&root, 8).unwrap();
    let resource_id = Uuid::new_v4();
    let (id, first, second, other) = queue
        .submit(move |catalog| {
            let meta = catalog.create_notebook("resources")?;
            let book = catalog.notebook(&meta.id)?;
            let body = format!("![asset](anynote-resource:{resource_id})");
            let asset = |bytes: &[u8]| {
                ResourceWrite::bytes(
                    resource_id.to_string(),
                    "asset".into(),
                    "text/plain".into(),
                    bytes.into(),
                )
            };
            let note = book.create_node(
                &CreateNode::note("original", body.clone()),
                &[asset(b"old")?],
            )?;
            let next = book.save_note(
                &note.node.id,
                note.node.revision,
                &NotePatch {
                    body: Some(body),
                    ..Default::default()
                },
                &[asset(b"new")?],
            )?;
            let other = book.create_node(&CreateNode::note("other", ""), &[])?;
            Ok((
                DocumentId::new(
                    Uuid::parse_str(&meta.id).unwrap(),
                    Uuid::parse_str(&note.node.id).unwrap(),
                ),
                Uuid::parse_str(note.head_revision_id.as_ref().unwrap()).unwrap(),
                Uuid::parse_str(next.head_revision_id.as_ref().unwrap()).unwrap(),
                Uuid::parse_str(&other.node.id).unwrap(),
            ))
        })
        .unwrap()
        .wait()
        .unwrap();
    drop(queue);
    let client = dir.client();
    for (revision, expected) in [(first, b"old"), (second, b"new")] {
        match reply(
            &client,
            Command::DocumentResource {
                id: id.clone(),
                revision,
                resource: resource_id,
                offset: 0,
                length: 3,
            },
        ) {
            Reply::DocumentResource { bytes } => assert_eq!(bytes, expected),
            _ => panic!("bytes expected"),
        }
    }
    let error = client
        .submit(
            Command::DocumentResource {
                id: DocumentId::new(id.notebook(), other),
                revision: first,
                resource: resource_id,
                offset: 0,
                length: 3,
            },
            TIMEOUT,
        )
        .unwrap()
        .receive_blocking()
        .unwrap_err();
    assert_eq!(error.code(), ErrorCode::NotFound);
    close(&client);
}

#[test]
fn builtin_reading_and_settings_cross_real_backend_and_reopen() {
    use anynote_core::builtin::*;
    let directory = Directory::new();
    let client = directory.client();
    let Reply::Document(base) = reply(&client, Command::CreateDocument) else {
        panic!("document")
    };
    let req = ReadingRequest::new(Uuid::new_v4(), base.clone(), ReadingCommand::RecordSession);
    let Reply::Reading(saved) = reply(&client, Command::RunReading(req.clone())) else {
        panic!("reading")
    };
    assert!(saved.content().body().contains("第 1 次整理"));
    let Reply::Reading(again) = reply(&client, Command::RunReading(req)) else {
        panic!("reading")
    };
    assert_eq!(saved, again);
    let Reply::NotebookPreferences {
        revision,
        mut preferences,
    } = reply(
        &client,
        Command::GetNotebookPreferences {
            notebook: base.id().notebook(),
        },
    )
    else {
        panic!("preferences")
    };
    preferences.goal = 8;
    assert!(matches!(
        reply(
            &client,
            Command::SetNotebookPreferences {
                notebook: base.id().notebook(),
                expected: revision,
                preferences
            }
        ),
        Reply::NotebookPreferences { .. }
    ));
    close(&client);
    let client = directory.client();
    let Reply::Document(opened) = reply(
        &client,
        Command::OpenDocument {
            id: base.id().clone(),
        },
    ) else {
        panic!("document")
    };
    assert_eq!(opened, saved);
    let req = ReadingRequest::new(Uuid::new_v4(), opened, ReadingCommand::AppendGoal);
    let Reply::Reading(saved) = reply(&client, Command::RunReading(req)) else {
        panic!("reading")
    };
    assert!(saved.content().body().contains("目标：8 篇。"));
    close(&client);
}
