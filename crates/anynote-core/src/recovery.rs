//! Evidence required after losing a write response. No transport error authorizes replay.
use crate::backend::RecoveryPolicy;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecoveryEvidence {
    Receipt {
        operation_id: Uuid,
        committed: Option<bool>,
    },
    Revision {
        notebook_id: Uuid,
        node_id: Uuid,
        revision: u64,
        matches_intended_content: bool,
    },
    Unavailable,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecoveryAction {
    RetryRead,
    QueryReceipt,
    RetrySameOperation,
    Confirmed,
    ReadRevisionAndKeepDraft,
    ConflictKeepDraft,
}
pub fn reconcile(policy: &RecoveryPolicy, evidence: &RecoveryEvidence) -> RecoveryAction {
    match (policy, evidence) {
        (RecoveryPolicy::ReadOnly, _) => RecoveryAction::RetryRead,
        (
            RecoveryPolicy::Receipt { operation_id },
            RecoveryEvidence::Receipt {
                operation_id: observed,
                committed,
            },
        ) if operation_id == observed => match committed {
            Some(true) => RecoveryAction::Confirmed,
            Some(false) => RecoveryAction::RetrySameOperation,
            None => RecoveryAction::QueryReceipt,
        },
        (RecoveryPolicy::Receipt { .. }, _) => RecoveryAction::QueryReceipt,
        (
            RecoveryPolicy::Revision {
                notebook_id,
                node_id,
                expected_revision,
            },
            RecoveryEvidence::Revision {
                notebook_id: observed_notebook,
                node_id: observed_node,
                revision,
                matches_intended_content,
            },
        ) if notebook_id == observed_notebook && node_id == observed_node => {
            if revision > expected_revision && *matches_intended_content {
                RecoveryAction::Confirmed
            } else {
                RecoveryAction::ConflictKeepDraft
            }
        }
        (RecoveryPolicy::Revision { .. }, _) => RecoveryAction::ReadRevisionAndKeepDraft,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn receipt_replay_and_save_reconciliation_require_different_authority() {
        let id = Uuid::nil();
        let policy = RecoveryPolicy::Receipt { operation_id: id };
        assert_eq!(
            reconcile(&policy, &RecoveryEvidence::Unavailable),
            RecoveryAction::QueryReceipt
        );
        assert_eq!(
            reconcile(
                &policy,
                &RecoveryEvidence::Receipt {
                    operation_id: id,
                    committed: Some(false)
                }
            ),
            RecoveryAction::RetrySameOperation
        );
        let policy = RecoveryPolicy::Revision {
            notebook_id: id,
            node_id: id,
            expected_revision: 7,
        };
        assert_eq!(
            reconcile(&policy, &RecoveryEvidence::Unavailable),
            RecoveryAction::ReadRevisionAndKeepDraft
        );
        for (revision, matches_intended_content, expected) in [
            (7, true, RecoveryAction::ConflictKeepDraft),
            (8, false, RecoveryAction::ConflictKeepDraft),
            (8, true, RecoveryAction::Confirmed),
        ] {
            assert_eq!(
                reconcile(
                    &policy,
                    &RecoveryEvidence::Revision {
                        notebook_id: id,
                        node_id: id,
                        revision,
                        matches_intended_content
                    }
                ),
                expected
            );
        }
    }
}
