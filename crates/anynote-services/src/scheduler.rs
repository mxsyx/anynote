//! Scheduling permission is separate from starting a service task.
use anynote_core::environment::Environment;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScheduleDecision {
    Ready,
    WaitingForObservation,
    WaitingForNetwork,
    WaitingForPower,
    WaitingForUnmetered,
}
pub fn background_decision(environment: &Environment) -> ScheduleDecision {
    match (
        environment.online(),
        environment.on_battery(),
        environment.metered(),
    ) {
        (Some(false), _, _) => ScheduleDecision::WaitingForNetwork,
        (_, Some(true), _) => ScheduleDecision::WaitingForPower,
        (_, _, Some(true)) => ScheduleDecision::WaitingForUnmetered,
        (Some(true), Some(false), Some(false)) => ScheduleDecision::Ready,
        _ => ScheduleDecision::WaitingForObservation,
    }
}

use crate::cloud::{CloudError, CloudResult};
use anynote_storage::runtime_state::RuntimeState;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tokio_util::sync::CancellationToken;

const KEY: &str = "backup.scheduler.v1";
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupPolicy {
    pub base_seconds: u64,
    pub max_seconds: u64,
    pub jitter_ratio: f64,
    pub max_attempts: u32,
    pub on_battery: bool,
    pub on_metered: bool,
    pub large_task_bytes: u64,
}
impl Default for BackupPolicy {
    fn default() -> Self {
        Self {
            base_seconds: 30,
            max_seconds: 3600,
            jitter_ratio: 0.5,
            max_attempts: 8,
            on_battery: false,
            on_metered: false,
            large_task_bytes: 0,
        }
    }
}
impl BackupPolicy {
    fn validate(&self) -> CloudResult<()> {
        if !(1..=86400).contains(&self.base_seconds)
            || !(1..=86400).contains(&self.max_seconds)
            || !(0.0..=1.0).contains(&self.jitter_ratio)
            || !(1..=100).contains(&self.max_attempts)
            || self.large_task_bytes > crate::cloud::JS_SAFE
        {
            return Err(CloudError::new("SCHEDULE_POLICY"));
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BackupKind {
    Local,
    Remote,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PauseReason {
    Auth,
    Permanent,
    Exhausted,
    Cancelled,
    Offline,
    Battery,
    Metered,
    LargeTask,
    Observation,
    Disk,
    Notebook,
}
impl PauseReason {
    fn sticky(self) -> bool {
        matches!(
            self,
            Self::Auth | Self::Permanent | Self::Exhausted | Self::Cancelled
        )
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduledTarget {
    pub id: String,
    /// Includes connection/endpoint/lineage/device/epoch, or local target/volume identity.
    pub binding: String,
    pub kind: BackupKind,
    pub enabled: bool,
    pub interval_ms: u64,
    pub on_mount: bool,
    pub last_task_bytes: u64,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleState {
    pub failure_count: u32,
    pub last_attempt: Option<u64>,
    pub last_success: Option<u64>,
    pub next_attempt: Option<u64>,
    pub paused: Option<PauseReason>,
    pub interrupted: bool,
    pub running: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Entry {
    target: ScheduledTarget,
    state: ScheduleState,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Saved {
    policy: BackupPolicy,
    entries: BTreeMap<String, Entry>,
}
#[derive(Clone, Copy)]
pub struct Availability {
    pub notebook: bool,
    pub disk: bool,
}

/// The host supplies current observations and service executors; both backup kinds
/// use the same durable admission/failure path. A claimed run cannot start twice.
pub struct BackupScheduler {
    saved: Saved,
    local_online: BTreeMap<String, bool>,
}
impl BackupScheduler {
    pub fn load(store: &RuntimeState) -> CloudResult<Self> {
        let mut saved: Saved = store
            .read(KEY)?
            .map(|b| serde_json::from_slice(&b))
            .transpose()?
            .unwrap_or_default();
        saved.policy.validate()?;
        if saved.entries.len() > 200 {
            return Err(CloudError::new("SCHEDULE_LIMIT"));
        }
        for (id, entry) in &mut saved.entries {
            validate_target(&entry.target)?;
            if id != &entry.target.id {
                return Err(CloudError::new("SCHEDULE_IDENTITY"));
            }
            if entry.state.running {
                entry.state.running = false;
                entry.state.interrupted = true;
            }
        }
        store.write(KEY, &serde_json::to_vec(&saved)?)?;
        Ok(Self {
            saved,
            local_online: BTreeMap::new(),
        })
    }
    fn save(&mut self, store: &RuntimeState, next: Saved) -> CloudResult<()> {
        store.write(KEY, &serde_json::to_vec(&next)?)?;
        self.saved = next;
        Ok(())
    }
    pub fn configure(&mut self, store: &RuntimeState, target: ScheduledTarget) -> CloudResult<()> {
        validate_target(&target)?;
        let mut next = self.saved.clone();
        if next.entries.len() >= 200 && !next.entries.contains_key(&target.id) {
            return Err(CloudError::new("SCHEDULE_LIMIT"));
        }
        if next
            .entries
            .get(&target.id)
            .is_some_and(|e| e.state.running)
        {
            return Err(CloudError::new("SCHEDULE_BUSY"));
        }
        next.entries.insert(
            target.id.clone(),
            Entry {
                target,
                state: ScheduleState::default(),
            },
        );
        self.save(store, next)
    }
    pub fn set_policy(&mut self, store: &RuntimeState, policy: BackupPolicy) -> CloudResult<()> {
        policy.validate()?;
        let mut next = self.saved.clone();
        next.policy = policy;
        self.save(store, next)
    }
    pub fn repair(&mut self, store: &RuntimeState, id: &str) -> CloudResult<()> {
        let mut next = self.saved.clone();
        let e = next
            .entries
            .get_mut(id)
            .ok_or_else(|| CloudError::new("SCHEDULE_NOT_FOUND"))?;
        if e.state.running {
            return Err(CloudError::new("SCHEDULE_BUSY"));
        }
        e.state.failure_count = 0;
        e.state.next_attempt = None;
        e.state.paused = None;
        self.save(store, next)
    }
    pub fn state(&self, id: &str) -> Option<&ScheduleState> {
        self.saved.entries.get(id).map(|e| &e.state)
    }
    pub async fn tick<F, Fut>(
        &mut self,
        store: &RuntimeState,
        environment: &Environment,
        now: u64,
        availability: impl Fn(&ScheduledTarget) -> Availability,
        cancel: &CancellationToken,
        mut execute: F,
    ) -> CloudResult<usize>
    where
        F: FnMut(ScheduledTarget, CancellationToken) -> Fut,
        Fut: std::future::Future<Output = CloudResult<u64>>,
    {
        let mut count = 0;
        let ids = self.saved.entries.keys().cloned().collect::<Vec<_>>();
        for id in ids {
            if cancel.is_cancelled() {
                break;
            }
            let entry = &self.saved.entries[&id];
            let available = availability(&entry.target);
            let mounted = entry.target.kind == BackupKind::Local
                && available.disk
                && self.local_online.insert(id.clone(), available.disk) == Some(false);
            if entry.target.kind == BackupKind::Local && !available.disk {
                self.local_online.insert(id.clone(), false);
            }
            if !entry.target.enabled
                || entry.state.running
                || entry.state.paused.is_some_and(PauseReason::sticky)
            {
                continue;
            }
            let pause =
                environment_pause(&self.saved.policy, &entry.target, environment, available);
            let due = entry.state.interrupted
                || (entry.state.next_attempt.is_none_or(|t| now >= t)
                    && ((mounted && entry.target.on_mount)
                        || entry
                            .state
                            .last_attempt
                            .is_none_or(|t| now.saturating_sub(t) >= entry.target.interval_ms)));
            let mut next = self.saved.clone();
            next.entries.get_mut(&id).unwrap().state.paused = pause;
            self.save(store, next)?;
            if pause.is_some() || !due {
                continue;
            }
            let target = self.saved.entries[&id].target.clone();
            let mut next = self.saved.clone();
            let s = &mut next.entries.get_mut(&id).unwrap().state;
            s.running = true;
            s.interrupted = false;
            s.last_attempt = Some(now);
            self.save(store, next)?;
            let result = execute(target, cancel.child_token()).await;
            let mut next = self.saved.clone();
            let e = next.entries.get_mut(&id).unwrap();
            e.state.running = false;
            match result {
                Ok(bytes) => {
                    e.target.last_task_bytes = bytes;
                    e.state.failure_count = 0;
                    e.state.next_attempt = None;
                    e.state.paused = None;
                    e.state.last_success = Some(now);
                }
                Err(error) => {
                    apply_failure(&mut e.state, &next.policy, &error, now, random_fraction())
                }
            }
            self.save(store, next)?;
            count += 1;
        }
        Ok(count)
    }
}
fn validate_target(t: &ScheduledTarget) -> CloudResult<()> {
    if t.id.is_empty()
        || t.id.len() > 200
        || t.binding.is_empty()
        || t.binding.len() > 2000
        || t.interval_ms < 1000
        || t.interval_ms > 30 * 86_400_000
        || t.last_task_bytes > crate::cloud::JS_SAFE
    {
        Err(CloudError::new("SCHEDULE_TARGET"))
    } else {
        Ok(())
    }
}
fn environment_pause(
    policy: &BackupPolicy,
    target: &ScheduledTarget,
    env: &Environment,
    available: Availability,
) -> Option<PauseReason> {
    if !available.notebook {
        return Some(PauseReason::Notebook);
    }
    if target.kind == BackupKind::Local && !available.disk {
        return Some(PauseReason::Disk);
    }
    if target.kind == BackupKind::Remote {
        match env.online() {
            Some(false) => return Some(PauseReason::Offline),
            None => return Some(PauseReason::Observation),
            _ => (),
        }
    }
    if policy.on_battery {
        match env.on_battery() {
            Some(true) => return Some(PauseReason::Battery),
            None => return Some(PauseReason::Observation),
            _ => (),
        }
    }
    if policy.on_metered {
        match env.metered() {
            Some(true) => return Some(PauseReason::Metered),
            None => return Some(PauseReason::Observation),
            _ => (),
        }
    }
    if policy.large_task_bytes > 0 && target.last_task_bytes > policy.large_task_bytes {
        return Some(PauseReason::LargeTask);
    }
    None
}
fn random_fraction() -> f64 {
    let bytes = uuid::Uuid::new_v4().into_bytes();
    u32::from_le_bytes(bytes[..4].try_into().unwrap()) as f64 / u32::MAX as f64
}
fn apply_failure(
    state: &mut ScheduleState,
    policy: &BackupPolicy,
    error: &CloudError,
    now: u64,
    random: f64,
) {
    state.next_attempt = None;
    if error.cancelled() {
        state.paused = Some(PauseReason::Cancelled);
        return;
    }
    state.failure_count = state.failure_count.saturating_add(1);
    let transient = matches!(error.status, Some(408 | 425 | 429 | 500..=599))
        || [
            "NETWORK",
            "NETWORK_TIMEOUT",
            "LOCAL_IO",
            "MAINTENANCE_IN_PROGRESS",
        ]
        .contains(&error.code.as_str());
    if matches!(error.status, Some(401 | 403)) {
        state.paused = Some(PauseReason::Auth);
    } else if !transient {
        state.paused = Some(PauseReason::Permanent);
    } else if state.failure_count >= policy.max_attempts {
        state.paused = Some(PauseReason::Exhausted);
    } else {
        let raw = (policy.base_seconds.saturating_mul(1000).saturating_mul(
            1u64.checked_shl(state.failure_count.saturating_sub(1))
                .unwrap_or(u64::MAX),
        ))
        .min(policy.max_seconds * 1000);
        let delay = (raw as f64 * (1.0 - policy.jitter_ratio + random * policy.jitter_ratio))
            .round() as u64;
        state.next_attempt =
            Some(now.saturating_add(delay.max(error.retry_after_ms.unwrap_or(0).min(86_400_000))));
        state.paused = None;
    }
}
