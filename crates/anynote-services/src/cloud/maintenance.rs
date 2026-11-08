//! Explicit remote maintenance over the retained Worker protocol. The Worker owns
//! calendar sampling, protection/CAS checks, tombstones and deletion cursors.
use super::*;
use anynote_storage::runtime_state::RuntimeState;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalendarRetention {
    pub daily_days: u16,
    pub weekly_weeks: u16,
    pub monthly_months: u16,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetentionPolicy {
    pub keep: u16,
    pub calendar: CalendarRetention,
}
impl Default for RetentionPolicy {
    fn default() -> Self {
        Self {
            keep: 30,
            calendar: CalendarRetention::default(),
        }
    }
}
impl RetentionPolicy {
    pub fn validate(&self) -> CloudResult<()> {
        ensure(
            (1..=1000).contains(&self.keep)
                && self.calendar.daily_days <= 365
                && self.calendar.weekly_weeks <= 104
                && self.calendar.monthly_months <= 120,
            "RETENTION_POLICY",
        )
    }
}
fn policy_key(target: &str) -> CloudResult<String> {
    ensure(valid_uuid(target), "TARGET_IDENTITY")?;
    Ok(format!("cloud.retention.{target}"))
}
/// Saving a preference grants no deletion permission and requires no network/credential.
pub fn save_remote_retention(
    store: &RuntimeState,
    target: &str,
    policy: &RetentionPolicy,
) -> CloudResult<()> {
    policy.validate()?;
    store.write(&policy_key(target)?, &serde_json::to_vec(policy)?)?;
    Ok(())
}
pub fn remote_retention_policy(store: &RuntimeState, target: &str) -> CloudResult<RetentionPolicy> {
    let policy: RetentionPolicy = store
        .read(&policy_key(target)?)?
        .map(|b| serde_json::from_slice(&b))
        .transpose()?
        .unwrap_or_default();
    policy.validate()?;
    Ok(policy)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWriter {
    pub head: String,
    pub device_id: String,
    pub writer_epoch: u64,
    pub lineage_id: String,
}
impl RemoteWriter {
    pub fn owns(&self, identity: &TransferIdentity) -> bool {
        identity.lineage_id == self.lineage_id
            && identity
                .writer
                .as_ref()
                .is_some_and(|w| w.device_id == self.device_id && w.epoch == self.writer_epoch)
    }
    fn validate(&self, lineage: &str) -> CloudResult<()> {
        ensure(
            self.lineage_id == lineage
                && valid_uuid(&self.device_id)
                && (self.head.is_empty() || valid_uuid(&self.head))
                && (1..=JS_SAFE).contains(&self.writer_epoch),
            "WRITER_RESPONSE",
        )
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TakeoverRequest {
    pub request_id: String,
    pub expected_head: String,
    pub expected_writer_epoch: u64,
}
impl TakeoverRequest {
    fn validate(&self) -> CloudResult<()> {
        ensure(
            valid_uuid(&self.request_id)
                && (self.expected_head.is_empty() || valid_uuid(&self.expected_head))
                && (1..JS_SAFE).contains(&self.expected_writer_epoch),
            "TAKEOVER_REQUEST",
        )
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeoverOutcome {
    pub identity: TransferIdentity,
    pub cursor: CloudCursor,
    pub auto_backup: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TakeoverJournal {
    request: TakeoverRequest,
    rejected: bool,
}
const TAKEOVER: &str = "maintenance.takeover";
/// Returns the exact confirmed request to reconcile after a process restart.
pub fn pending_takeover(session: &TransferSession) -> CloudResult<Option<TakeoverRequest>> {
    let journal = session.read::<TakeoverJournal>(TAKEOVER)?;
    if let Some(journal) = &journal {
        journal.request.validate()?;
    }
    Ok(journal.filter(|j| !j.rejected).map(|j| j.request))
}
pub async fn resume_takeover(
    client: &CloudClient,
    session: &mut TransferSession,
    cancel: &CancellationToken,
) -> CloudResult<TakeoverOutcome> {
    let request =
        pending_takeover(session)?.ok_or_else(|| CloudError::new("TAKEOVER_NOT_CONFIRMED"))?;
    takeover_writer(client, session, &request, true, cancel).await
}
pub(crate) fn upload_allowed(session: &TransferSession) -> CloudResult<()> {
    ensure(
        session
            .read::<TakeoverJournal>(TAKEOVER)?
            .is_none_or(|j| j.rejected),
        "WRITER_REBIND_REQUIRED",
    )
}
fn base(session: &TransferSession) -> String {
    format!("/v1/notebooks/{}", session.identity().notebook_id)
}
async fn capabilities(
    client: &CloudClient,
    session: &TransferSession,
    required: &[&str],
    cancel: &CancellationToken,
) -> CloudResult<()> {
    session.bind(client, Direction::Upload)?;
    let caps = client.test(cancel).await?;
    ensure(
        required.iter().all(|s| caps.has(s)),
        "MAINTENANCE_UNSUPPORTED",
    )
}
pub async fn remote_writer(
    client: &CloudClient,
    session: &TransferSession,
    cancel: &CancellationToken,
) -> CloudResult<RemoteWriter> {
    capabilities(client, session, &["writer-takeover"], cancel).await?;
    let writer: RemoteWriter = serde_json::from_value(
        client
            .json(
                Method::GET,
                &format!(
                    "{}/writer?lineageId={}",
                    base(session),
                    session.identity().lineage_id
                ),
                None,
                cancel,
            )
            .await?,
    )?;
    writer.validate(&session.identity().lineage_id)?;
    Ok(writer)
}
/// The request ID and CAS inputs survive lost responses. A pending or successful
/// takeover fences this old upload slot; the returned new slot starts without an ack.
pub async fn takeover_writer(
    client: &CloudClient,
    session: &mut TransferSession,
    request: &TakeoverRequest,
    confirmed: bool,
    cancel: &CancellationToken,
) -> CloudResult<TakeoverOutcome> {
    ensure(confirmed, "CONFIRMATION_REQUIRED")?;
    request.validate()?;
    if let Some(prior) = session.read::<TakeoverJournal>(TAKEOVER)? {
        ensure(
            prior.rejected || prior.request == *request,
            "TAKEOVER_PENDING",
        )?;
    }
    capabilities(client, session, &["writer-takeover"], cancel).await?;
    let identity = session.identity().clone();
    let writer = identity
        .writer
        .as_ref()
        .ok_or_else(|| CloudError::new("TRANSFER_WRITER"))?;
    ensure(
        request.expected_writer_epoch >= writer.epoch,
        "TAKEOVER_REQUEST",
    )?;
    let journal = TakeoverJournal {
        request: request.clone(),
        rejected: false,
    };
    session.write(TAKEOVER, &journal)?;
    let response = client
        .json(
            Method::POST,
            &format!("{}/writer/takeover", base(session)),
            Some(json!({
                "lineageId": identity.lineage_id, "deviceId": writer.device_id,
                "requestId": request.request_id, "expectedHead": request.expected_head,
                "expectedWriterEpoch": request.expected_writer_epoch, "confirmed": true,
            })),
            cancel,
        )
        .await;
    let response = match response {
        Ok(value) => value,
        Err(e) => {
            // Only a definite CAS rejection permits replacing the request. Network,
            // cancellation and revoked receipts can hide an already successful claim.
            if e.code == "HEAD_CONFLICT_OR_MAINTENANCE" {
                session.write(
                    TAKEOVER,
                    &TakeoverJournal {
                        rejected: true,
                        ..journal
                    },
                )?;
            }
            return Err(e);
        }
    };
    let current = RemoteWriter {
        head: response["head"]
            .as_str()
            .ok_or_else(|| CloudError::new("WRITER_RESPONSE"))?
            .into(),
        device_id: writer.device_id.clone(),
        writer_epoch: response["writerEpoch"]
            .as_u64()
            .ok_or_else(|| CloudError::new("WRITER_RESPONSE"))?,
        lineage_id: response["lineageId"]
            .as_str()
            .ok_or_else(|| CloudError::new("WRITER_RESPONSE"))?
            .into(),
    };
    current.validate(&identity.lineage_id)?;
    ensure(
        current.writer_epoch == request.expected_writer_epoch + 1,
        "WRITER_RESPONSE",
    )?;
    let next_identity = TransferIdentity {
        writer: Some(WriterIdentity {
            device_id: current.device_id,
            epoch: current.writer_epoch,
        }),
        ..identity
    };
    let next = TransferSession::open(&session.state_root, next_identity.clone())?;
    if next.read::<CloudCursor>("upload.cursor")?.is_none() {
        next.write(
            "upload.cursor",
            &CloudCursor {
                last_generation: current.head,
                ..Default::default()
            },
        )?;
    }
    Ok(TakeoverOutcome {
        identity: next_identity,
        cursor: next.cursor()?,
        auto_backup: false,
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionVersion {
    pub id: String,
    pub created_at: String,
    pub status: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionSample {
    pub id: String,
    pub reasons: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionSpace {
    pub total_bytes: u64,
    pub retained_bytes: u64,
    pub reclaim_bytes: u64,
    pub deferred_objects: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionPreview {
    pub id: String,
    pub keep: u16,
    pub calendar: CalendarRetention,
    pub reference_time: String,
    pub sampled: Vec<RetentionSample>,
    pub remove: Vec<RetentionVersion>,
    pub protected: Vec<String>,
    pub staging: u64,
    pub expired_staging: u64,
    pub abandoned_uploads: u64,
    pub reclaim_bytes: u64,
    pub space: RetentionSpace,
    pub grace_hours: u64,
}
impl RetentionPreview {
    fn validate(&self) -> CloudResult<()> {
        RetentionPolicy {
            keep: self.keep,
            calendar: self.calendar.clone(),
        }
        .validate()?;
        ensure(
            valid_uuid(&self.id)
                && self.remove.len() <= 2000
                && self.protected.len() <= 2000
                && self.sampled.len() <= 2000
                && self.remove.iter().all(|v| valid_uuid(&v.id))
                && self.protected.iter().all(|id| valid_uuid(id))
                && self.remove.iter().all(|v| !self.protected.contains(&v.id))
                && self.space.total_bytes <= JS_SAFE
                && self.reclaim_bytes == self.space.reclaim_bytes
                && self.space.retained_bytes.checked_add(self.reclaim_bytes)
                    == Some(self.space.total_bytes),
            "RETENTION_RESPONSE",
        )
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RetentionPhase {
    Planned,
    Confirmed,
    Completed,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionOperation {
    pub plan_id: String,
    pub phase: RetentionPhase,
}
const RETENTION: &str = "maintenance.retention";
pub fn pending_retention(session: &TransferSession) -> CloudResult<Option<RetentionOperation>> {
    let saved = session.read::<RetentionOperation>(RETENTION)?;
    if let Some(saved) = &saved {
        ensure(valid_uuid(&saved.plan_id), "PLAN_IDENTITY")?;
    }
    Ok(saved)
}
pub async fn preview_retention(
    client: &CloudClient,
    session: &mut TransferSession,
    policy: &RetentionPolicy,
    cancel: &CancellationToken,
) -> CloudResult<RetentionPreview> {
    policy.validate()?;
    ensure(
        pending_retention(session)?.is_none_or(|s| s.phase != RetentionPhase::Confirmed),
        "RETENTION_UNRESOLVED",
    )?;
    upload_allowed(session)?;
    capabilities(
        client,
        session,
        &["retention-gc", "maintenance-lifecycle-v1"],
        cancel,
    )
    .await?;
    if policy.calendar != CalendarRetention::default() {
        ensure(
            client.test(cancel).await?.has("calendar-retention"),
            "CALENDAR_UNSUPPORTED",
        )?;
    }
    let writer = session.identity().writer.as_ref().unwrap();
    let preview: RetentionPreview = serde_json::from_value(client.json(Method::POST, &format!("{}/retention/plan", base(session)), Some(json!({
        "lineageId":session.identity().lineage_id,"deviceId":writer.device_id,"writerEpoch":writer.epoch,
        "keep":policy.keep,"calendar":policy.calendar,
    })), cancel).await?)?;
    preview.validate()?;
    ensure(
        preview.keep == policy.keep && preview.calendar == policy.calendar,
        "RETENTION_RESPONSE",
    )?;
    session.write(
        RETENTION,
        &RetentionOperation {
            plan_id: preview.id.clone(),
            phase: RetentionPhase::Planned,
        },
    )?;
    Ok(preview)
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionProgress {
    pub completed: bool,
    pub plan_id: String,
    pub processed_objects: Option<u64>,
    pub processed_generations: Option<u64>,
    pub archiving: Option<bool>,
    pub removed: Option<u64>,
    pub reclaimed_bytes: Option<u64>,
}
/// One bounded server batch. Retrying after cancellation/lost responses uses the
/// same confirmed plan; the coordinator can also finish it while the client exits.
pub async fn apply_retention(
    client: &CloudClient,
    session: &mut TransferSession,
    plan_id: &str,
    confirmed: bool,
    cancel: &CancellationToken,
) -> CloudResult<RetentionProgress> {
    ensure(confirmed, "CONFIRMATION_REQUIRED")?;
    let mut operation =
        pending_retention(session)?.ok_or_else(|| CloudError::new("PLAN_NOT_PREVIEWED"))?;
    ensure(operation.plan_id == plan_id, "PLAN_IDENTITY")?;
    capabilities(
        client,
        session,
        &["retention-gc", "maintenance-lifecycle-v1"],
        cancel,
    )
    .await?;
    operation.phase = RetentionPhase::Confirmed;
    session.write(RETENTION, &operation)?;
    let writer = session.identity().writer.as_ref().unwrap();
    let response = client.json(Method::POST, &format!("{}/retention/apply", base(session)), Some(json!({
        "planId":plan_id,"deviceId":writer.device_id,"writerEpoch":writer.epoch,"confirmed":true,
    })), cancel).await;
    let response = match response {
        Ok(value) => value,
        Err(e) => {
            if [
                "PLAN_CHANGED",
                "PLAN_EXPIRED",
                "PLAN_MISSING",
                "WRITER_REVOKED",
            ]
            .contains(&e.code.as_str())
            {
                // These codes reject admission before deletion. A fresh preview is safe.
                operation.phase = RetentionPhase::Planned;
                session.write(RETENTION, &operation)?;
            }
            return Err(e);
        }
    };
    let progress: RetentionProgress = serde_json::from_value(response)?;
    ensure(progress.plan_id == plan_id, "PLAN_IDENTITY")?;
    if progress.completed {
        operation.phase = RetentionPhase::Completed;
        session.write(RETENTION, &operation)?;
    }
    Ok(progress)
}
pub async fn resume_retention(
    client: &CloudClient,
    session: &mut TransferSession,
    cancel: &CancellationToken,
) -> CloudResult<RetentionProgress> {
    let saved = pending_retention(session)?.ok_or_else(|| CloudError::new("PLAN_NOT_CONFIRMED"))?;
    ensure(saved.phase != RetentionPhase::Planned, "PLAN_NOT_CONFIRMED")?;
    apply_retention(client, session, &saved.plan_id, true, cancel).await
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveRetention {
    pub id: String,
    pub lineage_id: String,
    pub status: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRetentionState {
    pub active_plan: Option<ActiveRetention>,
}
pub async fn remote_retention_state(
    client: &CloudClient,
    session: &TransferSession,
    cancel: &CancellationToken,
) -> CloudResult<RemoteRetentionState> {
    capabilities(client, session, &["maintenance-lifecycle-v1"], cancel).await?;
    let state: RemoteRetentionState = serde_json::from_value(
        client
            .json(
                Method::GET,
                &format!("{}/retention/state", base(session)),
                None,
                cancel,
            )
            .await?,
    )?;
    if let Some(plan) = &state.active_plan {
        ensure(
            valid_uuid(&plan.id) && valid_uuid(&plan.lineage_id) && plan.status == "deleting",
            "RETENTION_STATE",
        )?;
    }
    Ok(state)
}
/// Recover a confirmed server plan when this device has no local receipt. Never
/// adopts a mere preview or a different branch, and never overrides an unresolved plan.
pub async fn recover_retention(
    client: &CloudClient,
    session: &mut TransferSession,
    plan_id: &str,
    confirmed: bool,
    cancel: &CancellationToken,
) -> CloudResult<RetentionProgress> {
    ensure(confirmed, "CONFIRMATION_REQUIRED")?;
    let state = remote_retention_state(client, session, cancel).await?;
    let plan = state
        .active_plan
        .ok_or_else(|| CloudError::new("NO_ACTIVE_MAINTENANCE"))?;
    ensure(
        plan.id == plan_id && plan.lineage_id == session.identity().lineage_id,
        "PLAN_IDENTITY",
    )?;
    ensure(
        pending_retention(session)?
            .is_none_or(|s| s.phase != RetentionPhase::Confirmed || s.plan_id == plan_id),
        "RETENTION_UNRESOLVED",
    )?;
    session.write(
        RETENTION,
        &RetentionOperation {
            plan_id: plan_id.into(),
            phase: RetentionPhase::Confirmed,
        },
    )?;
    resume_retention(client, session, cancel).await
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceExecution {
    pub id: String,
    pub status: String,
    pub execution_id: Option<String>,
    pub execution_owner: Option<String>,
    pub object_cursor: u64,
    pub generation_cursor: u64,
    pub created_at: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceDiagnostics {
    pub notebook_locked: bool,
    pub plan: Option<MaintenanceExecution>,
    pub legacy_lock: bool,
}
pub async fn maintenance_diagnostics(
    client: &CloudClient,
    session: &TransferSession,
    cancel: &CancellationToken,
) -> CloudResult<MaintenanceDiagnostics> {
    capabilities(client, session, &["maintenance-admin-v1"], cancel).await?;
    let value: MaintenanceDiagnostics = serde_json::from_value(
        client
            .json(
                Method::GET,
                &format!("{}/retention/diagnostics", base(session)),
                None,
                cancel,
            )
            .await?,
    )?;
    if let Some(plan) = &value.plan {
        ensure(
            valid_uuid(&plan.id)
                && plan.execution_id.as_ref().is_none_or(|s| valid_uuid(s))
                && plan.execution_owner.as_ref().is_none_or(|s| valid_uuid(s)),
            "MAINTENANCE_DIAGNOSTICS",
        )?;
    }
    Ok(value)
}
/// No timeout unlock: the caller must attest that old requests actually stopped.
pub async fn release_legacy_maintenance_lock(
    client: &CloudClient,
    session: &TransferSession,
    plan_id: &str,
    execution_id: &str,
    confirmed_stopped: bool,
    cancel: &CancellationToken,
) -> CloudResult<()> {
    ensure(confirmed_stopped, "CONFIRMATION_REQUIRED")?;
    ensure(
        valid_uuid(plan_id) && valid_uuid(execution_id),
        "PLAN_IDENTITY",
    )?;
    let current = maintenance_diagnostics(client, session, cancel).await?;
    ensure(
        current.legacy_lock
            && current.notebook_locked
            && current.plan.as_ref().is_some_and(|p| {
                p.id == plan_id
                    && p.status == "deleting"
                    && p.execution_id.as_deref() == Some(execution_id)
                    && p.execution_owner.is_none()
            }),
        "LEGACY_LOCK_CHANGED",
    )?;
    let result = client.json(Method::POST, &format!("{}/retention/legacy-lock/release", base(session)), Some(json!({
        "planId":plan_id,"executionId":execution_id,"confirmed":true,"attestation":"legacy-requests-stopped",
    })), cancel).await?;
    ensure(
        result["released"] == true
            && result["planId"] == plan_id
            && result["notebookLocked"] == true,
        "MAINTENANCE_DIAGNOSTICS",
    )
}
