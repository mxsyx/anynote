use super::*;
use crate::config_migration::credentials::SecretStore;
use anynote_storage::runtime_state::RuntimeState;
use reqwest::{Method, header};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use url::Url;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryConnection {
    pub id: String,
    pub name: String,
    pub endpoint: String,
    pub allow_insecure: bool,
}
impl RecoveryConnection {
    pub fn validate(&self) -> CloudResult<()> {
        ensure(
            valid_uuid(&self.id) && !self.name.trim().is_empty() && self.name.len() <= 480,
            "CONNECTION_IDENTITY",
        )?;
        endpoint(&self.endpoint, self.allow_insecure)?;
        Ok(())
    }
}
fn endpoint(raw: &str, insecure: bool) -> CloudResult<Url> {
    let url = Url::parse(raw).map_err(|_| CloudError::new("ENDPOINT"))?;
    ensure(
        raw.len() <= 1000
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && (url.scheme() == "https" || (url.scheme() == "http" && insecure)),
        "ENDPOINT",
    )?;
    Ok(url)
}
const CONNECTIONS: &str = "cloud.recovery.connections";
pub fn recovery_connections(state: &RuntimeState) -> CloudResult<Vec<RecoveryConnection>> {
    let rows: Vec<RecoveryConnection> = state
        .read(CONNECTIONS)?
        .map(|v| serde_json::from_slice(&v))
        .transpose()?
        .unwrap_or_default();
    ensure(rows.len() <= 20, "CONNECTION_LIMIT")?;
    let mut ids = std::collections::BTreeSet::new();
    for row in &rows {
        row.validate()?;
        ensure(ids.insert(&row.id), "CONNECTION_IDENTITY")?;
    }
    Ok(rows)
}
pub fn save_recovery_connection(
    state: &RuntimeState,
    vault: &dyn SecretStore,
    connection: RecoveryConnection,
    token: &str,
) -> CloudResult<()> {
    connection.validate()?;
    validate_token(token)?;
    let mut rows = recovery_connections(state)?;
    // Connection identity is immutable; changing endpoint creates a new ID and transfer slot.
    ensure(
        rows.len() < 20 && rows.iter().all(|r| r.id != connection.id),
        "CONNECTION_LIMIT_OR_DUPLICATE",
    )?;
    vault.write(
        &connection.id,
        &serde_json::to_vec(&json!({"token":token}))?,
    )?;
    rows.push(connection);
    state.write(CONNECTIONS, &serde_json::to_vec(&rows)?)?;
    Ok(())
}
fn validate_token(token: &str) -> CloudResult<()> {
    ensure(
        !token.is_empty() && token.len() <= 3000 && token.bytes().all(|b| (33..=126).contains(&b)),
        "TOKEN",
    )
}
#[derive(Clone)]
pub struct CloudClient {
    pub(crate) connection: RecoveryConnection,
    http: reqwest::Client,
    authorization: header::HeaderValue,
}
impl CloudClient {
    pub fn from_vault(
        connection: RecoveryConnection,
        vault: &dyn SecretStore,
    ) -> CloudResult<Self> {
        let bytes = vault
            .read(&connection.id)?
            .ok_or_else(|| CloudError::new("CREDENTIAL_UNAVAILABLE"))?;
        let mut value: Value = serde_json::from_slice(&bytes)?;
        let token = zeroize::Zeroizing::new(
            value["token"]
                .take()
                .as_str()
                .ok_or_else(|| CloudError::new("TOKEN"))?
                .to_owned(),
        );
        Self::new(connection, &token)
    }
    pub fn new(connection: RecoveryConnection, token: &str) -> CloudResult<Self> {
        connection.validate()?;
        validate_token(token)?;
        let mut authorization = header::HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| CloudError::new("TOKEN"))?;
        authorization.set_sensitive(true);
        Ok(Self {
            connection,
            authorization,
            http: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .referer(false)
                .connect_timeout(Duration::from_secs(30))
                .build()?,
        })
    }
    pub async fn test(&self, cancel: &CancellationToken) -> CloudResult<Capabilities> {
        let value = self
            .json(Method::GET, "/v1/capabilities", None, cancel)
            .await?;
        let caps: Capabilities = serde_json::from_value(value)?;
        ensure(
            caps.protocol_version == 1
                && caps.schema_versions.contains(&5)
                && caps.has("sqlite-assets-v1")
                && caps.has("conditional-head"),
            "UNSUPPORTED_CAPABILITIES",
        )?;
        Ok(caps)
    }
    pub async fn discover(
        &self,
        cursor: Option<&str>,
        cancel: &CancellationToken,
    ) -> CloudResult<DiscoveryPage> {
        ensure(
            self.test(cancel).await?.has("backup-discovery-v1"),
            "DISCOVERY_UNSUPPORTED",
        )?;
        let path = if let Some(cursor) = cursor {
            ensure(cursor.len() <= 1000, "DISCOVERY_CURSOR")?;
            format!(
                "/v1/backups?{}",
                url::form_urlencoded::Serializer::new(String::new())
                    .append_pair("cursor", cursor)
                    .finish()
            )
        } else {
            "/v1/backups".into()
        };
        let page: DiscoveryPage =
            serde_json::from_value(self.json(Method::GET, &path, None, cancel).await?)?;
        ensure(
            page.backups.len() <= 10
                && page
                    .cursor
                    .as_ref()
                    .is_none_or(|s| s.len() <= 1000 && Some(s.as_str()) != cursor),
            "DISCOVERY_PAGE",
        )?;
        for b in &page.backups {
            ensure(
                [&b.id, &b.notebook_id, &b.lineage_id]
                    .iter()
                    .all(|s| valid_uuid(s))
                    && b.snapshot_seq <= JS_SAFE
                    && b.database_bytes <= anynote_storage::notebook::SNAPSHOT_BYTES,
                "DISCOVERY_IDENTITY",
            )?;
        }
        Ok(page)
    }
    pub(crate) async fn json(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        cancel: &CancellationToken,
    ) -> CloudResult<Value> {
        let body = body
            .map(|v| stringify(&v).map(String::into_bytes))
            .transpose()?;
        self.json_bytes(method, path, body, cancel).await
    }
    pub(crate) async fn json_bytes(
        &self,
        method: Method,
        path: &str,
        body: Option<Vec<u8>>,
        cancel: &CancellationToken,
    ) -> CloudResult<Value> {
        let (_, _, bytes) = self
            .request(method, path, body, None, MANIFEST_BYTES, cancel)
            .await?;
        Ok(serde_json::from_slice(&bytes)?)
    }
    pub(crate) async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Vec<u8>>,
        range: Option<(u64, u64, u64)>,
        limit: usize,
        cancel: &CancellationToken,
    ) -> CloudResult<(u16, header::HeaderMap, Vec<u8>)> {
        ensure(
            path.starts_with("/v1/") && !path.contains('#'),
            "REQUEST_PATH",
        )?;
        check(cancel)?;
        let url = format!("{}{}", self.connection.endpoint.trim_end_matches('/'), path);
        let mut req = self
            .http
            .request(method, url)
            .header(header::AUTHORIZATION, self.authorization.clone());
        if let Some(body) = body {
            req = req
                .header(header::CONTENT_TYPE, "application/json")
                .body(body);
        }
        if let Some((offset, size, _)) = range {
            req = req.header(
                header::RANGE,
                format!("bytes={offset}-{}", offset + size - 1),
            );
        }
        let future = async {
            let mut response = req.send().await?;
            let status = response.status().as_u16();
            let headers = response.headers().clone();
            let success = response.status().is_success();
            let max = if success { limit } else { 65536 };
            ensure(
                response.content_length().is_none_or(|n| n <= max as u64),
                "RESPONSE_BUDGET",
            )?;
            if let Some((offset, size, total)) = range
                && success
            {
                ensure(
                    status == 206
                        && headers
                            .get(header::CONTENT_RANGE)
                            .and_then(|v| v.to_str().ok())
                            == Some(
                                format!("bytes {offset}-{}/{total}", offset + size - 1).as_str(),
                            ),
                    "CONTENT_RANGE",
                )?;
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await? {
                ensure(bytes.len() + chunk.len() <= max, "RESPONSE_BUDGET")?;
                bytes.extend_from_slice(&chunk);
            }
            if !success {
                let raw = serde_json::from_slice::<Value>(&bytes)
                    .ok()
                    .and_then(|v| v["error"].as_str().map(str::to_owned));
                // Only known protocol codes enter diagnostics; never echo an untrusted response/token.
                let code = raw
                    .as_deref()
                    .and_then(protocol_error_code)
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("HTTP_{status}"));
                return Err(CloudError {
                    code,
                    status: Some(status),
                    retry_after_ms: headers
                        .get(header::RETRY_AFTER)
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| retry_after(v, now_ms())),
                });
            }
            Ok((status, headers, bytes))
        };
        let seconds = if path.contains("/multipart/") {
            30 * 60
        } else {
            60
        };
        tokio::select! { biased; _ = cancel.cancelled() => Err(CloudError::new("CANCELLED")), result = tokio::time::timeout(Duration::from_secs(seconds), future) => result.map_err(|_| CloudError::new("NETWORK_TIMEOUT"))? }
    }
}
pub fn retry_after(value: &str, now: u64) -> Option<u64> {
    let value = value.trim();
    if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) {
        return Some(
            value
                .parse::<u64>()
                .unwrap_or(u64::MAX)
                .saturating_mul(1000)
                .min(86_400_000),
        );
    }
    chrono::DateTime::parse_from_rfc2822(value).ok().map(|d| {
        (d.timestamp_millis().max(0) as u64)
            .saturating_sub(now)
            .min(86_400_000)
    })
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub protocol_version: u64,
    pub schema_versions: Vec<u64>,
    pub capabilities: Vec<String>,
}
impl Capabilities {
    pub fn has(&self, value: &str) -> bool {
        self.capabilities.iter().any(|v| v == value)
    }
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredBackup {
    pub id: String,
    pub notebook_id: String,
    pub lineage_id: String,
    pub name: String,
    pub created_at: String,
    pub snapshot_seq: u64,
    pub database_bytes: u64,
}
#[derive(Debug, Deserialize, Serialize)]
pub struct DiscoveryPage {
    pub backups: Vec<DiscoveredBackup>,
    pub warnings: Vec<String>,
    pub cursor: Option<String>,
}

fn protocol_error_code(raw: &str) -> Option<&'static str> {
    Some(match raw {
        "WRITER_REVOKED" => "WRITER_REVOKED",
        "WRITER_REVOKED_OR_MAINTENANCE" => "WRITER_REVOKED_OR_MAINTENANCE",
        "HEAD_CONFLICT_OR_MAINTENANCE" => "HEAD_CONFLICT_OR_MAINTENANCE",
        "MAINTENANCE_IN_PROGRESS" => "MAINTENANCE_IN_PROGRESS",
        "GENERATION_RETIRED" => "GENERATION_RETIRED",
        "IDEMPOTENCY_CONFLICT" => "IDEMPOTENCY_CONFLICT",
        "HEAD_CONFLICT" => "HEAD_CONFLICT",
        "ASSET_MISSING" => "ASSET_MISSING",
        "UPLOAD_SESSION_MISSING" => "UPLOAD_SESSION_MISSING",
        "CLEANUP_BUSY" => "CLEANUP_BUSY",
        "LEGACY_LOCK_CHANGED" => "LEGACY_LOCK_CHANGED",
        "PLAN_CHANGED" | "清理候选或保护引用发生变化，请重新预览" | "规划期间版本发生变化" => {
            "PLAN_CHANGED"
        }
        "清理计划已过期，请重新预览" => "PLAN_EXPIRED",
        "清理计划不存在" => "PLAN_MISSING",
        "清理状态不匹配" => "MAINTENANCE_STATE_CHANGED",
        "对象在清理期间发生变化" => "MAINTENANCE_OBJECT_CHANGED",
        "保护版本身份缺失，拒绝清理" => "PROTECTED_GENERATION_MISSING",
        "保护版本的 manifest 缺失" | "保护版本的 manifest 校验失败" => {
            "PROTECTED_MANIFEST_INVALID"
        }
        _ => return None,
    })
}
