//! A local view owns a revocable, revision-bound capability set. No storage paths cross IPC.
use anynote_core::{asset::AssetScope, document_session::DocumentId};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{Duration, Instant},
};
use uuid::Uuid;

pub const MAX_MESSAGE: usize = 64 * 1024;
pub const MAX_RANGE: usize = 256 * 1024;
pub const LOCAL_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Binding {
    view_id: Uuid,
    epoch: Uuid,
    document: DocumentId,
    revision: Uuid,
}
impl Binding {
    pub fn new(document: DocumentId, revision: Uuid) -> Self {
        Self {
            view_id: Uuid::new_v4(),
            epoch: Uuid::new_v4(),
            document,
            revision,
        }
    }
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Envelope {
    protocol_version: u32,
    request_id: Uuid,
    binding: Binding,
    token: Uuid,
    message: Message,
}
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    content = "payload",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Message {
    Ready,
    Rendered { generation: u64 },
    Failed { code: Failure },
    Viewport { width: u32, height: u32 },
}
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Failure {
    Unsupported,
    Render,
    Resource,
}
#[derive(Debug, PartialEq, Eq)]
pub enum Rejection {
    Closed,
    Origin,
    Oversize,
    Invalid,
    Stale,
    Token,
    Rate,
    Duplicate,
    Resource,
    Range,
}
pub type ResourceChunk = (Vec<u8>, &'static str, std::ops::Range<usize>, usize);
struct Resource {
    bytes: Arc<[u8]>,
    mime: &'static str,
}
pub struct LocalSession {
    binding: Binding,
    token: Uuid,
    origin: String,
    active: bool,
    seen: HashSet<Uuid>,
    bucket: Instant,
    count: u32,
    resources: HashMap<Uuid, Resource>,
    resource_bytes: usize,
}
impl LocalSession {
    pub fn new(binding: Binding) -> Self {
        let host = binding.view_id.simple().to_string();
        let origin = if cfg!(target_os = "windows") {
            format!("http://anynote-view.{host}")
        } else {
            format!("anynote-view://{host}")
        };
        Self {
            binding,
            token: Uuid::new_v4(),
            origin,
            active: true,
            seen: HashSet::new(),
            bucket: Instant::now(),
            count: 0,
            resources: HashMap::new(),
            resource_bytes: 0,
        }
    }
    pub fn is_active(&self) -> bool {
        self.active
    }
    pub fn origin(&self) -> &str {
        &self.origin
    }
    pub fn page_url(&self) -> String {
        format!("{}/index.html", self.origin)
    }
    pub fn bootstrap(&self) -> String {
        serde_json::json!({"protocolVersion":1,"binding":self.binding,"token":self.token,"requestId":Uuid::new_v4(),"renderId":Uuid::new_v4(),"resources":self.resources.keys().map(|token| format!("{}/resource/{token}", self.origin)).collect::<Vec<_>>()}).to_string()
    }
    fn rate(&mut self, now: Instant) -> Result<(), Rejection> {
        if now.saturating_duration_since(self.bucket) >= Duration::from_secs(1) {
            self.bucket = now;
            self.count = 0;
        }
        self.count += 1;
        if self.count > 120 {
            Err(Rejection::Rate)
        } else {
            Ok(())
        }
    }
    pub fn accept(&mut self, source: &str, body: &str, now: Instant) -> Result<Message, Rejection> {
        if !self.active {
            return Err(Rejection::Closed);
        }
        if source != self.page_url() {
            return Err(Rejection::Origin);
        }
        self.rate(now)?;
        if body.len() > MAX_MESSAGE {
            return Err(Rejection::Oversize);
        }
        let envelope: Envelope = serde_json::from_str(body).map_err(|_| Rejection::Invalid)?;
        if envelope.protocol_version != 1 || envelope.binding != self.binding {
            return Err(Rejection::Stale);
        }
        if envelope.token != self.token {
            return Err(Rejection::Token);
        }
        if self.seen.contains(&envelope.request_id) {
            return Err(Rejection::Duplicate);
        }
        // A bounded lifetime also bounds replay memory; a caller can rebuild with a new epoch.
        if self.seen.len() >= 4096 {
            return Err(Rejection::Rate);
        }
        if let Message::Viewport { width, height } = envelope.message
            && (width == 0 || height == 0 || width > 32768 || height > 32768)
        {
            return Err(Rejection::Invalid);
        }
        self.seen.insert(envelope.request_id);
        Ok(envelope.message)
    }
    pub fn publish(&mut self, scope: &AssetScope, bytes: Arc<[u8]>) -> Result<String, Rejection> {
        if !self.active {
            return Err(Rejection::Closed);
        }
        if scope.document() != &self.binding.document || scope.revision() != self.binding.revision {
            return Err(Rejection::Stale);
        }
        if self.resources.len() >= 16
            || bytes.is_empty()
            || self.resource_bytes + bytes.len() > 8 * 1024 * 1024
        {
            return Err(Rejection::Resource);
        }
        crate::image::codec::inspect(&bytes).map_err(|_| Rejection::Resource)?;
        let mime = match image::guess_format(&bytes) {
            Ok(image::ImageFormat::Png) => "image/png",
            Ok(image::ImageFormat::Jpeg) => "image/jpeg",
            Ok(image::ImageFormat::WebP) => "image/webp",
            _ => return Err(Rejection::Resource),
        };
        let token = Uuid::new_v4();
        self.resource_bytes += bytes.len();
        self.resources.insert(token, Resource { bytes, mime });
        Ok(format!("{}/resource/{token}", self.origin))
    }
    pub fn resource(
        &mut self,
        url: &str,
        range: Option<&str>,
        now: Instant,
    ) -> Result<ResourceChunk, Rejection> {
        if !self.active {
            return Err(Rejection::Closed);
        }
        self.rate(now)?;
        let token = url
            .strip_prefix(&format!("{}/resource/", self.origin))
            .and_then(|s| Uuid::parse_str(s).ok())
            .ok_or(Rejection::Resource)?;
        let resource = self.resources.get(&token).ok_or(Rejection::Resource)?;
        let span = byte_range(range, resource.bytes.len())?;
        Ok((
            resource.bytes[span.clone()].to_vec(),
            resource.mime,
            span,
            resource.bytes.len(),
        ))
    }
    pub fn close(&mut self) {
        self.active = false;
        self.resources.clear();
        self.resource_bytes = 0;
        self.seen.clear();
    }
}
pub fn byte_range(
    header: Option<&str>,
    length: usize,
) -> Result<std::ops::Range<usize>, Rejection> {
    byte_range_with_limit(header, length, MAX_RANGE)
}

pub(crate) fn byte_range_with_limit(
    header: Option<&str>,
    length: usize,
    limit: usize,
) -> Result<std::ops::Range<usize>, Rejection> {
    if length == 0 {
        return Err(Rejection::Range);
    }
    let span = if let Some(value) = header {
        let (start, end) = value
            .strip_prefix("bytes=")
            .and_then(|s| s.split_once('-'))
            .ok_or(Rejection::Range)?;
        if start.is_empty() {
            let suffix: usize = end.parse().map_err(|_| Rejection::Range)?;
            if suffix == 0 {
                return Err(Rejection::Range);
            }
            length.saturating_sub(suffix)..length
        } else {
            let start: usize = start.parse().map_err(|_| Rejection::Range)?;
            let end = if end.is_empty() {
                length
            } else {
                end.parse::<usize>()
                    .ok()
                    .and_then(|v| v.checked_add(1))
                    .ok_or(Rejection::Range)?
                    .min(length)
            };
            start..end
        }
    } else {
        0..length
    };
    if span.start >= span.end || span.end > length || span.len() > limit {
        return Err(Rejection::Range);
    }
    Ok(span)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn session() -> LocalSession {
        LocalSession::new(Binding::new(
            DocumentId::new(Uuid::new_v4(), Uuid::new_v4()),
            Uuid::new_v4(),
        ))
    }
    fn message(s: &LocalSession) -> serde_json::Value {
        let mut v: serde_json::Value = serde_json::from_str(&s.bootstrap()).unwrap();
        v.as_object_mut().unwrap().remove("resources");
        v.as_object_mut().unwrap().remove("renderId");
        v["requestId"] = Uuid::new_v4().to_string().into();
        v["message"] = serde_json::json!({"kind":"ready"});
        v
    }
    #[test]
    fn bridge_rejects_forgery_replay_stale_and_large_messages() {
        let mut s = session();
        let now = Instant::now();
        let origin = s.page_url();
        let msg = message(&s);
        assert_eq!(
            s.accept("https://evil.test/", &msg.to_string(), now),
            Err(Rejection::Origin)
        );
        let mut forged = msg.clone();
        forged["token"] = Uuid::new_v4().to_string().into();
        assert_eq!(
            s.accept(&origin, &forged.to_string(), now),
            Err(Rejection::Token)
        );
        forged = msg.clone();
        forged["binding"]["revision"] = Uuid::new_v4().to_string().into();
        assert_eq!(
            s.accept(&origin, &forged.to_string(), now),
            Err(Rejection::Stale)
        );
        forged = msg.clone();
        forged["message"] = serde_json::json!({"kind":"run","payload":"sql"});
        assert_eq!(
            s.accept(&origin, &forged.to_string(), now),
            Err(Rejection::Invalid)
        );
        assert_eq!(
            s.accept(&origin, &"x".repeat(MAX_MESSAGE + 1), now),
            Err(Rejection::Oversize)
        );
        assert_eq!(s.accept(&origin, &msg.to_string(), now), Ok(Message::Ready));
        assert_eq!(
            s.accept(&origin, &msg.to_string(), now),
            Err(Rejection::Duplicate)
        );
        s.close();
        assert_eq!(
            s.accept(&origin, &msg.to_string(), now),
            Err(Rejection::Closed)
        );
    }
    #[test]
    fn range_boundaries_and_revocation() {
        assert_eq!(byte_range(Some("bytes=3-6"), 10), Ok(3..7));
        assert_eq!(byte_range(Some("bytes=-3"), 10), Ok(7..10));
        assert_eq!(byte_range(Some("bytes=7-"), 10), Ok(7..10));
        for range in [
            "bytes=10-",
            "bytes=7-4",
            "bytes=-0",
            "bytes=0-1,3-4",
            "bytes=0-18446744073709551615",
        ] {
            assert!(byte_range(Some(range), 10).is_err());
        }
        assert!(byte_range(None, MAX_RANGE + 1).is_err());
        let mut s = session();
        let scope = AssetScope::new(
            s.binding.document.clone(),
            s.binding.revision,
            Uuid::new_v4(),
        );
        let url = s
            .publish(
                &scope,
                Arc::from(
                    &include_bytes!(
                        "../../../../tests/fixtures/rust-migration/corpus/media/pixel.png"
                    )[..],
                ),
            )
            .unwrap();
        assert!(s.resource(&url, Some("bytes=0-7"), Instant::now()).is_ok());
        s.close();
        assert_eq!(
            s.resource(&url, None, Instant::now()).unwrap_err(),
            Rejection::Closed
        );
    }
    #[test]
    fn repeated_close_and_rate_limit() {
        for _ in 0..100 {
            let mut s = session();
            s.close();
            s.close();
            assert!(!s.active);
        }
        let mut s = session();
        let now = Instant::now();
        for _ in 0..120 {
            let msg = message(&s);
            assert!(s.accept(&s.page_url(), &msg.to_string(), now).is_ok());
        }
        let msg = message(&s);
        assert_eq!(
            s.accept(&s.page_url(), &msg.to_string(), now),
            Err(Rejection::Rate)
        );
    }
}
