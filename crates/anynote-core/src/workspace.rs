//! Typed workspace boundary. Paths enter only through native file authorization.
use crate::document_session::DocumentId;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "op",
    content = "input",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum WorkspaceCommand {
    Books,
    CreateBook {
        title: String,
    },
    RenameBook {
        book: Uuid,
        title: String,
        icon: String,
        color: String,
    },
    Attach {
        path: std::path::PathBuf,
    },
    Detach {
        book: Uuid,
    },
    Nodes {
        book: Uuid,
        trash: bool,
        offset: usize,
    },
    CreateNode {
        book: Uuid,
        parent: Option<Uuid>,
        title: String,
        folder: bool,
    },
    Patch {
        id: DocumentId,
        expected: i64,
        title: Option<String>,
        tags: Option<Vec<String>>,
        favorite: Option<bool>,
    },
    Place {
        id: DocumentId,
        expected: i64,
        parent: Option<Uuid>,
        before: Option<Uuid>,
    },
    Trash {
        id: DocumentId,
        restore: bool,
    },
    History {
        id: DocumentId,
        offset: usize,
    },
    Revision {
        id: DocumentId,
        revision: Uuid,
    },
    RestoreRevision {
        id: DocumentId,
        expected: i64,
        revision: Uuid,
    },
    Backlinks {
        id: DocumentId,
    },
    Search(Search),
    CancelSearch {
        token: Uuid,
    },
    Transfer {
        id: DocumentId,
        expected: i64,
        target: Uuid,
        parent: Option<Uuid>,
        copy: bool,
        operation: Uuid,
    },
    Import {
        book: Uuid,
        parent: Option<Uuid>,
        path: std::path::PathBuf,
    },
    Preferences,
    SetPreferences(Preferences),
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[non_exhaustive]
pub struct Book {
    pub id: Uuid,
    pub title: String,
    pub icon: String,
    pub color: String,
    pub external: bool,
    pub unavailable: bool,
    pub error: Option<String>,
}
impl Book {
    pub fn new(id: Uuid, title: String) -> Self {
        Self {
            id,
            title,
            icon: String::new(),
            color: String::new(),
            external: false,
            unavailable: false,
            error: None,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[non_exhaustive]
pub struct Entry {
    pub id: DocumentId,
    pub parent: Option<Uuid>,
    pub title: String,
    pub folder: bool,
    pub kind: String,
    pub revision: i64,
    pub updated: i64,
    pub favorite: bool,
    pub tags: Vec<String>,
    pub deleted: bool,
}
impl Entry {
    pub fn new(id: DocumentId, title: String) -> Self {
        Self {
            id,
            title,
            parent: None,
            folder: false,
            kind: String::new(),
            revision: 0,
            updated: 0,
            favorite: false,
            tags: vec![],
            deleted: false,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[non_exhaustive]
pub struct HistoryEntry {
    pub id: Uuid,
    pub created: i64,
    pub actor: String,
}
impl HistoryEntry {
    pub fn new(id: Uuid, created: i64, actor: String) -> Self {
        Self { id, created, actor }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[non_exhaustive]
pub struct Search {
    pub token: Uuid,
    pub query: String,
    pub book: Option<Uuid>,
    pub tag: Option<String>,
    pub kind: Option<String>,
    pub updated_after: Option<i64>,
    pub after: Option<SearchCursor>,
}
impl Search {
    pub fn new(query: String) -> Self {
        Self {
            token: Uuid::new_v4(),
            query,
            book: None,
            tag: None,
            kind: None,
            updated_after: None,
            after: None,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[non_exhaustive]
pub struct SearchCursor {
    pub updated: i64,
    pub book: Uuid,
    pub note: Uuid,
}
impl SearchCursor {
    pub fn new(updated: i64, book: Uuid, note: Uuid) -> Self {
        Self {
            updated,
            book,
            note,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[non_exhaustive]
pub struct Hit {
    pub entry: Entry,
    pub snippet: String,
    pub notebook: String,
    pub anchor: Option<String>,
}
impl Hit {
    pub fn new(entry: Entry, snippet: String, notebook: String, anchor: Option<String>) -> Self {
        Self {
            entry,
            snippet,
            notebook,
            anchor,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum WorkspaceReply {
    Books(Vec<Book>),
    Book(Book),
    Nodes {
        entries: Vec<Entry>,
        next: Option<usize>,
    },
    Node(Entry),
    History {
        entries: Vec<HistoryEntry>,
        next: Option<usize>,
    },
    Revision(String),
    Backlinks(Vec<Entry>),
    Search {
        token: Uuid,
        hits: Vec<Hit>,
        warnings: Vec<String>,
        truncated: bool,
        complete: bool,
        cancelled: bool,
    },
    Transferred {
        id: DocumentId,
        complete: bool,
    },
    Preferences(Preferences),
    Done,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ReadingPosition {
    pub id: Option<DocumentId>,
    pub block: usize,
    #[serde(deserialize_with = "finite_number")]
    pub offset: f32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
#[non_exhaustive]
pub struct Preferences {
    pub theme: String,
    #[serde(deserialize_with = "finite_number")]
    pub font_size: f32,
    pub show_tabs: bool,
    pub active_book: Option<Uuid>,
    pub recent: Vec<DocumentId>,
    pub positions: Vec<ReadingPosition>,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            font_size: 16.,
            show_tabs: true,
            active_book: None,
            recent: vec![],
            positions: vec![],
        }
    }
}
impl Preferences {
    pub fn is_valid(&self) -> bool {
        matches!(self.theme.as_str(), "system" | "light" | "dark")
            && self.font_size.is_finite()
            && (12. ..=32.).contains(&self.font_size)
            && self.recent.len() <= 100
            && self.positions.len() <= 100
            && self.positions.iter().all(|p| {
                p.block <= 1_000_000 && p.offset.is_finite() && (0. ..=100_000.).contains(&p.offset)
            })
    }
}

fn finite_number<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<f32, D::Error> {
    let value = serde_json::Number::deserialize(deserializer)?
        .as_f64()
        .map(|v| v as f32);
    value
        .filter(|v| v.is_finite())
        .ok_or_else(|| serde::de::Error::custom("invalid preference number"))
}
