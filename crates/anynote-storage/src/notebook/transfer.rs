//! Atomic storage stages for the services cross-notebook protocol.
use super::write::{SAFE_INTEGER, conflict, input, new_id, now};
use super::*;
use regex::{Captures, Regex};
use rusqlite::{Connection, OptionalExtension, params, types::Value as SqlValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::LazyLock;

const MAX_NODES: usize = 10_000;
const MAX_BYTES: usize = 100 * 1024 * 1024;
const SOURCE: &str = "anynote.core.transfer-source";
const TARGET: &str = "anynote.core.transfer-target";
const META: &str = "anynote.core.revision-meta";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransferMode {
    Copy,
    Move,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferRequest {
    pub notebook_id: String,
    pub id: String,
    pub target_notebook_id: String,
    pub target_parent_id: Option<String>,
    pub mode: TransferMode,
    pub operation_id: String,
    pub expected_revision: i64,
}
impl TransferRequest {
    pub fn validate(&self) -> ReadResult<()> {
        for id in [
            &self.notebook_id,
            &self.id,
            &self.target_notebook_id,
            &self.operation_id,
        ] {
            uuid(id)?;
        }
        if let Some(id) = &self.target_parent_id {
            uuid(id)?;
        }
        input(
            self.notebook_id != self.target_notebook_id,
            "跨库操作需要另一个 Notebook",
        )?;
        input(
            (1..=SAFE_INTEGER).contains(&self.expected_revision),
            "版本无效",
        )
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TransferStatus {
    Completed,
    Copied,
    CopiedSourceChanged,
    CopiedTargetChanged,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferResult {
    pub status: TransferStatus,
    pub operation_id: String,
    pub source_notebook_id: String,
    pub target_notebook_id: String,
    pub id: String,
    pub count: usize,
    pub node_map: HashMap<String, String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferReceipt {
    identity: String,
    source_fingerprint: String,
    target_fingerprint: String,
    result: TransferResult,
}
impl TransferReceipt {
    pub fn result(&self) -> TransferResult {
        self.result.clone()
    }
    pub fn target_changed(&self) -> TransferResult {
        TransferResult {
            status: TransferStatus::CopiedTargetChanged,
            ..self.result()
        }
    }
}
#[derive(Serialize)]
struct Snapshot {
    nodes: Vec<Value>,
    notes: Vec<Value>,
    revisions: Vec<Value>,
    references: Vec<Value>,
    resources: Vec<Value>,
    annotations: Vec<Value>,
    texts: Vec<Value>,
    assets: Vec<Value>,
    metadata: Vec<Value>,
    reports: Vec<Value>,
    pdf_indexes: Vec<Value>,
}
fn field<'a>(row: &'a Value, key: &str) -> ReadResult<&'a str> {
    row[key]
        .as_str()
        .ok_or_else(|| ReadError::new(ReadErrorKind::Corrupt, format!("转移记录缺少 {key}")))
}
fn ids(rows: &[Value], key: &str) -> ReadResult<HashSet<String>> {
    rows.iter().map(|r| Ok(field(r, key)?.to_owned())).collect()
}
fn digest(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
// Keep column and snapshot field order aligned with the existing TS receipts.
fn fingerprint(value: &impl Serialize) -> ReadResult<String> {
    fn encode(value: &Value, out: &mut Vec<u8>) -> ReadResult<()> {
        match value {
            Value::Number(n) => {
                let number = n
                    .as_f64()
                    .ok_or_else(|| ReadError::new(ReadErrorKind::Corrupt, "指纹数值无效"))?;
                out.extend_from_slice(ryu_js::Buffer::new().format(number).as_bytes());
            }
            Value::Array(values) => {
                out.push(b'[');
                for (i, v) in values.iter().enumerate() {
                    if i > 0 {
                        out.push(b',');
                    }
                    encode(v, out)?;
                }
                out.push(b']');
            }
            Value::Object(values) => {
                out.push(b'{');
                for (i, (k, v)) in values.iter().enumerate() {
                    if i > 0 {
                        out.push(b',');
                    }
                    serde_json::to_writer(&mut *out, k)?;
                    out.push(b':');
                    encode(v, out)?;
                }
                out.push(b'}');
            }
            _ => serde_json::to_writer(out, value)?,
        }
        Ok(())
    }
    let mut bytes = Vec::new();
    encode(&serde_json::to_value(value)?, &mut bytes)?;
    Ok(digest(bytes))
}
fn receipt<T: for<'de> Deserialize<'de>>(
    book: &WritableNotebook,
    namespace: &str,
    request: &TransferRequest,
) -> ReadResult<Option<T>> {
    book.view.check_path()?;
    let raw: Option<String> = book
        .view
        .db
        .query_row(
            "SELECT value_json FROM extension_data WHERE extension_id=? AND key=?",
            params![namespace, request.operation_id],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|raw| {
        let value: Value = serde_json::from_str(&raw)?;
        input(
            value["identity"].as_str() == Some(&fingerprint(request)?),
            "操作 ID 已用于不同的跨库请求",
        )?;
        Ok(serde_json::from_value(value)?)
    })
    .transpose()
}
fn write_receipt(
    book: &WritableNotebook,
    namespace: &str,
    request: &TransferRequest,
    value: &impl Serialize,
) -> ReadResult<()> {
    book.view.db.execute("INSERT INTO extension_data(extension_id,key,value_json,schema_version,revision) VALUES(?,?,?,1,1)",params![namespace, request.operation_id, serde_json::to_string(value)?])?;
    Ok(())
}
fn insert(db: &Connection, table: &str, row: &Value) -> ReadResult<()> {
    let fields = row
        .as_object()
        .ok_or_else(|| ReadError::new(ReadErrorKind::Corrupt, "转移记录无效"))?;
    let keys: Vec<_> = fields.keys().map(String::as_str).collect();
    let values: ReadResult<Vec<SqlValue>> =
        fields
            .values()
            .map(|v| {
                Ok(match v {
                    Value::Null => SqlValue::Null,
                    Value::String(s) => SqlValue::Text(s.clone()),
                    Value::Number(n) => {
                        if let Some(n) = n.as_i64() {
                            SqlValue::Integer(n)
                        } else {
                            SqlValue::Real(n.as_f64().ok_or_else(|| {
                                ReadError::new(ReadErrorKind::Corrupt, "数值无效")
                            })?)
                        }
                    }
                    _ => return Err(ReadError::new(ReadErrorKind::Corrupt, "SQL 字段无效")),
                })
            })
            .collect();
    db.execute(
        &format!(
            "INSERT INTO {table}({}) VALUES({})",
            keys.join(","),
            vec!["?"; keys.len()].join(",")
        ),
        rusqlite::params_from_iter(values?),
    )?;
    Ok(())
}
impl WritableNotebook {
    fn transfer_snapshot(&self, root: &str) -> ReadResult<Snapshot> {
        self.view.check_path()?;
        uuid(root)?;
        let mut budget = MAX_BYTES;
        let nodes = model::rows_bounded(
            &self.view.db,
            "WITH RECURSIVE tree(id) AS (SELECT id FROM nodes WHERE id=? UNION SELECT n.id FROM nodes n JOIN tree t ON n.parent_id=t.id LIMIT 10001) SELECT * FROM nodes WHERE id IN tree ORDER BY rowid LIMIT 10001",
            [root],
            &mut budget,
        )?;
        input(nodes.len() <= MAX_NODES, "单次跨库操作最多 10000 个条目")?;
        let mut children: HashMap<String, Vec<Value>> = HashMap::new();
        let mut first = None;
        for node in nodes {
            if node["id"] == root {
                first = Some(node);
            } else {
                children
                    .entry(field(&node, "parent_id")?.into())
                    .or_default()
                    .push(node);
            }
        }
        let first = first.ok_or_else(|| ReadError::new(ReadErrorKind::NotFound, "源条目不存在"))?;
        input(first["deleted_at"].is_null(), "源条目已在回收站")?;
        let mut nodes = Vec::new();
        let mut queue = VecDeque::from([first]);
        while let Some(row) = queue.pop_front() {
            if let Some(next) = children.remove(field(&row, "id")?) {
                queue.extend(next);
            }
            nodes.push(row);
        }
        require(children.is_empty(), "目录存在环路")?;
        let node_ids = ids(&nodes, "id")?;
        let mut select = |table: &str, column: &str, ids: &HashSet<String>| {
            model::rows_bounded(
                &self.view.db,
                &format!(
                    "SELECT * FROM {table} WHERE {column} IN (SELECT value FROM json_each(?)) ORDER BY rowid"
                ),
                [serde_json::to_string(ids)?],
                &mut budget,
            )
        };
        let notes = select("notes", "node_id", &node_ids)?;
        let note_ids = ids(&notes, "node_id")?;
        let revisions = select("note_revisions", "note_id", &note_ids)?;
        let revision_ids = ids(&revisions, "id")?;
        let references = select("revision_resources", "revision_id", &revision_ids)?;
        let mut resource_ids = ids(&references, "resource_id")?;
        resource_ids.extend(
            notes
                .iter()
                .filter_map(|r| r["primary_resource_id"].as_str().map(str::to_owned)),
        );
        let resources = select("resources", "id", &resource_ids)?;
        require(resources.len() == resource_ids.len(), "源资源引用不完整")?;
        let annotations = select("annotations", "note_id", &note_ids)?;
        let texts = select("note_text", "note_id", &note_ids)?;
        let mut hashes = ids(&resources, "asset_hash")?;
        hashes.extend(ids(&references, "asset_hash")?);
        hashes.extend(ids(&annotations, "target_asset_hash")?);
        hashes.extend(ids(&texts, "asset_hash")?);
        let assets = select("assets", "hash", &hashes)?;
        require(assets.len() == hashes.len(), "源附件记录不完整")?;
        let reports = select("import_reports", "note_id", &note_ids)?;
        let metadata = model::rows_bounded(
            &self.view.db,
            "SELECT * FROM extension_data WHERE extension_id=? AND key IN (SELECT value FROM json_each(?)) ORDER BY rowid",
            params![META, serde_json::to_string(&revision_ids)?],
            &mut budget,
        )?;
        let pdf_indexes = model::rows_bounded(
            &self.view.db,
            "SELECT * FROM extension_data WHERE extension_id='anynote.pdf.index' AND key IN (SELECT 'note.' || value FROM json_each(?)) ORDER BY key",
            [serde_json::to_string(&note_ids)?],
            &mut budget,
        )?;
        let result = Snapshot {
            pdf_indexes,
            nodes,
            notes,
            revisions,
            references,
            resources,
            annotations,
            texts,
            assets,
            metadata,
            reports,
        };
        input(
            serde_json::to_vec(&result)?.len() <= MAX_BYTES,
            "跨库记录超过 100MiB 预算",
        )?;
        Ok(result)
    }
    pub fn completed_transfer(
        &self,
        request: &TransferRequest,
    ) -> ReadResult<Option<TransferResult>> {
        request.validate()?;
        self.transfer_identity(&request.notebook_id)?;
        #[derive(Deserialize)]
        struct Completed {
            result: TransferResult,
        }
        Ok(receipt::<Completed>(self, SOURCE, request)?.map(|r| r.result))
    }
    fn transfer_identity(&self, id: &str) -> ReadResult<()> {
        input(self.view.metadata().id == id, "转移 Notebook 身份不匹配")
    }
    /// Atomically publishes all target rows and its receipt; never mutates source.
    pub fn copy_transfer(
        &mut self,
        source: &WritableNotebook,
        request: &TransferRequest,
    ) -> ReadResult<TransferReceipt> {
        request.validate()?;
        self.transfer_identity(&request.target_notebook_id)?;
        source.transfer_identity(&request.notebook_id)?;
        if let Some(receipt) = receipt(self, TARGET, request)? {
            return Ok(receipt);
        }
        self.parent(request.target_parent_id.as_deref(), None)?;
        let data = source.transfer_snapshot(&request.id)?;
        conflict(data.nodes[0]["revision"].as_i64() == Some(request.expected_revision))?;
        let map = |rows: &[Value], key: &str| -> ReadResult<HashMap<String, String>> {
            rows.iter()
                .map(|r| Ok((field(r, key)?.into(), new_id())))
                .collect()
        };
        let nodes = map(&data.nodes, "id")?;
        let resources = map(&data.resources, "id")?;
        let revisions = map(&data.revisions, "id")?;
        let annotations = map(&data.annotations, "id")?;
        let rewrite = Rewriter {
            annotations: &annotations,
            request,
            nodes: &nodes,
            resources: &resources,
        };
        let mut budget = 0u64;
        let mut prepared = Vec::new();
        for row in &data.assets {
            let size = row["size"]
                .as_u64()
                .ok_or_else(|| ReadError::new(ReadErrorKind::Corrupt, "附件大小无效"))?;
            budget = budget
                .checked_add(size)
                .ok_or_else(|| ReadError::new(ReadErrorKind::InvalidInput, "附件预算溢出"))?;
            input(budget <= MAX_BYTES as u64, "单次跨库附件超过 100MiB 预算")?;
            let hash = field(row, "hash")?;
            let mut asset = source.view.asset(hash)?;
            let mut bytes = Vec::with_capacity(size as usize);
            while bytes.len() < size as usize {
                bytes.extend(asset.read_range(
                    hash,
                    bytes.len() as u64,
                    MAX_RANGE_BYTES.min(size as usize - bytes.len()),
                )?);
            }
            require(digest(&bytes) == hash, "源附件在捕获时改变")?;
            if field(row, "mime")? == "application/vnd.anynote.whiteboard+json" {
                let text = std::str::from_utf8(&bytes)
                    .map_err(|_| ReadError::new(ReadErrorKind::Corrupt, "白板 UTF-8 无效"))?;
                bytes = rewrite.text(text).into_bytes();
                budget = budget - size + bytes.len() as u64;
                input(budget <= MAX_BYTES as u64, "单次跨库附件超过 100MiB 预算")?;
            }
            prepared.push((hash.to_owned(), field(row, "mime")?.to_owned(), bytes));
        }
        let root = nodes[&request.id].clone();
        let mut copied = TransferReceipt {
            identity: fingerprint(request)?,
            source_fingerprint: fingerprint(&data)?,
            target_fingerprint: String::new(),
            result: TransferResult {
                status: if request.mode == TransferMode::Copy {
                    TransferStatus::Completed
                } else {
                    TransferStatus::Copied
                },
                operation_id: request.operation_id.clone(),
                source_notebook_id: request.notebook_id.clone(),
                target_notebook_id: request.target_notebook_id.clone(),
                id: root.clone(),
                count: data.nodes.len(),
                node_map: nodes.clone(),
            },
        };
        self.transaction(&root, "transfer-copy", |book| {
            book.view.db.execute_batch("PRAGMA defer_foreign_keys=ON")?;
            let mut hashes = HashMap::new();
            for (hash, mime, bytes) in prepared {
                let next = book.publish_asset_bytes(
                    &mut std::io::Cursor::new(bytes),
                    &mime,
                    MAX_BYTES as u64,
                )?;
                hashes.insert(hash, next);
            }
            let last: f64 = book.view.db.query_row(
                "SELECT COALESCE(MAX(sort_key),0) FROM nodes WHERE parent_id IS ?",
                [&request.target_parent_id],
                |r| r.get(0),
            )?;
            input(
                (last + 1024.0).fract() == 0.0 && (last + 1024.0).abs() <= SAFE_INTEGER as f64,
                "目标排序键超限",
            )?;
            for original in &data.nodes {
                let mut row = original.clone();
                let id = field(&row, "id")?.to_owned();
                row["parent_id"] = if id == request.id {
                    request.target_parent_id.clone().into()
                } else {
                    mapped(&nodes, &row["parent_id"])?
                };
                row["id"] = nodes[&id].clone().into();
                if id == request.id {
                    row["sort_key"] = ((last + 1024.0) as i64).into();
                }
                insert(&book.view.db, "nodes", &row)?;
            }
            for (table, rows, mappings) in [
                (
                    "resources",
                    &data.resources,
                    vec![("id", &resources), ("asset_hash", &hashes)],
                ),
                (
                    "notes",
                    &data.notes,
                    vec![
                        ("node_id", &nodes),
                        ("head_revision_id", &revisions),
                        ("primary_resource_id", &resources),
                    ],
                ),
                (
                    "note_revisions",
                    &data.revisions,
                    vec![("id", &revisions), ("note_id", &nodes)],
                ),
                (
                    "revision_resources",
                    &data.references,
                    vec![
                        ("revision_id", &revisions),
                        ("resource_id", &resources),
                        ("asset_hash", &hashes),
                    ],
                ),
                (
                    "annotations",
                    &data.annotations,
                    vec![("note_id", &nodes), ("target_asset_hash", &hashes)],
                ),
                (
                    "note_text",
                    &data.texts,
                    vec![("note_id", &nodes), ("asset_hash", &hashes)],
                ),
                ("import_reports", &data.reports, vec![("note_id", &nodes)]),
                ("extension_data", &data.metadata, vec![("key", &revisions)]),
            ] {
                for original in rows {
                    let mut row = original.clone();
                    for (key, map) in &mappings {
                        row[*key] = mapped(map, &row[*key])?;
                    }
                    match table {
                        "note_revisions" => row["body"] = rewrite.text(field(&row, "body")?).into(),
                        "import_reports" => {
                            row["report_json"] = rewrite.text(field(&row, "report_json")?).into()
                        }
                        "annotations" => row["id"] = mapped(&annotations, &row["id"])?,
                        "extension_data" => {
                            let mut meta: Value = serde_json::from_str(field(&row, "value_json")?)?;
                            meta["noteId"] = mapped(&nodes, &meta["noteId"])?;
                            row["value_json"] = serde_json::to_string(&meta)?.into();
                        }
                        _ => {}
                    }
                    insert(&book.view.db, table, &row)?;
                }
            }
            for original in &data.pdf_indexes {
                let mut row = original.clone();
                let note = field(&row, "key")?
                    .strip_prefix("note.")
                    .ok_or_else(|| ReadError::invalid_input("PDF 索引键无效"))?;
                row["key"] = format!(
                    "note.{}",
                    nodes
                        .get(note)
                        .ok_or_else(|| ReadError::invalid_input("PDF 索引目标缺失"))?
                )
                .into();
                insert(&book.view.db, "extension_data", &row)?;
            }
            for row in &data.notes {
                book.index(&nodes[field(row, "node_id")?])?;
            }
            require(
                model::rows(&book.view.db, "PRAGMA foreign_key_check", [])?.is_empty(),
                "跨库副本外键校验失败",
            )?;
            copied.target_fingerprint = fingerprint(&book.transfer_snapshot(&root)?)?;
            #[cfg(test)]
            tests::crash_point("target-before-receipt");
            write_receipt(book, TARGET, request, &copied)?;
            #[cfg(test)]
            tests::crash_point("target-after-receipt");
            Ok(copied.clone())
        })
    }
    pub fn verify_transfer_target(
        &self,
        request: &TransferRequest,
        copied: &TransferReceipt,
    ) -> ReadResult<bool> {
        self.transfer_identity(&request.target_notebook_id)?;
        input(
            copied.identity == fingerprint(request)?,
            "转移回执身份不匹配",
        )?;
        let data = self.transfer_snapshot(&copied.result.id)?;
        if fingerprint(&data)? != copied.target_fingerprint {
            return Ok(false);
        }
        for asset in &data.assets {
            self.view.asset(field(asset, "hash")?)?;
        }
        Ok(true)
    }
    /// Called only while both leases are held, after verifying the committed target.
    pub fn finish_transfer_move(
        &mut self,
        target: &WritableNotebook,
        request: &TransferRequest,
        copied: &TransferReceipt,
    ) -> ReadResult<TransferResult> {
        request.validate()?;
        self.transfer_identity(&request.notebook_id)?;
        input(
            request.mode == TransferMode::Move && copied.identity == fingerprint(request)?,
            "移动回执身份不匹配",
        )?;
        if let Some(result) = self.completed_transfer(request)? {
            return Ok(result);
        }
        if !target
            .verify_transfer_target(request, copied)
            .unwrap_or(false)
        {
            return Ok(copied.target_changed());
        }
        let result = TransferResult {
            status: TransferStatus::Completed,
            ..copied.result()
        };
        let moved = self.transaction(&request.id, "transfer-move", |book| {
            let data = book.transfer_snapshot(&request.id)?;
            conflict(fingerprint(&data)? == copied.source_fingerprint)?;
            let time = now()?;
            for row in &data.nodes {
                let id = field(row, "id")?;
                if row["deleted_at"].is_null() {
                    let changed = book.view.db.execute(
                        "UPDATE nodes SET deleted_at=?,deleted_by=?,revision=revision+1 WHERE id=? AND revision<?",
                        params![time, request.operation_id, id, SAFE_INTEGER],
                    )?;
                    require(changed == 1, "源节点版本耗尽")?;
                }
                if row["kind"] == "note" {
                    book.index(id)?;
                }
            }
            #[cfg(test)]
            tests::crash_point("source-before-receipt");
            #[derive(Serialize)]
            struct Completed<'a> {
                identity: &'a str,
                result: &'a TransferResult,
            }
            write_receipt(book, SOURCE, request, &Completed {
                identity: &copied.identity,
                result: &result,
            })?;
            #[cfg(test)]
            tests::crash_point("source-after-receipt");
            Ok(result.clone())
        });
        moved.or_else(|error| {
            if matches!(
                error.kind(),
                ReadErrorKind::Conflict | ReadErrorKind::NotFound | ReadErrorKind::InvalidInput
            ) {
                Ok(TransferResult {
                    status: TransferStatus::CopiedSourceChanged,
                    ..copied.result()
                })
            } else {
                Err(error)
            }
        })
    }
}
fn mapped(map: &HashMap<String, String>, value: &Value) -> ReadResult<Value> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    let key = value
        .as_str()
        .ok_or_else(|| ReadError::new(ReadErrorKind::Corrupt, "引用无效"))?;
    Ok(map
        .get(key)
        .ok_or_else(|| ReadError::new(ReadErrorKind::Corrupt, "引用映射缺失"))?
        .clone()
        .into())
}
struct Rewriter<'a> {
    request: &'a TransferRequest,
    nodes: &'a HashMap<String, String>,
    resources: &'a HashMap<String, String>,
    annotations: &'a HashMap<String, String>,
}
impl Rewriter<'_> {
    fn text(&self, text: &str) -> String {
        static RESOURCE: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"(?i)anynote-resource:([a-f0-9-]{36})").unwrap());
        static JSON_RESOURCE: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r#"(?i)("[^"\n]*resourceId"\s*:\s*")([a-f0-9-]{36})(")"#).unwrap()
        });
        static LINK: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"(?i)anynote://notebook/([a-f0-9-]{36})/note/([a-f0-9-]{36})(?:#pdf-annotation-([a-f0-9-]{36}))?").unwrap()
        });
        let text = RESOURCE.replace_all(text, |c: &Captures| {
            self.resources
                .get(&c[1])
                .map(|id| format!("anynote-resource:{id}"))
                .unwrap_or_else(|| c[0].into())
        });
        let text = JSON_RESOURCE.replace_all(&text, |c: &Captures| {
            self.resources
                .get(&c[2])
                .map(|id| format!("{}{id}{}", &c[1], &c[3]))
                .unwrap_or_else(|| c[0].into())
        });
        LINK.replace_all(&text, |c: &Captures| {
            if c[1] == self.request.notebook_id
                && let Some(id) = self.nodes.get(&c[2])
            {
                let anchor = c
                    .get(3)
                    .map(|m| {
                        format!(
                            "#pdf-annotation-{}",
                            self.annotations
                                .get(m.as_str())
                                .map(String::as_str)
                                .unwrap_or(m.as_str())
                        )
                    })
                    .unwrap_or_default();
                return format!(
                    "anynote://notebook/{}/note/{id}{anchor}",
                    self.request.target_notebook_id
                );
            }
            c[0].into()
        })
        .into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::Path, process::Command};
    pub(super) fn crash_point(phase: &str) {
        if std::env::var("ANYNOTE_RM06_CRASH").as_deref() == Ok(phase) {
            std::process::exit(73);
        }
    }
    fn fixture() -> (tempfile::TempDir, WriteQueue, TransferRequest) {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm06");
        fs::create_dir_all(&root).unwrap();
        let dir = tempfile::tempdir_in(root.canonicalize().unwrap()).unwrap();
        let q = WriteQueue::open(dir.path(), 1).unwrap();
        let request = q
            .submit(|s| {
                let a = s.create_notebook("源")?.id;
                let b = s.create_notebook("目标")?.id;
                let resource = new_id();
                let n = s.notebook(&a)?.create_node(
                    &CreateNode::note("测试", format!("![资源](anynote-resource:{resource})")),
                    &[ResourceWrite::bytes(
                        resource,
                        "image".into(),
                        "image/png".into(),
                        vec![1, 2, 3],
                    )?],
                )?;
                Ok(TransferRequest {
                    notebook_id: a,
                    target_notebook_id: b,
                    id: n.node.id,
                    mode: TransferMode::Move,
                    target_parent_id: None,
                    operation_id: new_id(),
                    expected_revision: 1,
                })
            })
            .unwrap()
            .wait()
            .unwrap();
        (dir, q, request)
    }
    fn complete(q: &WriteQueue, p: &TransferRequest) -> ReadResult<TransferResult> {
        let p = p.clone();
        q.submit(move |s| {
            s.with_pair(&p.notebook_id, &p.target_notebook_id, |a, b| {
                if let Some(r) = a.completed_transfer(&p)? {
                    return Ok(r);
                }
                let copied = b.copy_transfer(a, &p)?;
                a.finish_transfer_move(b, &p, &copied)
            })
        })?
        .wait()
    }
    #[test]
    #[ignore = "spawned with isolated fixture and process interruption phase"]
    fn crash_child() {
        let root = std::env::var("ANYNOTE_RM06_ROOT").unwrap();
        let p: TransferRequest =
            serde_json::from_slice(&fs::read(Path::new(&root).join("request.json")).unwrap())
                .unwrap();
        let q = WriteQueue::open(Path::new(&root), 1).unwrap();
        complete(&q, &p).unwrap();
        panic!("crash point not reached");
    }
    #[test]
    fn process_exit_inside_either_transaction_rolls_back_and_retries_once() {
        for phase in [
            "target-before-receipt",
            "target-after-receipt",
            "source-before-receipt",
            "source-after-receipt",
        ] {
            let (dir, q, p) = fixture();
            drop(q);
            fs::write(
                dir.path().join("request.json"),
                serde_json::to_vec(&p).unwrap(),
            )
            .unwrap();
            let output = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "notebook::transfer::tests::crash_child",
                    "--ignored",
                    "--nocapture",
                ])
                .env("ANYNOTE_RM06_ROOT", dir.path())
                .env("ANYNOTE_RM06_CRASH", phase)
                .output()
                .unwrap();
            assert_eq!(
                output.status.code(),
                Some(73),
                "{phase}: {} {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            let q = WriteQueue::open(dir.path(), 1).unwrap();
            let p2 = p.clone();
            let source_phase = phase.starts_with("source");
            q.submit(move |s| {
                s.with_pair(&p2.notebook_id, &p2.target_notebook_id, |a, b| {
                    assert!(a.read().note(&p2.id)?.node.deleted_at.is_none());
                    assert!(a.completed_transfer(&p2)?.is_none());
                    assert_eq!(b.read().nodes()?.len(), usize::from(source_phase));
                    assert_eq!(
                        receipt::<TransferReceipt>(b, TARGET, &p2)?.is_some(),
                        source_phase
                    );
                    Ok(())
                })
            })
            .unwrap()
            .wait()
            .unwrap();
            let result = complete(&q, &p).unwrap();
            assert_eq!(result.status, TransferStatus::Completed);
            assert_eq!(complete(&q, &p).unwrap(), result);
        }
    }
    #[test]
    fn asset_failure_and_sql_failure_never_publish_partial_target_or_delete_source() {
        for resource_failure in [true, false] {
            let (_dir, q, p) = fixture();
            let p2 = p.clone();
            q.submit(move |s|s.with_pair(&p2.notebook_id,&p2.target_notebook_id,|a,b| {
                if resource_failure { fs::create_dir(b.view.root.join("assets"))?; fs::write(b.view.root.join("assets/sha256"),b"not a directory")?; }
                else { b.view.db.execute_batch("CREATE TEMP TRIGGER reject_copy BEFORE INSERT ON extension_data WHEN NEW.extension_id='anynote.core.transfer-target' BEGIN SELECT RAISE(ABORT,'injected target commit failure'); END;")?; }
                assert!(b.copy_transfer(a,&p2).is_err());
                assert!(b.read().nodes()?.is_empty());
                assert!(receipt::<TransferReceipt>(b,TARGET,&p2)?.is_none());
                assert!(a.read().note(&p2.id)?.node.deleted_at.is_none());
                if resource_failure {fs::remove_file(b.view.root.join("assets/sha256"))?;}
                else {b.view.db.execute_batch("DROP TRIGGER reject_copy")?;}
                Ok(())
            })).unwrap().wait().unwrap();
            assert_eq!(complete(&q, &p).unwrap().status, TransferStatus::Completed);
        }
    }
    #[test]
    fn target_byte_damage_on_live_lease_stops_move() {
        let (_dir, q, p) = fixture();
        q.submit(move |s| {
            s.with_pair(&p.notebook_id, &p.target_notebook_id, |a, b| {
                let copy = b.copy_transfer(a, &p)?;
                let hash: String =
                    b.view
                        .db
                        .query_row("SELECT hash FROM assets LIMIT 1", [], |r| r.get(0))?;
                fs::write(
                    b.view
                        .root
                        .join(format!("assets/sha256/{}/{hash}.bin", &hash[..2])),
                    b"bad",
                )?;
                assert_eq!(
                    a.finish_transfer_move(b, &p, &copy)?.status,
                    TransferStatus::CopiedTargetChanged
                );
                assert!(a.read().note(&p.id)?.node.deleted_at.is_none());
                Ok(())
            })
        })
        .unwrap()
        .wait()
        .unwrap();
    }
    #[test]
    fn node_record_and_asset_budgets_are_enforced_before_target_publication() {
        let (_dir, q, p) = fixture();
        q.submit(move |s| {
            s.with_pair(&p.notebook_id, &p.target_notebook_id, |a, b| {
                a.view.db.execute("UPDATE assets SET size=?", [MAX_BYTES as i64 + 1])?;
                assert!(b.copy_transfer(a, &p).is_err());
                assert!(b.read().nodes()?.is_empty());
                a.view.db.execute("UPDATE assets SET size=3", [])?;
                assert!(model::rows_bounded(&a.view.db, "SELECT * FROM note_revisions", [], &mut 10).is_err());
                let mut folder = CreateNode::note("目录", "");
                folder.kind = NodeKind::Folder;
                let root = a.create_node(&folder, &[])?.node.id;
                let mut request = p.clone();
                request.id = root.clone();
                let tx = a.view.db.unchecked_transaction()?;
                for i in 0..MAX_NODES {
                    tx.execute(
                        "INSERT INTO nodes(id,parent_id,kind,title,sort_key,created_at,updated_at) VALUES(?,?,'folder','child',?,1,1)",
                        params![new_id(), root, i as i64],
                    )?;
                }
                tx.commit()?;
                assert!(b.copy_transfer(a, &request).is_err());
                assert!(b.read().nodes()?.is_empty());
                Ok(())
            })
        }).unwrap().wait().unwrap();
    }
}
