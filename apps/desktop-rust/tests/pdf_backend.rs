#![cfg(feature = "media")]
#[path = "support/pdf_backend.rs"]
mod support;
use anynote_core::{asset::*, backend::*};
use anynote_desktop::pdf::{PdfError, PdfWorker, ResourceReader};
use std::{
    io::{Read, Seek, SeekFrom},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use support::PdfBackend;
use uuid::Uuid;
#[test]
fn revision_scoped_reader_rejects_wrong_scope_and_releases_leases() {
    let f = PdfBackend::new("geometry.pdf");
    let Reply::Document(snapshot) = f.reply(Command::OpenDocument {
        id: f.scope.document().clone(),
    }) else {
        panic!()
    };
    assert_eq!(snapshot.primary_pdf(), Some(f.scope.resource()));
    let cancelled = Arc::new(AtomicBool::new(false));
    for _ in 0..20 {
        let mut reader =
            ResourceReader::open(f.client.clone(), f.scope.clone(), cancelled.clone()).unwrap();
        let mut header = [0; 5];
        reader.read_exact(&mut header).unwrap();
        assert_eq!(&header, b"%PDF-");
        reader.seek(SeekFrom::End(-8)).unwrap();
        let mut tail = vec![];
        reader.read_to_end(&mut tail).unwrap();
        assert!(tail.windows(5).any(|w| w == b"%%EOF"));
        assert!(reader.seek(SeekFrom::End(1)).is_err());
    }
    let wrong = AssetScope::new(
        f.scope.document().clone(),
        Uuid::new_v4(),
        f.scope.resource(),
    );
    assert!(ResourceReader::open(f.client.clone(), wrong, cancelled.clone()).is_err());
    let mut reader =
        ResourceReader::open(f.client.clone(), f.scope.clone(), cancelled.clone()).unwrap();
    cancelled.store(true, Ordering::Release);
    assert!(reader.read(&mut [0; 10]).is_err());
    let token = Uuid::new_v4();
    f.reply(Command::Asset(AssetCommand::Open {
        scope: f.scope.clone(),
        token,
    }));
    f.reply(Command::Asset(AssetCommand::Close { token }));
    assert!(
        f.client
            .submit(
                Command::Asset(AssetCommand::Read {
                    token,
                    offset: 0,
                    length: 5
                }),
                Duration::from_secs(5)
            )
            .unwrap()
            .receive_blocking()
            .is_err()
    );
}
#[test]
fn worker_latest_request_close_and_password_retry() {
    let f = PdfBackend::new("encrypted.pdf");
    let (bad, ready) = PdfWorker::open(f.client.clone(), f.scope.clone(), "bad".into());
    assert_eq!(
        ready.recv_blocking().unwrap().unwrap_err(),
        PdfError::Password
    );
    drop(bad);
    let (worker, ready) = PdfWorker::open(f.client.clone(), f.scope.clone(), "rm25-test".into());
    assert_eq!(ready.recv_blocking().unwrap().unwrap().0, 8);
    let first = worker.render(0, 4096, true);
    let last = worker.render(7, 640, true);
    let result = last.recv_blocking().unwrap().unwrap();
    assert_eq!(result.page(), 7);
    assert!(result.text().contains("Anynote page 8"));
    let _ = first.recv_blocking();
    let pending = worker.render(5, 4096, true);
    worker.close();
    assert!(pending.recv_blocking().unwrap().is_err());
    assert_eq!(
        worker
            .render(0, 640, true)
            .recv_blocking()
            .unwrap()
            .unwrap_err(),
        PdfError::Cancelled
    );
    // Closing sessions must not accumulate the backend's 16 lease slots.
    for _ in 0..20 {
        let (worker, ready) =
            PdfWorker::open(f.client.clone(), f.scope.clone(), "rm25-test".into());
        assert!(ready.recv_blocking().unwrap().is_ok());
        worker.close();
        drop(worker);
    }
}
