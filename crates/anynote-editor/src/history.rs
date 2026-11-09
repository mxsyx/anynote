use crate::{
    model::BlockId,
    selection::Selection,
    transaction::{EditKind, Patch},
};
use std::collections::VecDeque;

#[derive(Clone, Copy, Debug)]
pub struct HistoryBudget {
    steps: usize,
    bytes: usize,
    merge_millis: u64,
}
impl HistoryBudget {
    pub fn new(steps: usize, bytes: usize, merge_millis: u64) -> Self {
        Self {
            steps,
            bytes,
            merge_millis,
        }
    }
}
impl Default for HistoryBudget {
    fn default() -> Self {
        Self::new(500, 8 * 1024 * 1024, 750)
    }
}

pub(crate) struct Entry {
    pub batches: Vec<Vec<Patch>>,
    pub before: Selection,
    pub after: Selection,
    pub kind: EditKind,
    pub block: Option<BlockId>,
    pub millis: u64,
}
impl Entry {
    fn bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self
                .batches
                .iter()
                .map(|batch| {
                    std::mem::size_of::<Vec<Patch>>()
                        + batch.iter().map(Patch::bytes).sum::<usize>()
                })
                .sum::<usize>()
    }
    fn merges(&self, next: &Self, window: u64) -> bool {
        if self.block.is_none()
            || self.block != next.block
            || self.kind != next.kind
            || self.after.anchor() != next.before.anchor()
            || self.after.head() != next.before.head()
            || next
                .millis
                .checked_sub(self.millis)
                .is_none_or(|delta| delta > window)
            || !self.after.is_empty()
            || !next.before.is_empty()
        {
            return false;
        }
        let previous = self.batches.last().unwrap();
        let current = &next.batches[0];
        if previous.len() != 1 || current.len() != 1 {
            return false;
        }
        let (a, b) = (&previous[0], &current[0]);
        match self.kind {
            EditKind::RichTyping => {
                !a.inserted().contains(['\n', '\r'])
                    && !b.inserted().contains(['\n', '\r'])
                    && !a.removed().contains(['\n', '\r'])
                    && !b.removed().contains(['\n', '\r'])
            }
            EditKind::Typing => {
                a.removed().is_empty()
                    && b.removed().is_empty()
                    && !a.inserted().contains(['\n', '\r'])
                    && !b.inserted().contains(['\n', '\r'])
                    && b.range().start == a.range().start + a.inserted().len()
            }
            EditKind::BackwardDelete => {
                a.inserted().is_empty()
                    && b.inserted().is_empty()
                    && !a.removed().contains(['\n', '\r'])
                    && !b.removed().contains(['\n', '\r'])
                    && b.range().end == a.range().start
            }
            EditKind::ForwardDelete => {
                a.inserted().is_empty()
                    && b.inserted().is_empty()
                    && !a.removed().contains(['\n', '\r'])
                    && !b.removed().contains(['\n', '\r'])
                    && b.range().start == a.range().start
            }
            _ => false,
        }
    }
}

pub(crate) struct History {
    pub undo: VecDeque<Entry>,
    pub redo: Vec<Entry>,
    budget: HistoryBudget,
    merge: bool,
    bytes: usize,
}
impl History {
    pub fn new(budget: HistoryBudget) -> Self {
        Self {
            undo: VecDeque::new(),
            redo: Vec::new(),
            budget,
            merge: false,
            bytes: 0,
        }
    }
    pub fn bytes(&self) -> usize {
        self.bytes
    }
    pub fn break_merge(&mut self) {
        self.merge = false;
    }
    pub fn push(&mut self, mut entry: Entry) {
        self.bytes -= self.redo.iter().map(Entry::bytes).sum::<usize>();
        self.redo.clear();
        self.bytes += entry.bytes();
        if self.merge
            && self
                .undo
                .back()
                .is_some_and(|previous| previous.merges(&entry, self.budget.merge_millis))
        {
            self.bytes -= std::mem::size_of::<Entry>();
            let previous = self.undo.back_mut().unwrap();
            previous.batches.append(&mut entry.batches);
            previous.after = entry.after;
            previous.millis = entry.millis;
        } else {
            self.undo.push_back(entry);
        }
        self.merge = true;
        while self.undo.len() > self.budget.steps || self.bytes() > self.budget.bytes {
            if let Some(entry) = self.undo.pop_front() {
                self.bytes -= entry.bytes();
            } else {
                break;
            }
        }
    }
}
