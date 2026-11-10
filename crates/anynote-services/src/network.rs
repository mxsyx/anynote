use crate::importer::{ImportError, ImportResult, check};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{future::Future, sync::Arc};
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use url::Url;

/// Request-local observation only: callbacks cannot replace DNS, trust, or transport.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum NetworkEvent {
    Start {
        url: String,
        max_bytes: u64,
        response_ms: u64,
    },
    Dns {
        url: String,
        addresses: Vec<SocketAddr>,
        public: Vec<bool>,
        error: Option<String>,
    },
    Connect {
        url: String,
        pinned: SocketAddr,
    },
    Response {
        url: String,
        peer: Option<SocketAddr>,
        status: u16,
        certificate_sha256: Option<String>,
        content_length: Option<u64>,
    },
    Chunk {
        bytes: u64,
    },
    TransportError {
        message: String,
    },
    Finish {
        error: Option<String>,
        cancelled: bool,
    },
}
type Observer = Arc<dyn Fn(NetworkEvent) + Send + Sync>;
tokio::task_local! { static OBSERVER: Observer; }
pub async fn observe<T>(observer: Observer, future: impl Future<Output = T>) -> T {
    OBSERVER.scope(observer, future).await
}
fn emit(event: impl FnOnce() -> NetworkEvent) {
    let _ = OBSERVER.try_with(|observer| observer(event()));
}

pub fn is_public_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && [0, 168].contains(&b))
                || (a == 198 && [18, 19, 51].contains(&b))
                || (a == 203 && b == 0 && c == 113)
                || (a == 100 && (64..=127).contains(&b)))
        }
        IpAddr::V6(ip) => {
            let p = ip.segments();
            p[0] & 0xf000 == 0x2000
                && p[0] != 0x2002
                && !(p[0] == 0x2001 && (p[1] < 0x200 || p[1] == 0xdb8))
        }
    }
}
pub fn public_url(raw: &str) -> ImportResult<Url> {
    let u = Url::parse(raw).map_err(|_| ImportError::invalid("URL 无效"))?;
    check(
        ["http", "https"].contains(&u.scheme())
            && u.username().is_empty()
            && u.password().is_none()
            && u.host_str().is_some(),
        "仅允许无凭据的 HTTP(S) 地址",
    )?;
    Ok(u)
}
fn validate_addresses(addresses: &[SocketAddr]) -> ImportResult<()> {
    check(
        !addresses.is_empty() && addresses.iter().all(|a| is_public_address(a.ip())),
        "不允许私网、回环、链路本地或保留地址",
    )
}
fn validate_peer(peer: Option<SocketAddr>, pinned: SocketAddr) -> ImportResult<()> {
    check(
        peer == Some(pinned) && is_public_address(pinned.ip()),
        "连接地址校验失败",
    )
}
#[derive(Debug)]
pub struct Download {
    pub url: String,
    pub content_type: String,
    pub size: u64,
}

