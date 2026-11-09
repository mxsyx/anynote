//! Revision-scoped, bounded resource reads shared by native media readers.
use crate::document_session::DocumentId;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssetScope {
    document: DocumentId,
    revision: Uuid,
    resource: Uuid,
}
impl AssetScope {
    pub fn new(document: DocumentId, revision: Uuid, resource: Uuid) -> Self {
        Self {
            document,
            revision,
            resource,
        }
    }
    pub fn document(&self) -> &DocumentId {
        &self.document
    }
    pub fn revision(&self) -> Uuid {
        self.revision
    }
    pub fn resource(&self) -> Uuid {
        self.resource
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields, rename_all = "snake_case")]
pub enum AssetCommand {
    Open {
        scope: AssetScope,
        token: Uuid,
    },
    Read {
        token: Uuid,
        offset: u64,
        length: u32,
    },
    Close {
        token: Uuid,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields, rename_all = "snake_case")]
pub enum AssetReply {
    Opened {
        hash: String,
        length: u64,
        mime: String,
    },
    Chunk {
        bytes: Vec<u8>,
    },
    Closed,
}
