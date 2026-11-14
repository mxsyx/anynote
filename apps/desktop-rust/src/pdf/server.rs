use super::reader::ResourceReader;
use crate::{backend_client::BackendClient, webview::policy::byte_range_with_limit};
use anynote_core::asset::AssetScope;
use std::{
    io::{self, Read, Seek, SeekFrom, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use uuid::Uuid;

/// Owns a revocable URL for one revision-bound PDF; no notebook paths reach the viewer.
pub struct PdfServer {
    url: String,
    closed: Arc<AtomicBool>,
    stop: mpsc::Sender<()>,
}
impl PdfServer {
    pub fn open(client: BackendClient, scope: AssetScope) -> Result<Self, String> {
        let reader = ResourceReader::open(client, scope)?;
        let length = reader.length();
        Self::start(reader, length).map_err(|_| "无法启动 PDF 本机预览，请重试或导出文件".into())
    }
    fn start(reader: impl Read + Seek + Send + 'static, length: u64) -> io::Result<Self> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let authority = listener.local_addr()?.to_string();
        let path = format!("/{}/document.pdf", Uuid::new_v4());
        let url = format!("http://{authority}{path}");
        let closed = Arc::new(AtomicBool::new(false));
        let cancelled = closed.clone();
        let (stop, stopping) = mpsc::channel();
        std::thread::Builder::new()
            .name("anynote-pdf-source".into())
            .spawn(move || {
                let mut reader = reader;
                while !cancelled.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            let _ = respond(
                                &mut stream,
                                &mut reader,
                                length,
                                &authority,
                                &path,
                                &cancelled,
                            );
                        }
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                            if stopping.recv_timeout(Duration::from_millis(50)).is_ok() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            })?;
        Ok(Self { url, closed, stop })
    }
    pub fn url(&self) -> &str {
        &self.url
    }
}
impl Drop for PdfServer {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::Release);
        let _ = self.stop.send(());
    }
}
fn failure(stream: &mut TcpStream, status: &str, extra: &str) -> io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n{extra}\r\n"
    )
}
fn respond(
    stream: &mut TcpStream,
    reader: &mut (impl Read + Seek),
    length: u64,
    authority: &str,
    path: &str,
    closed: &AtomicBool,
) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(1)))?;
    stream.set_write_timeout(Some(Duration::from_secs(1)))?;
    let mut buffer = [0u8; 8192];
    let mut used = 0;
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if closed.load(Ordering::Acquire) || Instant::now() > deadline {
            return Ok(());
        }
        if used == buffer.len() {
            return failure(stream, "431 Request Header Fields Too Large", "");
        }
        let read = stream.read(&mut buffer[used..])?;
        if read == 0 {
            return Ok(());
        }
        used += read;
        if buffer[..used].windows(4).any(|v| v == b"\r\n\r\n") {
            break;
        }
    }
    let mut headers = [httparse::EMPTY_HEADER; 32];
    let mut request = httparse::Request::new(&mut headers);
    if !matches!(
        request.parse(&buffer[..used]),
        Ok(httparse::Status::Complete(_))
    ) {
        return failure(stream, "400 Bad Request", "");
    }
    let header = |name: &str| {
        request
            .headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case(name))
            .and_then(|h| std::str::from_utf8(h.value).ok())
    };
    if request.path != Some(path)
        || header("Host") != Some(authority)
        || header("Origin").is_some_and(|v| v != format!("http://{authority}"))
    {
        return failure(stream, "403 Forbidden", "");
    }
    if !matches!(request.method, Some("GET" | "HEAD")) {
        return failure(stream, "405 Method Not Allowed", "Allow: GET, HEAD\r\n");
    }
    let range = header("Range");
    let Ok(span) = byte_range_with_limit(range, length as usize, usize::MAX) else {
        return failure(
            stream,
            "416 Range Not Satisfiable",
            &format!("Content-Range: bytes */{length}\r\n"),
        );
    };
    let status = if range.is_some() {
        "206 Partial Content"
    } else {
        "200 OK"
    };
    let content_range = if range.is_some() {
        format!(
            "Content-Range: bytes {}-{}/{length}\r\n",
            span.start,
            span.end - 1
        )
    } else {
        String::new()
    };
    reader.seek(SeekFrom::Start(span.start as u64))?;
    // A fixed buffer bounds application memory even for a viewer requesting the entire file.
    let mut chunk = [0u8; 64 * 1024];
    let mut remaining = span.len();
    let head = request.method == Some("HEAD");
    let first = remaining.min(chunk.len());
    if !head && reader.read_exact(&mut chunk[..first]).is_err() {
        return failure(stream, "503 Service Unavailable", "");
    }
    if closed.load(Ordering::Acquire) {
        return Ok(());
    }
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: application/pdf\r\nContent-Disposition: inline; filename=\"document.pdf\"\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n{content_range}\r\n",
        span.len()
    )?;
    if head {
        return Ok(());
    }
    stream.write_all(&chunk[..first])?;
    remaining -= first;
    while remaining > 0 && !closed.load(Ordering::Acquire) {
        let count = remaining.min(chunk.len());
        reader.read_exact(&mut chunk[..count])?;
        if closed.load(Ordering::Acquire) {
            break;
        }
        stream.write_all(&chunk[..count])?;
        remaining -= count;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn get(server: &PdfServer, method: &str, extra: &str, override_path: Option<&str>) -> Vec<u8> {
        let (authority, path) = server
            .url()
            .strip_prefix("http://")
            .unwrap()
            .split_once('/')
            .unwrap();
        let mut socket = TcpStream::connect(authority).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        write!(
            socket,
            "{method} /{} HTTP/1.1\r\nHost: {authority}\r\n{extra}\r\n",
            override_path.unwrap_or(path)
        )
        .unwrap();
        let mut response = Vec::new();
        socket.read_to_end(&mut response).unwrap();
        response
    }
    #[test]
    fn failed_pdf_source_returns_error_without_partial_pdf() {
        let source = PdfServer::start(io::Cursor::new(b"partial".to_vec()), 100).unwrap();
        let response = get(&source, "GET", "", None);
        assert!(response.starts_with(b"HTTP/1.1 503"));
        assert!(!response.windows(7).any(|bytes| bytes == b"partial"));
    }

    #[test]
    fn system_pdf_source_serves_exact_bytes_ranges_and_revokes() {
        let bytes: Vec<u8> = (0..200_000).map(|n| (n % 251) as u8).collect();
        let source = PdfServer::start(io::Cursor::new(bytes.clone()), bytes.len() as u64).unwrap();
        let response = get(&source, "GET", "", None);
        let split = response.windows(4).position(|b| b == b"\r\n\r\n").unwrap() + 4;
        assert_eq!(&response[split..], bytes);
        for (header, expected) in [
            ("bytes=100-999", &bytes[100..1000]),
            ("bytes=-5", &bytes[bytes.len() - 5..]),
            ("bytes=199998-", &bytes[199998..]),
        ] {
            let response = get(&source, "GET", &format!("Range: {header}\r\n"), None);
            assert!(response.starts_with(b"HTTP/1.1 206"));
            let split = response.windows(4).position(|b| b == b"\r\n\r\n").unwrap() + 4;
            assert_eq!(&response[split..], expected);
        }
        assert!(get(&source, "HEAD", "", None).ends_with(b"\r\n\r\n"));
        assert!(get(&source, "GET", "Range: bytes=999999-\r\n", None).starts_with(b"HTTP/1.1 416"));
        assert!(get(&source, "POST", "", None).starts_with(b"HTTP/1.1 405"));
        assert!(
            get(&source, "GET", "Origin: https://example.com\r\n", None)
                .starts_with(b"HTTP/1.1 403")
        );
        assert!(get(&source, "GET", "", Some("wrong/document.pdf")).starts_with(b"HTTP/1.1 403"));
        let authority = source
            .url()
            .strip_prefix("http://")
            .unwrap()
            .split('/')
            .next()
            .unwrap()
            .to_owned();
        drop(source);
        let deadline = Instant::now() + Duration::from_secs(2);
        while TcpStream::connect(&authority).is_ok() {
            assert!(
                Instant::now() < deadline,
                "PDF source stayed alive after close"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
