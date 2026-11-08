use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const MIB: u64 = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct ImportBudget {
    pub concurrency: usize,
    pub response_bytes: u64,
    pub response_ms: u64,
    pub html_bytes: u64,
    pub media_bytes: u64,
    pub total_bytes: u64,
    pub media_count: usize,
    pub decode_bytes: u64,
}
impl Default for ImportBudget {
    fn default() -> Self {
        Self {
            concurrency: 4,
            response_bytes: 20 * MIB,
            response_ms: 30_000,
            html_bytes: 10 * MIB,
            media_bytes: 20 * MIB,
            total_bytes: 80 * MIB,
            media_count: 200,
            decode_bytes: 160_000_000,
        }
    }
}
impl ImportBudget {
    pub fn valid(&self) -> bool {
        let d = Self::default();
        [
            (self.concurrency as u64, d.concurrency as u64),
            (self.response_bytes, d.response_bytes),
            (self.response_ms, d.response_ms),
            (self.html_bytes, d.html_bytes),
            (self.media_bytes, d.media_bytes),
            (self.total_bytes, d.total_bytes),
            (self.media_count as u64, d.media_count as u64),
            (self.decode_bytes, d.decode_bytes),
        ]
        .iter()
        .all(|(v, max)| *v > 0 && v <= max)
    }
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    #[default]
    Image,
    Video,
    Audio,
    Attachment,
    Embed,
    Unsupported,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaStatus {
    Localized,
    Failed,
    Skipped,
    External,
    #[serde(rename = "linked")]
    Linked,
    Unsupported,
    Embedded,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportMedia {
    pub source: String,
    pub status: MediaStatus,
    #[serde(default)]
    pub kind: MediaKind,
    #[serde(default)]
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub retry_count: u32,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}
impl ImportMedia {
    pub fn pending(source: String, name: String, kind: MediaKind) -> Self {
        Self {
            source,
            name,
            kind,
            status: MediaStatus::Failed,
            resource_id: None,
            marker: None,
            placeholder: None,
            error: None,
            retry_count: 0,
            extra: BTreeMap::new(),
        }
    }
    pub fn reference(&self, id: &str) -> String {
        let name: String = self
            .name
            .chars()
            .filter(|c| !"[]\\\r\n".contains(*c))
            .collect();
        format!(
            "{}[{}](anynote-resource:{id})",
            if self.kind == MediaKind::Image {
                "!"
            } else {
                ""
            },
            name
        )
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginalHtml {
    pub resource_id: String,
    pub name: String,
    pub size: u64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub budget: ImportBudget,
    pub source: Option<String>,
    pub final_url: Option<String>,
    pub fetched_at: u64,
    pub created_at: u64,
    pub mode: String,
    pub fallback: bool,
    pub keep_original: bool,
    pub original_html: Option<OriginalHtml>,
    pub media: Vec<ImportMedia>,
    pub localized: usize,
    pub failed: usize,
    pub bytes: u64,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}
impl ImportReport {
    pub fn recount(&mut self) {
        self.localized = self
            .media
            .iter()
            .filter(|m| m.status == MediaStatus::Localized)
            .count();
        self.failed = self
            .media
            .iter()
            .filter(|m| m.status == MediaStatus::Failed)
            .count();
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CaptureReceipt {
    pub capture_id: String,
    pub digest: String,
}