/// One deadline covers DNS, every redirect, body streaming, and sink backpressure.
pub async fn download<W: AsyncWrite + Unpin>(
    raw: &str,
    max_bytes: u64,
    response_ms: u64,
    cancel: &CancellationToken,
    sink: &mut W,
) -> ImportResult<Download> {
    check(
        max_bytes > 0 && max_bytes <= 50 * 1024 * 1024 && response_ms > 0 && response_ms <= 30_000,
        "下载预算无效",
    )?;
    emit(|| NetworkEvent::Start {
        url: raw.into(),
        max_bytes,
        response_ms,
    });
    let result = bounded(cancel, response_ms, download_inner(raw, max_bytes, sink)).await;
    emit(|| NetworkEvent::Finish {
        error: result.as_ref().err().map(|e| e.message.clone()),
        cancelled: result.as_ref().err().is_some_and(|e| e.cancelled),
    });
    result
}
async fn bounded<T>(
    cancel: &CancellationToken,
    response_ms: u64,
    future: impl std::future::Future<Output = ImportResult<T>>,
) -> ImportResult<T> {
    tokio::select! {
        biased;
        _=cancel.cancelled()=>Err(ImportError::cancelled()),
        result=tokio::time::timeout(Duration::from_millis(response_ms),future)=>result.map_err(|_|ImportError::invalid("下载超时"))?,
    }
}
async fn download_inner<W: AsyncWrite + Unpin>(
    raw: &str,
    max_bytes: u64,
    sink: &mut W,
) -> ImportResult<Download> {
    let mut u = public_url(raw)?;
    for redirect in 0..=5 {
        let host = u.host_str().unwrap().trim_matches(['[', ']']);
        let port = u.port_or_known_default().unwrap();
        let addresses = if let Ok(ip) = host.parse::<IpAddr>() {
            vec![SocketAddr::new(ip, port)]
        } else {
            match tokio::net::lookup_host((host, port)).await {
                Ok(records) => records.collect::<Vec<_>>(),
                Err(error) => {
                    emit(|| NetworkEvent::Dns {
                        url: u.to_string(),
                        addresses: vec![],
                        public: vec![],
                        error: Some(error.to_string()),
                    });
                    return Err(error.into());
                }
            }
        };
        emit(|| NetworkEvent::Dns {
            url: u.to_string(),
            public: addresses
                .iter()
                .map(|a| is_public_address(a.ip()))
                .collect(),
            addresses: addresses.clone(),
            error: None,
        });
        validate_addresses(&addresses)?;
        let pinned = addresses[0];
        let response = request(&u, pinned).await?;
        validate_peer(response.remote_addr(), pinned)?;
        if response.status().is_redirection() {
            check(redirect < 5, "重定向次数超限")?;
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| ImportError::invalid("重定向地址缺失"))?;
            u = public_url(
                u.join(location)
                    .map_err(|_| ImportError::invalid("重定向地址无效"))?
                    .as_str(),
            )?;
            continue;
        }
        return consume(response, &u, max_bytes, sink).await;
    }
    unreachable!()
}

