//! Save state only; the editor remains the sole owner of the current body and history.
use anynote_core::{backend::ErrorCode, document_session::*};
use std::time::{Duration, Instant};
use uuid::Uuid;

pub(super) const SAVE_DELAY: Duration = Duration::from_millis(650);
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum SaveStatus {
    Saved,
    Dirty,
    Saving,
    WaitingForInput,
    Failed(ErrorCode),
    Conflict,
}
pub(super) struct SaveController {
    epoch: Uuid,
    base: DocumentSnapshot,
    generation: u64,
    saved_generation: u64,
    due: Instant,
    pending: Option<SaveDocument>,
    resources: std::collections::BTreeMap<Uuid, String>,
    media_generation: u64,
    saved_media_generation: u64,
    pending_media_generation: u64,
    pub status: SaveStatus,
    pub remote: Option<DocumentSnapshot>,
}
impl SaveController {
    pub fn new(base: DocumentSnapshot) -> Self {
        Self {
            epoch: Uuid::new_v4(),
            base,
            generation: 0,
            saved_generation: 0,
            due: Instant::now(),
            pending: None,
            resources: Default::default(),
            media_generation: 0,
            saved_media_generation: 0,
            pending_media_generation: 0,
            status: SaveStatus::Saved,
            remote: None,
        }
    }
    pub fn base(&self) -> &DocumentSnapshot {
        &self.base
    }
    pub fn accept_builtin(&mut self, snapshot: DocumentSnapshot, generation: u64) {
        self.base = snapshot;
        self.generation = generation;
        self.saved_generation = generation;
        self.pending = None;
        self.remote = None;
        self.status = SaveStatus::Saved;
    }
    pub fn epoch(&self) -> Uuid {
        self.epoch
    }
    pub fn dirty(&self) -> bool {
        self.generation != self.saved_generation
            || self.pending.is_some()
            || self.media_generation != self.saved_media_generation
    }
    pub fn observe(&mut self, generation: u64, now: Instant) -> bool {
        if generation == self.generation {
            return false;
        }
        self.generation = generation;
        self.due = now + SAVE_DELAY;
        if matches!(
            self.status,
            SaveStatus::Saved | SaveStatus::Dirty | SaveStatus::WaitingForInput
        ) {
            self.status = SaveStatus::Dirty;
        }
        true
    }
    pub fn prepare(
        &mut self,
        body: &str,
        composing: bool,
        force: bool,
        now: Instant,
    ) -> Option<SaveDocument> {
        if composing {
            if self.dirty() {
                self.status = SaveStatus::WaitingForInput;
            }
            return None;
        }
        if !self.dirty()
            || self.pending.is_some()
            || self.remote.is_some()
            || matches!(self.status, SaveStatus::Failed(_))
            || (!force && now < self.due)
        {
            return None;
        }
        let draft = DocumentSnapshot::new(
            self.base.id().clone(),
            self.base.revision(),
            self.base.head(),
            self.base.content().with_body(body.into()),
        )
        .with_primary_image(self.base.primary_image());
        let request = SaveDocument::new(self.epoch, self.generation, draft).with_resources(
            self.resources
                .keys()
                .filter(|id| {
                    body.contains(&id.to_string()) || self.base.primary_image() == Some(**id)
                })
                .copied()
                .collect(),
        );
        self.pending_media_generation = self.media_generation;
        self.pending = Some(request.clone());
        self.status = SaveStatus::Saving;
        Some(request)
    }
    pub fn acknowledge(&mut self, ack: &SaveDocument) -> bool {
        let Some(pending) = &self.pending else {
            return false;
        };
        if ack.epoch() != self.epoch
            || ack.generation() != pending.generation()
            || ack.snapshot().id() != self.base.id()
        {
            return false;
        }
        if ack.snapshot().revision() != pending.snapshot().revision() + 1
            || ack.snapshot().content() != pending.snapshot().content()
            || pending
                .resources()
                .iter()
                .any(|id| ack.snapshot().resources().get(id) != self.resources.get(id))
        {
            self.status = SaveStatus::Failed(ErrorCode::InvalidRequest);
            return false;
        }
        for id in pending.resources() {
            self.resources.remove(id);
        }
        self.base = ack.snapshot().clone();
        self.saved_generation = ack.generation();
        self.saved_media_generation = self.pending_media_generation;
        self.pending = None;
        self.status = if self.dirty() {
            SaveStatus::Dirty
        } else {
            SaveStatus::Saved
        };
        true
    }
    pub fn fail(&mut self, epoch: Uuid, generation: u64, error: ErrorCode) {
        if self
            .pending
            .as_ref()
            .is_some_and(|p| p.epoch() == epoch && p.generation() == generation)
        {
            self.status = SaveStatus::Failed(error);
        }
    }
    pub fn reconcile(&mut self, epoch: Uuid, remote: DocumentSnapshot) -> bool {
        if epoch != self.epoch || remote.id() != self.base.id() {
            return false;
        }
        let Some(pending) = self.pending.clone() else {
            return false;
        };
        if remote.revision() == pending.snapshot().revision() + 1
            && remote.content() == pending.snapshot().content()
            && pending
                .resources()
                .iter()
                .all(|id| remote.resources().get(id) == self.resources.get(id))
        {
            return self.acknowledge(&SaveDocument::new(epoch, pending.generation(), remote));
        }
        if remote == self.base {
            self.pending = None;
            self.status = SaveStatus::Failed(ErrorCode::Storage);
        } else {
            self.remote = Some(remote);
            self.status = SaveStatus::Conflict;
        }
        true
    }
    pub fn wait_for_input(&mut self) {
        if !self.retry_needed() {
            self.status = SaveStatus::WaitingForInput;
        }
    }
    pub fn stage_resource(&mut self, resource: Uuid, hash: String) {
        self.resources.insert(resource, hash);
        self.media_generation += 1;
        self.status = SaveStatus::Dirty;
    }
    pub fn input_finished(&mut self) {
        if self.status == SaveStatus::WaitingForInput {
            self.status = if self.dirty() {
                SaveStatus::Dirty
            } else {
                SaveStatus::Saved
            };
        }
    }
    pub fn retry(&mut self) -> bool {
        if self.pending.is_none() && self.remote.is_none() && self.retry_needed() {
            self.status = SaveStatus::Dirty;
            return true;
        }
        false
    }
    pub fn retry_needed(&self) -> bool {
        matches!(self.status, SaveStatus::Failed(_) | SaveStatus::Conflict)
    }
    pub fn label(&self) -> &'static str {
        match self.status {
            SaveStatus::Saved => "已保存",
            SaveStatus::Dirty => "未保存",
            SaveStatus::Saving => "正在保存",
            SaveStatus::WaitingForInput => "等待完成输入",
            SaveStatus::Conflict => "笔记已在其他位置修改，当前草稿已保留",
            SaveStatus::Failed(_) => "保存未确认，当前草稿已保留",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn initial() -> DocumentSnapshot {
        DocumentSnapshot::new(
            DocumentId::new(Uuid::new_v4(), Uuid::new_v4()),
            1,
            Uuid::new_v4(),
            DocumentContent::new("Note".into(), "start".into(), vec![], false),
        )
    }
    fn ack(p: &SaveDocument) -> SaveDocument {
        SaveDocument::new(
            p.epoch(),
            p.generation(),
            DocumentSnapshot::new(
                p.snapshot().id().clone(),
                p.snapshot().revision() + 1,
                Uuid::new_v4(),
                p.snapshot().content().clone(),
            ),
        )
    }
    #[test]
    fn debounce_serial_ack_keeps_newer_input_dirty() {
        let mut s = SaveController::new(initial());
        let now = Instant::now();
        s.observe(1, now);
        assert!(
            s.prepare("first", false, false, now + Duration::from_millis(649))
                .is_none()
        );
        let first = s.prepare("first", false, false, now + SAVE_DELAY).unwrap();
        s.observe(2, now + SAVE_DELAY);
        assert!(s.prepare("second", false, true, now + SAVE_DELAY).is_none());
        assert!(s.acknowledge(&ack(&first)));
        assert!(s.dirty());
        let next = s.prepare("second", false, true, now + SAVE_DELAY).unwrap();
        assert_eq!(next.snapshot().revision(), 2);
        assert_eq!(next.snapshot().content().body(), "second");
        assert!(!s.acknowledge(&ack(&first)));
        assert!(s.acknowledge(&ack(&next)));
        assert!(!s.dirty());
    }
    #[test]
    fn composition_and_wrong_session_cannot_flush_or_ack() {
        let mut s = SaveController::new(initial());
        let now = Instant::now();
        s.observe(1, now);
        assert!(s.prepare("preedit", true, true, now).is_none());
        let p = s.prepare("committed", false, true, now).unwrap();
        let wrong = SaveDocument::new(Uuid::new_v4(), p.generation(), ack(&p).snapshot().clone());
        assert!(!s.acknowledge(&wrong));
        assert!(s.dirty());
        let other = initial();
        assert!(!s.reconcile(s.epoch(), other));
        assert!(s.dirty());
    }
    #[test]
    fn lost_ack_reconciles_without_replaying_and_preserves_new_input() {
        let mut s = SaveController::new(initial());
        let now = Instant::now();
        s.observe(1, now);
        let p = s.prepare("saved", false, true, now).unwrap();
        s.observe(2, now);
        s.fail(p.epoch(), p.generation(), ErrorCode::Disconnected);
        assert!(s.prepare("newer", false, true, now).is_none());
        assert!(s.reconcile(s.epoch(), ack(&p).snapshot().clone()));
        assert!(s.dirty());
        assert_eq!(
            s.prepare("newer", false, true, now)
                .unwrap()
                .snapshot()
                .revision(),
            2
        );
    }
    #[test]
    fn uncommitted_failure_can_retry_but_conflict_cannot_overwrite() {
        let initial = initial();
        let mut s = SaveController::new(initial.clone());
        let now = Instant::now();
        s.observe(1, now);
        let p = s.prepare("draft", false, true, now).unwrap();
        s.fail(p.epoch(), 1, ErrorCode::Storage);
        assert!(s.reconcile(s.epoch(), initial));
        assert!(s.retry());
        let retry = s.prepare("draft", false, true, now).unwrap();
        let remote = DocumentSnapshot::new(
            s.base.id().clone(),
            2,
            Uuid::new_v4(),
            s.base.content().with_body("elsewhere".into()),
        );
        s.fail(retry.epoch(), 1, ErrorCode::Conflict);
        assert!(s.reconcile(s.epoch(), remote.clone()));
        assert_eq!(s.remote, Some(remote));
        assert_eq!(s.status, SaveStatus::Conflict);
        assert!(s.prepare("draft", false, true, now).is_none());
        assert!(s.dirty());
    }
    #[test]
    fn image_only_save_checks_hash_on_lost_ack_and_keeps_undo_resources() {
        let id = Uuid::new_v4();
        let body = format!("![image](anynote-resource:{id})");
        let mut state = SaveController::new(initial());
        state.stage_resource(id, "a".repeat(64));
        let pending = state.prepare(&body, false, true, Instant::now()).unwrap();
        assert_eq!(pending.resources(), &[id]);
        let wrong = ack(&pending)
            .snapshot()
            .clone()
            .with_resources([(id, "b".repeat(64))].into_iter().collect());
        assert!(state.reconcile(state.epoch(), wrong));
        assert_eq!(state.status, SaveStatus::Conflict);
        assert!(state.dirty());
        let mut state = SaveController::new(initial());
        state.stage_resource(id, "a".repeat(64));
        let removed = state.prepare("", false, true, Instant::now()).unwrap();
        assert!(removed.resources().is_empty());
        assert!(state.acknowledge(&ack(&removed)));
        assert!(!state.dirty());
        state.observe(1, Instant::now());
        let restored = state.prepare(&body, false, true, Instant::now()).unwrap();
        assert_eq!(restored.resources(), &[id]);
        let saved = ack(&restored)
            .snapshot()
            .clone()
            .with_resources([(id, "a".repeat(64))].into_iter().collect());
        assert!(state.reconcile(state.epoch(), saved));
        assert!(!state.dirty());
    }
}
