#![cfg(feature = "media")]
#[path = "support/pdf_backend.rs"]
mod support;

use anynote_core::backend::Command;
use anynote_desktop::pdf::{PdfError, PdfWorker, ResourceReader, engine};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    process,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use support::PdfBackend;

#[test]
fn native_io_failures_survive_and_allow_reopen() {
    for scenario in [
        "stream-render",
        "stream-extract",
        "truncate-render",
        "truncate-extract",
        "disconnect",
        "disconnect-open",
    ] {
        let mut child = process::Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "native_io_child", "--nocapture"])
            .env("ANYNOTE_TEST_PDF_IO", scenario)
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(60);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("{scenario}: native IO did not terminate");
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(
            status.success(),
            "{scenario}: native IO child exited {status}"
        );
    }
}

struct StreamFailure {
    file: File,
    triggered: Arc<AtomicBool>,
    dropped: Arc<AtomicBool>,
}
impl Read for StreamFailure {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        // geometry.pdf has 416-byte content streams. Fail the stream's direct
        // read, after its dictionary is parsed, to reach the old ReadStream CHECK.
        if buf.len() == 416 {
            self.file.set_len(0)?;
            self.triggered.store(true, Ordering::Release);
        }
        self.file.read(buf)
    }
}
impl Seek for StreamFailure {
    fn seek(&mut self, from: SeekFrom) -> std::io::Result<u64> {
        self.file.seek(from)
    }
}
impl Drop for StreamFailure {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::Release);
    }
}

#[test]
#[ignore = "native crash regression subprocess"]
fn native_io_child() {
    let scenario = std::env::var("ANYNOTE_TEST_PDF_IO").unwrap();
    if scenario == "disconnect-open" {
        let backend = PdfBackend::new("geometry.pdf");
        let reader = ResourceReader::open(backend.client.clone(), backend.scope.clone()).unwrap();
        backend.reply(Command::Shutdown);
        assert!(matches!(
            engine::open(reader, None),
            Err(PdfError::Resource)
        ));
    } else if scenario == "disconnect" {
        let backend = PdfBackend::new("geometry.pdf");
        let (worker, ready) =
            PdfWorker::open(backend.client.clone(), backend.scope.clone(), String::new());
        assert_eq!(ready.recv_blocking().unwrap().unwrap().0, 8);
        backend.reply(Command::Shutdown);
        assert_eq!(
            worker
                .render(7, 640, true)
                .recv_blocking()
                .unwrap()
                .unwrap_err(),
            PdfError::Resource
        );
        worker.close();
    } else {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/f006");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join(format!("truncate-{}.pdf", uuid::Uuid::new_v4()));
        std::fs::copy(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../tests/fixtures/pdf/geometry.pdf"),
            &path,
        )
        .unwrap();
        let triggered = Arc::new(AtomicBool::new(false));
        let dropped = Arc::new(AtomicBool::new(false));
        let doc = engine::open(
            StreamFailure {
                file: File::options().read(true).write(true).open(&path).unwrap(),
                triggered: triggered.clone(),
                dropped: dropped.clone(),
            },
            None,
        )
        .unwrap();
        assert_eq!(doc.page_count().unwrap(), 8);
        if !scenario.starts_with("stream-") {
            File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_len(0)
                .unwrap();
        }
        let result = if scenario.ends_with("render") {
            engine::render(&doc, 7, 640, true, || false).map(|_| ())
        } else {
            engine::extract(&doc, 7, 100_000, || false).map(|_| ())
        };
        assert_eq!(result, Err(PdfError::Resource));
        if scenario.starts_with("stream-") {
            assert!(triggered.load(Ordering::Acquire));
        }
        // Restoring bytes cannot make this damaged native document trustworthy.
        std::fs::copy(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../tests/fixtures/pdf/geometry.pdf"),
            &path,
        )
        .unwrap();
        assert_eq!(doc.page_count(), Err(PdfError::Resource));
        assert_eq!(
            engine::extract(&doc, 0, 100, || false),
            Err(PdfError::Resource)
        );
        assert_eq!(
            engine::render(&doc, 0, 160, false, || false).unwrap_err(),
            PdfError::Resource
        );
        assert!(!dropped.load(Ordering::Acquire));
        drop(doc);
        assert!(dropped.load(Ordering::Acquire));
        let reopened = engine::open(File::open(&path).unwrap(), None).unwrap();
        assert!(
            engine::extract(&reopened, 7, 100_000, || false)
                .unwrap()
                .0
                .contains("Anynote page 8")
        );
        drop(reopened);
        std::fs::remove_file(path).unwrap();
    }
    let backend = PdfBackend::new("geometry.pdf");
    for _ in 0..20 {
        let (worker, ready) =
            PdfWorker::open(backend.client.clone(), backend.scope.clone(), String::new());
        assert_eq!(ready.recv_blocking().unwrap().unwrap().0, 8);
        assert!(
            worker
                .render(7, 160, true)
                .recv_blocking()
                .unwrap()
                .unwrap()
                .text()
                .contains("Anynote page 8")
        );
        worker.close();
    }
}

struct ShortReads(std::io::Cursor<Vec<u8>>);
impl Read for ShortReads {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let length = buffer.len().min(7);
        self.0.read(&mut buffer[..length])
    }
}
impl Seek for ShortReads {
    fn seek(&mut self, from: SeekFrom) -> std::io::Result<u64> {
        self.0.seek(from)
    }
}

#[test]
fn native_callback_fills_short_reads_before_reporting_success() {
    let bytes = std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/pdf/geometry.pdf"),
    )
    .unwrap();
    let doc = engine::open(ShortReads(std::io::Cursor::new(bytes)), None).unwrap();
    assert_eq!(doc.page_count().unwrap(), 8);
    assert!(
        engine::render(&doc, 7, 160, true, || false)
            .unwrap()
            .text()
            .contains("Anynote page 8")
    );
}
