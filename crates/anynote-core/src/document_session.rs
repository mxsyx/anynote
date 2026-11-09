//! Immutable document identities and snapshots for the private desktop protocol.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DocumentId {
    notebook: Uuid,
    note: Uuid,
}
impl DocumentId {
    pub fn new(notebook: Uuid, note: Uuid) -> Self {
        Self { notebook, note }
    }
    pub fn notebook(&self) -> Uuid {
        self.notebook
    }
    pub fn note(&self) -> Uuid {
        self.note
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DocumentContent {
    title: String,
    body: String,
    tags: Vec<String>,
    favorite: bool,
}
impl DocumentContent {
    pub fn new(title: String, body: String, tags: Vec<String>, favorite: bool) -> Self {
        Self {
            title,
            body,
            tags,
            favorite,
        }
    }
    pub fn title(&self) -> &str {
        &self.title
    }
    pub fn body(&self) -> &str {
        &self.body
    }
    pub fn tags(&self) -> &[String] {
        &self.tags
    }
    pub fn favorite(&self) -> bool {
        self.favorite
    }
    pub fn with_body(&self, body: String) -> Self {
        Self {
            body,
            ..self.clone()
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DocumentSnapshot {
    id: DocumentId,
    revision: i64,
    head: Uuid,
    content: DocumentContent,
    resources: std::collections::BTreeMap<Uuid, String>,
    primary_image: Option<Uuid>,
    primary_pdf: Option<Uuid>,
}
impl DocumentSnapshot {
    pub fn new(id: DocumentId, revision: i64, head: Uuid, content: DocumentContent) -> Self {
        Self {
            id,
            revision,
            head,
            content,
            resources: Default::default(),
            primary_image: None,
            primary_pdf: None,
        }
    }
    pub fn id(&self) -> &DocumentId {
        &self.id
    }
    pub fn revision(&self) -> i64 {
        self.revision
    }
    pub fn head(&self) -> Uuid {
        self.head
    }
    pub fn content(&self) -> &DocumentContent {
        &self.content
    }
    pub fn with_resources(mut self, resources: std::collections::BTreeMap<Uuid, String>) -> Self {
        self.resources = resources;
        self
    }
    pub fn resources(&self) -> &std::collections::BTreeMap<Uuid, String> {
        &self.resources
    }
    pub fn with_primary_image(mut self, resource: Option<Uuid>) -> Self {
        self.primary_image = resource;
        self
    }
    pub fn with_primary_pdf(mut self, resource: Option<Uuid>) -> Self {
        self.primary_pdf = resource;
        self
    }
    pub fn primary_pdf(&self) -> Option<Uuid> {
        self.primary_pdf
    }
    pub fn primary_image(&self) -> Option<Uuid> {
        self.primary_image
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SaveDocument {
    epoch: Uuid,
    generation: u64,
    base: DocumentSnapshot,
    resources: Vec<Uuid>,
}
impl SaveDocument {
    pub fn new(epoch: Uuid, generation: u64, base: DocumentSnapshot) -> Self {
        Self {
            epoch,
            generation,
            base,
            resources: vec![],
        }
    }
    pub fn epoch(&self) -> Uuid {
        self.epoch
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn snapshot(&self) -> &DocumentSnapshot {
        &self.base
    }
    pub fn with_resources(mut self, resources: Vec<Uuid>) -> Self {
        self.resources = resources;
        self
    }
    pub fn resources(&self) -> &[Uuid] {
        &self.resources
    }
}
