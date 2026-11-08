use anynote_core::backend::*;
use anynote_storage::runtime_state::RuntimeState;
use uuid::Uuid;

pub const HISTORY_LIMIT: usize = 200;
const KEY: &str = "tasks.history.v1";
pub struct TaskHistory {
    records: Vec<TaskRecord>,
}
impl TaskHistory {
    pub fn load(store: &RuntimeState) -> ServiceResult<Self> {
        let mut records: Vec<TaskRecord> = match store.read(KEY)? {
            Some(bytes) => {
                serde_json::from_slice(&bytes).map_err(|_| ServiceError::new(ErrorCode::Storage))?
            }
            None => vec![],
        };
        if records.len() > HISTORY_LIMIT {
            return Err(ServiceError::new(ErrorCode::Storage));
        }
        for record in &mut records {
            if record.status().is_active() {
                record.transition(TaskStatus::Interrupted)?;
            }
        }
        let history = Self { records };
        history.persist(store, &history.records)?;
        Ok(history)
    }
    pub fn list(&self) -> Vec<TaskRecord> {
        self.records.clone()
    }
    pub fn active_count(&self) -> usize {
        self.records
            .iter()
            .filter(|r| r.status().is_active())
            .count()
    }
    pub fn start(
        &mut self,
        store: &RuntimeState,
        recovery: RecoveryPolicy,
    ) -> ServiceResult<TaskRecord> {
        if self.active_count() >= MAX_ACTIVE_TASKS {
            return Err(ServiceError::new(ErrorCode::Busy));
        }
        let record = TaskRecord::new(Uuid::new_v4(), recovery);
        let mut next = self.records.clone();
        if next.len() >= HISTORY_LIMIT {
            let ix = next
                .iter()
                .position(|r| !r.status().is_active())
                .ok_or_else(|| ServiceError::new(ErrorCode::Busy))?;
            next.remove(ix);
        }
        next.push(record.clone());
        self.persist(store, &next)?;
        self.records = next;
        Ok(record)
    }
    pub fn transition(
        &mut self,
        store: &RuntimeState,
        id: Uuid,
        status: TaskStatus,
    ) -> ServiceResult<TaskRecord> {
        let mut next = self.records.clone();
        let record = next
            .iter_mut()
            .find(|r| r.id() == id)
            .ok_or_else(|| ServiceError::new(ErrorCode::NotFound))?;
        record.transition(status)?;
        let result = record.clone();
        self.persist(store, &next)?;
        self.records = next;
        Ok(result)
    }
    fn persist(&self, store: &RuntimeState, records: &[TaskRecord]) -> ServiceResult<()> {
        store.write(
            KEY,
            &serde_json::to_vec(records).map_err(|_| ServiceError::new(ErrorCode::Storage))?,
        )
    }
}