async fn request(u: &Url, pinned: SocketAddr) -> ImportResult<reqwest::Response> {
    let host = u.host_str().unwrap().trim_matches(['[', ']']);
    let client = reqwest::Client::builder()
        .no_proxy()
        .tls_info(OBSERVER.try_with(|_| ()).is_ok())
        .redirect(reqwest::redirect::Policy::none())
        .resolve(host, pinned)
        .referer(false)
        .user_agent("Anynote/0.2")
        .timeout(Duration::from_secs(30))
        .build()?;
    emit(|| NetworkEvent::Connect {
        url: u.to_string(),
        pinned,
    });
    let response = client.get(u.clone()).send().await.map_err(|error| {
        emit(|| {
            use std::error::Error;
            let mut message = error.to_string();
            let mut source = error.source();
            while let Some(error) = source {
                message.push_str(": ");
                message.push_str(&error.to_string());
                source = error.source();
            }
            NetworkEvent::TransportError { message }
        });
        ImportError::from(error)
    })?;
    emit(|| NetworkEvent::Response {
        url: u.to_string(),
        peer: response.remote_addr(),
        status: response.status().as_u16(),
        certificate_sha256: response
            .extensions()
            .get::<reqwest::tls::TlsInfo>()
            .and_then(|info| info.peer_certificate())
            .map(|cert| format!("{:x}", Sha256::digest(cert))),
        content_length: response.content_length(),
    });
    Ok(response)
}
async fn consume<W: AsyncWrite + Unpin>(
    mut response: reqwest::Response,
    u: &Url,
    max_bytes: u64,
    sink: &mut W,
) -> ImportResult<Download> {
    check(
        response.status() == reqwest::StatusCode::OK,
        "下载 HTTP 状态失败",
    )?;
    check(
        response.content_length().is_none_or(|n| n <= max_bytes),
        "响应大小超过上限",
    )?;
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let mut size = 0;
    while let Some(bytes) = response.chunk().await? {
        emit(|| NetworkEvent::Chunk {
            bytes: bytes.len() as u64,
        });
        size += bytes.len() as u64;
        check(size <= max_bytes, "响应大小超过上限")?;
        sink.write_all(&bytes).await?;
    }
    sink.flush().await?;
    Ok(Download {
        url: u.to_string(),
        content_type,
        size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn observation_is_scoped_and_preserves_policy_and_cancellation() {
        use std::sync::Mutex;
        let events = Arc::new(Mutex::new(Vec::new()));
        let record = events.clone();
        let cancel = CancellationToken::new();
        let result = observe(
            Arc::new(move |event| record.lock().unwrap().push(event)),
            async { download("https://127.0.0.1/", 10, 1000, &cancel, &mut Vec::new()).await },
        )
        .await;
        assert!(result.is_err());
        let captured = events.lock().unwrap().clone();
        assert!(matches!(
            captured.as_slice(),
            [
                NetworkEvent::Start { .. },
                NetworkEvent::Dns { .. },
                NetworkEvent::Finish { .. }
            ]
        ));
        assert!(matches!(&captured[1], NetworkEvent::Dns { public, .. } if public == &[false]));
        let _ = download("https://127.0.0.1/", 10, 1000, &cancel, &mut Vec::new()).await;
        assert_eq!(events.lock().unwrap().len(), captured.len());
        cancel.cancel();
        let record = events.clone();
        let result = observe(
            Arc::new(move |event| record.lock().unwrap().push(event)),
            async { download("https://8.8.8.8/", 10, 1000, &cancel, &mut Vec::new()).await },
        )
        .await;
        assert!(result.unwrap_err().cancelled);
        assert!(matches!(
            events.lock().unwrap().last(),
            Some(NetworkEvent::Finish {
                cancelled: true,
                ..
            })
        ));
    }

    #[test]
    fn policy_checks_all_dns_answers_and_exact_peer() {
        for ip in [
            "0.0.0.0",
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.168.1.1",
            "100.64.0.1",
            "198.18.0.1",
            "203.0.113.1",
            "224.1.1.1",
            "::1",
            "::ffff:8.8.8.8",
            "2001:db8::1",
            "2001:2::1",
            "2001:20::1",
            "2002:808:808::1",
        ] {
            assert!(!is_public_address(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "1.1.1.1", "2606:4700::1111"] {
            assert!(is_public_address(ip.parse().unwrap()));
        }
        let public = "8.8.8.8:443".parse().unwrap();
        assert!(validate_addresses(&[public, "127.0.0.1:443".parse().unwrap()]).is_err());
        assert!(validate_addresses(&[]).is_err());
        assert!(validate_peer(Some("1.1.1.1:443".parse().unwrap()), public).is_err());
        assert!(validate_peer(Some(public), public).is_ok());
        for raw in [
            "file:///a",
            "https://a:b@example.com/",
            "ftp://example.com/",
        ] {
            assert!(public_url(raw).is_err());
        }
    }
    #[tokio::test]
    async fn cancellation_and_private_addresses_do_not_connect() {
        let cancel = CancellationToken::new();
        let mut sink = Vec::new();
        assert!(
            download("http://127.0.0.1", 100, 100, &cancel, &mut sink)
                .await
                .is_err()
        );
        cancel.cancel();
        assert!(
            download("https://8.8.8.8", 100, 100, &cancel, &mut sink)
                .await
                .unwrap_err()
                .cancelled
        );
        assert!(sink.is_empty());
    }
    fn serve(response: Vec<u8>, delay: Duration) -> (SocketAddr, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let thread = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0; 4096];
            let _ = socket.read(&mut request);
            std::thread::sleep(delay);
            let _ = socket.write_all(&response);
        });
        (address, thread)
    }
    #[tokio::test]
    async fn real_socket_stream_limits_redirect_policy_and_sink_failure() {
        for (response, limit, success) in [
            (
                "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nabc",
                3,
                true,
            ),
            (
                "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nabcd",
                3,
                false,
            ),
            (
                "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\nab\r\n2\r\ncd\r\n0\r\n\r\n",
                3,
                false,
            ),
            (
                "HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                3,
                false,
            ),
        ] {
            let (address, thread) = serve(response.as_bytes().to_vec(), Duration::ZERO);
            let url = Url::parse(&format!("http://fixture.invalid:{}/", address.port())).unwrap();
            let response = request(&url, address).await.unwrap();
            assert_eq!(response.remote_addr(), Some(address));
            let mut sink = Vec::new();
            assert_eq!(
                consume(response, &url, limit, &mut sink).await.is_ok(),
                success
            );
            assert!(sink.len() <= limit as usize);
            thread.join().unwrap();
        }
        let(address,thread)=serve(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),Duration::ZERO);
        let url = Url::parse(&format!("http://fixture.invalid:{}/", address.port())).unwrap();
        let response = request(&url, address).await.unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::FOUND);
        let redirect = public_url(response.headers()["location"].to_str().unwrap()).unwrap();
        assert!(
            download(
                redirect.as_str(),
                10,
                100,
                &CancellationToken::new(),
                &mut Vec::new()
            )
            .await
            .is_err()
        );
        thread.join().unwrap();
        let (address, thread) = serve(
            b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc".to_vec(),
            Duration::ZERO,
        );
        let url = Url::parse(&format!("http://fixture.invalid:{}/", address.port())).unwrap();
        let response = request(&url, address).await.unwrap();
        let (mut sink, reader) = tokio::io::duplex(1);
        drop(reader);
        assert!(consume(response, &url, 100, &mut sink).await.is_err());
        thread.join().unwrap();
    }
    #[tokio::test]
    async fn deadline_and_cancel_include_slow_headers_and_sink_backpressure() {
        let (address, thread) = serve(
            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
            Duration::from_millis(50),
        );
        let url = Url::parse(&format!("http://fixture.invalid:{}/", address.port())).unwrap();
        let cancel = CancellationToken::new();
        assert!(
            bounded(&cancel, 10, request(&url, address))
                .await
                .unwrap_err()
                .message
                .contains("超时")
        );
        thread.join().unwrap();
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(5)).await;
            trigger.cancel();
        });
        let (mut sink, _reader) = tokio::io::duplex(1);
        let result = bounded(&cancel, 1000, async {
            sink.write_all(&[0; 100]).await?;
            Ok(())
        })
        .await;
        assert!(result.unwrap_err().cancelled);
    }
    #[tokio::test]
    async fn tls_rejects_self_signed_certificate_with_pinned_hostname() {
        use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer};
        use std::io::Write;
        let _ = rustls::crypto::ring::default_provider().install_default();
        let cert = CertificateDer::from(
            include_bytes!("../../../tests/fixtures/import/tls/cert.der").to_vec(),
        );
        let key = PrivatePkcs8KeyDer::from(
            include_bytes!("../../../tests/fixtures/import/tls/key.der").to_vec(),
        );
        let config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![cert], key.into())
            .unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let thread = std::thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let conn = rustls::ServerConnection::new(std::sync::Arc::new(config)).unwrap();
            let mut tls = rustls::StreamOwned::new(conn, socket);
            let _ = tls.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
        });
        let url = Url::parse(&format!("https://fixture.invalid:{}/", address.port())).unwrap();
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let record = events.clone();
        assert!(
            observe(
                Arc::new(move |event| record.lock().unwrap().push(event)),
                request(&url, address)
            )
            .await
            .is_err()
        );
        let captured = events.lock().unwrap().clone();
        assert!(captured.iter().any(|event| matches!(event,
            NetworkEvent::TransportError { message } if message.contains("invalid peer certificate") && message.contains("CaUsedAsEndEntity")
        )), "{captured:?}");
        thread.join().unwrap();
    }
}
