use anynote_core::backend::{Command, Reply};
use anynote_desktop::pdf::PdfServer;
use std::{
    io::{Read, Write},
    net::TcpStream,
    time::{Duration, Instant},
};
#[path = "support/pdf_backend.rs"]
mod support;

#[test]
fn system_pdf_preview_reads_revision_resource_and_releases_backend() {
    let backend = support::PdfBackend::new("w3c-dummy.pdf");
    let server = PdfServer::open(backend.client.clone(), backend.scope.clone()).unwrap();
    let (host, path) = server
        .url()
        .strip_prefix("http://")
        .unwrap()
        .split_once('/')
        .unwrap();
    let host = host.to_owned();
    let mut socket = TcpStream::connect(&host).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    write!(socket, "GET /{path} HTTP/1.1\r\nHost: {host}\r\n\r\n").unwrap();
    let mut bytes = Vec::new();
    socket.read_to_end(&mut bytes).unwrap();
    assert!(bytes.starts_with(b"HTTP/1.1 200 OK"));
    let start = bytes.windows(4).position(|b| b == b"\r\n\r\n").unwrap() + 4;
    assert_eq!(
        &bytes[start..],
        include_bytes!("../../../tests/fixtures/pdf/w3c-dummy.pdf")
    );
    drop(socket);
    drop(server);
    let deadline = Instant::now() + Duration::from_secs(2);
    while TcpStream::connect(&host).is_ok() {
        assert!(
            Instant::now() < deadline,
            "PDF URL still available after close"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(matches!(backend.reply(Command::Ping), Reply::Pong));
}
