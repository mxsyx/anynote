use super::*;
use rusqlite::{OptionalExtension, types::Value as SqlValue};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[non_exhaustive]
pub struct SearchRequest {
    pub request_id: String,
    pub notebook_ids: Option<Vec<String>>,
    #[serde(default)]
    pub query: String,
    pub note_type: Option<NoteType>,
    pub folder_id: Option<String>,
    pub tag: Option<String>,
    pub updated_after: Option<i64>,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default = "default_budget")]
    pub budget_ms: u64,
}
fn default_limit() -> usize {
    100
}
fn default_budget() -> u64 {
    2000
}
impl SearchRequest {
    pub fn new(request_id: String, query: String) -> Self {
        Self {
            request_id,
            query,
            notebook_ids: None,
            note_type: None,
            folder_id: None,
            tag: None,
            updated_after: None,
            limit: 100,
            budget_ms: 2000,
        }
    }
    fn validate(&self) -> ReadResult<()> {
        uuid(&self.request_id)?;
        let invalid = || ReadError::new(ReadErrorKind::InvalidInput, "搜索参数无效");
        if !(1..=200).contains(&self.limit)
            || !(50..=10000).contains(&self.budget_ms)
            || self.query.encode_utf16().count() > 300
            || self.updated_after.is_some_and(|n| n < 0)
        {
            return Err(invalid());
        }
        if let Some(ids) = &self.notebook_ids {
            if ids.is_empty()
                || ids.len() > 1000
                || ids.iter().collect::<HashSet<_>>().len() != ids.len()
            {
                return Err(invalid());
            }
            for id in ids {
                uuid(id)?;
            }
        }
        if let Some(folder) = &self.folder_id {
            uuid(folder)?;
            if self.notebook_ids.as_ref().is_none_or(|ids| ids.len() != 1) {
                return Err(invalid());
            }
        }
        if self
            .tag
            .as_ref()
            .is_some_and(|tag| js_trim(tag).is_empty() || js_trim(tag).encode_utf16().count() > 40)
        {
            return Err(invalid());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SearchLocation {
    Text { query: String },
    Pdf { anchor: String },
    Metadata,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[non_exhaustive]
pub struct SearchHit {
    #[serde(flatten)]
    pub node: Node,
    pub snippet: String,
    pub path: String,
    #[serde(rename = "notebookId")]
    pub notebook_id: String,
    #[serde(rename = "notebookName")]
    pub notebook_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<SearchLocation>,
}
#[derive(Clone, Debug, Serialize)]
#[non_exhaustive]
pub struct SearchWarning {
    #[serde(rename = "notebookId")]
    pub notebook_id: String,
    pub message: String,
    pub code: ReadErrorKind,
}
#[derive(Clone, Debug, Serialize)]
#[non_exhaustive]
pub struct SearchResponse {
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub results: Vec<SearchHit>,
    pub warnings: Vec<SearchWarning>,
    pub cancelled: bool,
    pub truncated: bool,
    pub searched: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[non_exhaustive]
pub struct Backlink {
    pub id: String,
    pub title: String,
    pub updated_at: i64,
    #[serde(rename = "notebookId")]
    pub notebook_id: String,
    #[serde(rename = "notebookName")]
    pub notebook_name: String,
}
impl ReadonlyCatalog {
    /// Matches the existing between-notebook soft budget. Cancellation clears all partial hits.
    pub fn search(
        &mut self,
        request: &SearchRequest,
        cancelled: Arc<AtomicBool>,
    ) -> ReadResult<SearchResponse> {
        let started = Instant::now();
        self.search_with_elapsed(request, cancelled, || started.elapsed())
    }
    fn search_with_elapsed(
        &mut self,
        request: &SearchRequest,
        cancelled: Arc<AtomicBool>,
        elapsed: impl Fn() -> Duration,
    ) -> ReadResult<SearchResponse> {
        request.validate()?;
        let ids = request
            .notebook_ids
            .clone()
            .unwrap_or_else(|| self.entries().iter().map(|e| e.id.clone()).collect());
        let registered: HashSet<_> = self.entries().iter().map(|e| e.id.as_str()).collect();
        if ids.iter().any(|id| !registered.contains(id.as_str())) {
            return Err(ReadError::new(
                ReadErrorKind::NotFound,
                "搜索 Notebook 尚未登记",
            ));
        }
        let mut response = SearchResponse {
            request_id: request.request_id.clone(),
            results: Vec::new(),
            warnings: Vec::new(),
            cancelled: false,
            truncated: ids.len() > 1000,
            searched: 0,
        };
        for id in ids.iter().take(1000) {
            if cancelled.load(Ordering::Acquire) {
                return Ok(cancel_response(response));
            }
            if elapsed().as_millis() > request.budget_ms as u128 {
                response.truncated = true;
                break;
            }
            match self.read(id).and_then(|book| book.query(request)) {
                Ok(hits) => {
                    response.truncated |= hits.len() > request.limit;
                    response.results.extend(hits);
                    response.searched += 1;
                }
                Err(error) => response.warnings.push(SearchWarning {
                    notebook_id: id.clone(),
                    message: error.message().into(),
                    code: error.kind(),
                }),
            }
        }
        response.results.sort_by(|a, b| {
            b.node
                .updated_at
                .cmp(&a.node.updated_at)
                .then_with(|| uuid_order(&a.notebook_id, &b.notebook_id))
                .then_with(|| uuid_order(&a.node.id, &b.node.id))
        });
        response.truncated |= response.results.len() > request.limit;
        response.results.truncate(request.limit);
        if !js_trim(&request.query).is_empty() {
            // Group final hits so alternating libraries cannot thrash the LRU.
            let mut books = Vec::new();
            for hit in &response.results {
                if !books.contains(&hit.notebook_id) {
                    books.push(hit.notebook_id.clone());
                }
            }
            for id in books {
                if cancelled.load(Ordering::Acquire) {
                    return Ok(cancel_response(response));
                }
                match self.read(&id) {
                    Ok(book) => {
                        for hit in response.results.iter_mut().filter(|h| h.notebook_id == id) {
                            match book.locate_hit(hit, &request.query) {
                                Ok(location) => hit.location = Some(location),
                                Err(error) => {
                                    response.warnings.push(SearchWarning {
                                        notebook_id: id.clone(),
                                        message: error.message().into(),
                                        code: error.kind(),
                                    });
                                    break;
                                }
                            }
                        }
                    }
                    Err(error) => response.warnings.push(SearchWarning {
                        notebook_id: id,
                        message: error.message().into(),
                        code: error.kind(),
                    }),
                }
            }
        }
        if cancelled.load(Ordering::Acquire) {
            return Ok(cancel_response(response));
        }
        Ok(response)
    }
    pub fn backlinks(&mut self, notebook_id: &str, note_id: &str) -> ReadResult<Vec<Backlink>> {
        let target = self.read(notebook_id)?.note(note_id)?;
        if target.node.deleted_at.is_some() {
            return Err(ReadError::new(ReadErrorKind::NotFound, "笔记已删除"));
        }
        let mut result = Vec::new();
        for entry in self.diagnose().into_iter().filter(|e| !e.unavailable) {
            let book = self.read(&entry.id)?;
            for mut row in model::rows(
                &book.db,
                "SELECT n.id,n.title,n.updated_at FROM note_links l JOIN nodes n ON n.id=l.source_note_id WHERE l.target_notebook_id=? AND l.target_note_id=? AND n.deleted_at IS NULL",
                [notebook_id, note_id],
            )? {
                row["notebookId"] = entry.id.clone().into();
                row["notebookName"] = entry.name.clone().into();
                result.push(serde_json::from_value::<Backlink>(row)?);
            }
        }
        result.sort_by_key(|a| std::cmp::Reverse(a.updated_at));
        Ok(result)
    }
}
fn cancel_response(mut response: SearchResponse) -> SearchResponse {
    response.cancelled = true;
    response.truncated = false;
    response.results.clear();
    response.warnings.clear();
    response
}
impl ReadonlyNotebook {
    fn query(&self, request: &SearchRequest) -> ReadResult<Vec<SearchHit>> {
        self.check_path()?;
        let query = js_trim(&request.query);
        let full_text = query.chars().count() >= 3;
        let mut params: Vec<SqlValue> = Vec::new();
        let mut where_parts = vec!["n.deleted_at IS NULL"];
        let mut prefix = "";
        if let Some(folder) = &request.folder_id {
            let node = self.note(folder)?;
            if node.node.kind != NodeKind::Folder || node.node.deleted_at.is_some_and(|n| n != 0) {
                return Err(ReadError::new(ReadErrorKind::NotFound, "搜索目录不存在"));
            }
            prefix = "WITH RECURSIVE scope(id) AS (SELECT ? UNION SELECT n.id FROM nodes n JOIN scope s ON n.parent_id=s.id WHERE n.deleted_at IS NULL) ";
            params.push(folder.clone().into());
            where_parts.push("n.parent_id IN (SELECT id FROM scope)");
        }
        let snippet = if full_text {
            "snippet(fts_notes,2,'','', '…',32)"
        } else if !query.is_empty() {
            params.push(query.to_owned().into());
            "substr(f.body,max(1,instr(lower(f.body),lower(?))-60),160)"
        } else {
            "substr(f.body,1,160)"
        };
        if full_text {
            where_parts.push("fts_notes MATCH ?");
            params.push(format!("\"{}\"", query.replace('"', "\"\"")).into());
        } else if !query.is_empty() {
            where_parts
                .push("(instr(lower(n.title),lower(?))>0 OR instr(lower(f.body),lower(?))>0)");
            params.push(query.to_owned().into());
            params.push(query.to_owned().into());
        }
        if let Some(kind) = &request.note_type {
            where_parts.push("t.note_type=?");
            params.push(
                serde_json::to_value(kind)?
                    .as_str()
                    .unwrap()
                    .to_owned()
                    .into(),
            );
        }
        if let Some(tag) = &request.tag {
            where_parts.push("EXISTS(SELECT 1 FROM json_each(n.tags) WHERE value=?)");
            params.push(js_trim(tag).to_owned().into());
        }
        if let Some(after) = request.updated_after {
            where_parts.push("n.updated_at>=?");
            params.push(after.into());
        }
        params.push((request.limit as i64 + 1).into());
        let alias = if full_text { "fts_notes" } else { "f" };
        let sql = format!(
            "{prefix}SELECT n.*,t.note_type,{snippet} AS snippet FROM nodes n JOIN notes t ON t.node_id=n.id JOIN fts_notes {} ON {alias}.note_id=n.id WHERE {} ORDER BY n.updated_at DESC,n.id LIMIT ?",
            if full_text { "" } else { "f" },
            where_parts.join(" AND ")
        );
        model::rows(&self.db, &sql, rusqlite::params_from_iter(params))?
            .into_iter()
            .map(|row| {
                let raw_tags = row["tags"].as_str().unwrap_or("").to_owned();
                let snippet = row["snippet"].as_str().unwrap_or("");
                let snippet = snippet.trim_end_matches(js_whitespace).to_owned();
                let node: Node = serde_json::from_value(model::node_value(row)?)?;
                let snippet = if let Some(text) = snippet.strip_suffix(&raw_tags) {
                    js_trim(&format!(
                        "{}{}",
                        text.trim_end_matches(js_whitespace),
                        if node.tags.is_empty() {
                            String::new()
                        } else {
                            format!("\n标签：{}", node.tags.join("、"))
                        }
                    ))
                    .to_owned()
                } else {
                    snippet
                };
                Ok(SearchHit {
                    path: self.folder_path(node.parent_id.as_deref())?,
                    node,
                    snippet,
                    notebook_id: self.metadata().id.clone(),
                    notebook_name: self.metadata().name.clone(),
                    location: None,
                })
            })
            .collect()
    }
    fn locate_hit(&self, hit: &SearchHit, raw: &str) -> ReadResult<SearchLocation> {
        let query = js_trim(raw);
        let includes = |s: &str| s.to_lowercase().contains(&query.to_lowercase());
        let body: Option<String> = self.db.query_row("SELECT r.body FROM notes t JOIN note_revisions r ON r.id=t.head_revision_id WHERE t.node_id=?", [&hit.node.id], |r| r.get(0)).optional()?;
        if body.as_deref().is_some_and(includes) {
            return Ok(SearchLocation::Text {
                query: query.into(),
            });
        }
        if hit.node.note_type == Some(NoteType::Pdf) {
            let annotation: Option<String> = self.db.query_row("SELECT a.id FROM annotations a JOIN notes n ON n.node_id=a.note_id JOIN resources r ON r.id=n.primary_resource_id WHERE a.note_id=? AND a.deleted_at IS NULL AND a.target_asset_hash=r.asset_hash AND (instr(lower(a.quote),lower(?))>0 OR instr(lower(a.body),lower(?))>0) ORDER BY a.page,a.id LIMIT 1",[&hit.node.id,query,query],|r|r.get(0)).optional()?;
            if let Some(id) = annotation {
                return Ok(SearchLocation::Pdf {
                    anchor: format!("pdf-annotation-{id}"),
                });
            }
            let text: Option<String> = self.db.query_row("SELECT t.body FROM note_text t JOIN notes n ON n.node_id=t.note_id JOIN resources r ON r.id=n.primary_resource_id WHERE t.note_id=? AND t.asset_hash=r.asset_hash",[&hit.node.id],|r|r.get(0)).optional()?;
            if let Some(text) = text {
                static PAGE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
                    regex::Regex::new(r"\n\[第 ([0-9]+) 页\]\n").unwrap()
                });
                let pages: Vec<_> = PAGE.captures_iter(&text).collect();
                for (ix, page) in pages.iter().enumerate() {
                    let end = pages
                        .get(ix + 1)
                        .map_or(text.len(), |p| p.get(0).unwrap().start());
                    if includes(&text[page.get(0).unwrap().end()..end]) {
                        return Ok(SearchLocation::Pdf {
                            anchor: format!("pdf-page-{}", &page[1]),
                        });
                    }
                }
            }
        }
        Ok(SearchLocation::Metadata)
    }
}
fn js_trim(text: &str) -> &str {
    text.trim_matches(js_whitespace)
}
fn js_whitespace(ch: char) -> bool {
    matches!(ch,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}

// UUIDs have fixed punctuation and ASCII hex digits. JS localeCompare compares
// case-insensitively first, with lowercase before uppercase on ties.
fn uuid_order(a: &str, b: &str) -> std::cmp::Ordering {
    a.bytes()
        .map(|b| b.to_ascii_lowercase())
        .cmp(b.bytes().map(|b| b.to_ascii_lowercase()))
        .then_with(|| b.cmp(a))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, fs};
    #[test]
    fn soft_budget_and_inflight_cancellation_keep_the_existing_partial_result_contract() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm04");
        fs::create_dir_all(&root).unwrap();
        let temp = tempfile::tempdir_in(root.canonicalize().unwrap()).unwrap();
        for _ in 0..2 {
            let id = uuid::Uuid::new_v4().to_string();
            let note = uuid::Uuid::new_v4().to_string();
            let revision = uuid::Uuid::new_v4().to_string();
            let dir = temp.path().join(&id);
            fs::create_dir(&dir).unwrap();
            let db = rusqlite::Connection::open(dir.join("notebook.sqlite")).unwrap();
            db.execute_batch(SCHEMA_V5).unwrap();
            db.execute(
                "INSERT INTO notebook_meta(id,name,created_at) VALUES(?,'book',1)",
                [&id],
            )
            .unwrap();
            db.execute("INSERT INTO nodes(id,kind,title,sort_key,created_at,updated_at) VALUES(?,'note','hit',1,1,1)",[&note]).unwrap();
            db.execute(
                "INSERT INTO notes(node_id,note_type) VALUES(?,'markdown')",
                [&note],
            )
            .unwrap();
            db.execute(
                "INSERT INTO note_revisions(id,note_id,body,created_at) VALUES(?,?,'hit',1)",
                [&revision, &note],
            )
            .unwrap();
            db.execute(
                "UPDATE notes SET head_revision_id=? WHERE node_id=?",
                [&revision, &note],
            )
            .unwrap();
            db.execute("INSERT INTO fts_notes VALUES(?,'hit','hit')", [&note])
                .unwrap();
        }
        let mut catalog = ReadonlyCatalog::open(temp.path(), 1).unwrap();
        let mut request = SearchRequest::new(uuid::Uuid::new_v4().to_string(), "hit".into());
        request.budget_ms = 50;
        let calls = Cell::new(0);
        let response = catalog
            .search_with_elapsed(&request, Arc::new(AtomicBool::new(false)), || {
                let call = calls.get();
                calls.set(call + 1);
                Duration::from_millis(if call == 0 { 0 } else { 51 })
            })
            .unwrap();
        assert_eq!(response.searched, 1);
        assert_eq!(response.results.len(), 1);
        assert!(response.truncated);
        assert!(!response.cancelled);
        let cancelled = Arc::new(AtomicBool::new(false));
        let response = catalog
            .search_with_elapsed(&request, cancelled.clone(), || {
                cancelled.store(true, Ordering::Release);
                Duration::ZERO
            })
            .unwrap();
        assert_eq!(response.searched, 1);
        assert!(response.cancelled);
        assert!(!response.truncated);
        assert!(response.results.is_empty());
        assert!(response.warnings.is_empty());
    }
}
