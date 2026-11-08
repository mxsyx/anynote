use anynote_core::backend::*;
use anynote_storage::runtime_state::RuntimeState;

pub const EVENT_LIMIT: usize = 300;
const KEY: &str = "diagnostics.state.v1";
pub struct Diagnostics {
    snapshot: DiagnosticSnapshot,
}
impl Diagnostics {
    pub fn load(store: &RuntimeState) -> ServiceResult<Self> {
        let mut snapshot = DiagnosticSnapshot::new(DiagnosticLevel::Minimal, vec![], 0, 0);
        if let Some(bytes) = store.read(KEY)? {
            match serde_json::from_slice::<DiagnosticSnapshot>(&bytes) {
                Ok(value) if value.events().len() <= EVENT_LIMIT => snapshot = value,
                _ => {
                    // Preserve the first damaged native record; legacy diagnostic files are never opened.
                    if store.read("diagnostics.damaged.v1")?.is_none() {
                        store.write("diagnostics.damaged.v1", &bytes)?;
                    }
                    snapshot = DiagnosticSnapshot::new(
                        DiagnosticLevel::Minimal,
                        vec![DiagnosticEvent::new(
                            DiagnosticKind::ConfigRecovered,
                            None,
                            0,
                            0,
                        )],
                        0,
                        0,
                    );
                    persist(store, &snapshot)?;
                }
            }
        }
        Ok(Self { snapshot })
    }
    pub fn snapshot(&self) -> DiagnosticSnapshot {
        self.snapshot.clone()
    }
    pub fn set_level(&mut self, store: &RuntimeState, level: DiagnosticLevel) -> ServiceResult<()> {
        let next = DiagnosticSnapshot::new(
            level,
            self.snapshot.events().to_vec(),
            self.snapshot.dropped(),
            self.snapshot.samples(),
        );
        self.commit(store, next)
    }
    pub fn clear(&mut self, store: &RuntimeState) -> ServiceResult<()> {
        self.commit(
            store,
            DiagnosticSnapshot::new(self.snapshot.level(), vec![], 0, 0),
        )
    }
    pub fn record(&mut self, store: &RuntimeState, event: DiagnosticEvent) -> ServiceResult<()> {
        if self.snapshot.level() == DiagnosticLevel::Off {
            return Ok(());
        }
        let mut events = self.snapshot.events().to_vec();
        if self.snapshot.level() == DiagnosticLevel::Full
            || event.code().is_some()
            || event.kind() != DiagnosticKind::RequestCompleted
        {
            events.push(event);
        }
        let dropped = events.len().saturating_sub(EVENT_LIMIT);
        events.drain(..dropped);
        self.commit(
            store,
            DiagnosticSnapshot::new(
                self.snapshot.level(),
                events,
                self.snapshot.dropped().saturating_add(dropped as u64),
                self.snapshot.samples().saturating_add(1),
            ),
        )
    }
    fn commit(&mut self, store: &RuntimeState, next: DiagnosticSnapshot) -> ServiceResult<()> {
        persist(store, &next)?;
        self.snapshot = next;
        Ok(())
    }
    pub fn export(&self) -> ServiceResult<Vec<u8>> {
        serde_json::to_vec(&self.snapshot).map_err(|_| ServiceError::new(ErrorCode::Storage))
    }
}
fn persist(store: &RuntimeState, value: &DiagnosticSnapshot) -> ServiceResult<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| ServiceError::new(ErrorCode::Storage))?;
    store.write(KEY, &bytes)
}
