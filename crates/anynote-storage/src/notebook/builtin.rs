use super::{
    write::{SAFE_INTEGER, conflict, input, text_limit},
    *,
};
use anynote_core::builtin::NotebookPreferences;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const NAMESPACE: &str = "anynote.builtin";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BuiltinValue {
    revision: i64,
    value: Value,
}
impl BuiltinValue {
    pub fn revision(&self) -> i64 {
        self.revision
    }
    pub fn value(&self) -> &Value {
        &self.value
    }
}

impl ReadonlyNotebook {
    pub fn ensure_builtin_migrated(&self, key: &str) -> ReadResult<()> {
        if self.builtin_value(key)?.is_some() {
            return Ok(());
        }
        let namespace = match key {
            "reading.session" => "garden.session",
            "notebook.preferences" => "garden.preferences",
            _ => return Err(ReadError::invalid_input("未知内置状态")),
        };
        let exists: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM extension_data WHERE extension_id=?)",
            [namespace],
            |row| row.get(0),
        )?;
        input(
            !exists,
            "旧阅读状态尚未通过 checksum 与版本转换，不能使用默认值覆盖",
        )
    }
    pub fn builtin_value(&self, key: &str) -> ReadResult<Option<BuiltinValue>> {
        self.check_path()?;
        self.db.query_row(
            "SELECT revision,value_json,schema_version FROM extension_data WHERE extension_id=? AND key=?",
            params![NAMESPACE,key], |r| Ok((r.get::<_,i64>(0)?, r.get::<_,String>(1)?, r.get::<_,i64>(2)?))
        ).optional()?.map(|(revision, raw, version)| {
            input(version == 1, "内置状态版本不受支持")?;
            Ok(BuiltinValue { revision, value: serde_json::from_str(&raw)? })
        }).transpose()
    }
    pub fn builtin_preferences(&self) -> ReadResult<(i64, NotebookPreferences)> {
        match self.builtin_value("notebook.preferences")? {
            Some(row) => {
                let p: NotebookPreferences = serde_json::from_value(row.value)?;
                input(p.is_valid(), "阅读目标无效")?;
                Ok((row.revision, p))
            }
            None => {
                let mut p = NotebookPreferences::default();
                for (namespace, key, target) in [
                    ("anynote.whiteboard", "enabled", &mut p.whiteboard),
                    ("anynote.video", "enabled", &mut p.video),
                    ("anynote.html-import", "enabled", &mut p.html),
                    ("anynote.video", "remoteEmbed", &mut p.remote_embed),
                ] {
                    let raw: Option<(String, i64)> = self
                        .db
                        .query_row(
                            "SELECT value_json,schema_version FROM extension_data WHERE extension_id=? AND key=?",
                            params![namespace, key],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )
                        .optional()?;
                    if let Some((raw, version)) = raw {
                        input(version == 1, "旧媒体偏好版本不受支持")?;
                        *target = serde_json::from_str(&raw)?;
                    }
                }
                Ok((0, p))
            }
        }
    }
    pub fn builtin_receipt(&self, operation: &str, fingerprint: &str) -> ReadResult<Option<Note>> {
        uuid(operation)?;
        let Some(row) = self.builtin_value(&format!("reading.receipt.{operation}"))? else {
            return Ok(None);
        };
        conflict(row.value["fingerprint"] == fingerprint)?;
        Ok(Some(serde_json::from_value(row.value["note"].clone())?))
    }
}

impl WritableNotebook {
    pub fn set_builtin_preferences(
        &mut self,
        expected: i64,
        preferences: &NotebookPreferences,
    ) -> ReadResult<i64> {
        input(
            preferences.is_valid(),
            "阅读目标应为 1–100，标题不能超过 80 个 UTF-16 单元",
        )?;
        self.transaction("notebook.preferences", "builtin-settings", |book| {
            book.read()
                .ensure_builtin_migrated("notebook.preferences")?;
            book.put_builtin(
                "notebook.preferences",
                expected,
                &serde_json::to_value(preferences)?,
            )
        })
    }
    pub(crate) fn put_builtin(&self, key: &str, expected: i64, value: &Value) -> ReadResult<i64> {
        input((0..SAFE_INTEGER).contains(&expected), "设置版本无效")?;
        let current = self.view.builtin_value(key)?.map_or(0, |r| r.revision);
        conflict(current == expected)?;
        let raw = serde_json::to_string(value)?;
        input(raw.len() <= 16 * 1024 * 1024, "内置数据过大")?;
        self.view.db.execute("INSERT INTO extension_data(extension_id,key,value_json) VALUES(?,?,?) ON CONFLICT(extension_id,key) DO UPDATE SET value_json=excluded.value_json,revision=revision+1",params![NAMESPACE,key,raw])?;
        Ok(expected + 1)
    }
    /// The receipt, body and optional notebook counter publish in the same transaction.
    pub fn commit_reading(
        &mut self,
        request: &anynote_core::builtin::ReadingRequest,
        fingerprint: &str,
        body: &str,
        state: Option<(i64, Value)>,
    ) -> ReadResult<Note> {
        let operation = request.operation().to_string();
        if let Some(note) = self.view.builtin_receipt(&operation, fingerprint)? {
            return Ok(note);
        }
        text_limit(body, 0, 2_000_000)?;
        self.transaction(&operation, "builtin-reading", |book| {
            let base = request.base();
            input(
                base.id().notebook().to_string() == book.read().metadata().id,
                "阅读命令的笔记本不匹配",
            )?;
            let note = book.active(&base.id().note().to_string(), Some(base.revision()))?;
            conflict(note.head_revision_id.as_deref() == Some(&base.head().to_string()))?;
            input(
                note.node.note_type == Some(NoteType::Markdown),
                "仅支持 Markdown 笔记",
            )?;
            let saved = if matches!(
                request.command(),
                anynote_core::builtin::ReadingCommand::CreateRecord
            ) {
                let input = CreateNode::note("阅读记录", body);
                book.validate_create(&input, &[])?;
                book.create_inside(&uuid::Uuid::new_v4().to_string(), &input, &[])?
            } else if body == note.body {
                note
            } else {
                book.save_inside(
                    &note,
                    &NotePatch {
                        body: Some(body.into()),
                        ..Default::default()
                    },
                    &[],
                    "builtin-reading",
                )?
            };
            if let Some((revision, value)) = &state {
                book.put_builtin("reading.session", *revision, value)?;
            }
            book.put_builtin(
                &format!("reading.receipt.{operation}"),
                0,
                &serde_json::json!({"fingerprint":fingerprint,"note":saved}),
            )?;
            Ok(saved)
        })
    }
    pub fn import_builtin_state(&mut self, key: &str, value: &Value) -> ReadResult<()> {
        input(
            matches!(key, "reading.session" | "notebook.preferences"),
            "未知内置状态",
        )?;
        self.transaction(key, "builtin-migration", |book| {
            book.put_builtin(key, 0, value)
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anynote_core::{builtin::*, document_session::*};
    use uuid::Uuid;
    #[test]
    fn unconverted_legacy_state_cannot_be_replaced_by_defaults() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm20");
        std::fs::create_dir_all(&root).unwrap();
        let dir = tempfile::tempdir_in(root.canonicalize().unwrap()).unwrap();
        let queue = WriteQueue::open(dir.path(), 1).unwrap();
        queue
            .submit(|catalog| {
                let id = catalog.create_notebook("Legacy")?.id;
                let book = catalog.notebook(&id)?;
                for (namespace, key) in [
                    ("garden.session", "script:state"),
                    ("garden.preferences", "settings:form"),
                ] {
                    book.view.db.execute(
                        "INSERT INTO extension_data(extension_id,key,value_json) VALUES(?,?,?)",
                        params![namespace, key, "{\"unknown\":true}"],
                    )?;
                }
                assert!(
                    book.read()
                        .ensure_builtin_migrated("reading.session")
                        .is_err()
                );
                assert!(
                    book.read()
                        .ensure_builtin_migrated("notebook.preferences")
                        .is_err()
                );
                assert!(
                    book.set_builtin_preferences(0, &NotebookPreferences::default())
                        .is_err()
                );
                assert!(book.read().builtin_value("notebook.preferences")?.is_none());
                book.import_builtin_state("reading.session", &serde_json::json!({"visits":5}))?;
                book.read().ensure_builtin_migrated("reading.session")?;
                assert_eq!(
                    book.read()
                        .extension_records()?
                        .iter()
                        .filter(|r| r.extension_id.starts_with("garden."))
                        .count(),
                    2
                );
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
    }
    #[test]
    fn receipt_failure_rolls_back_body_counter_history_and_sequence() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm20");
        std::fs::create_dir_all(&root).unwrap();
        let dir = tempfile::tempdir_in(root.canonicalize().unwrap()).unwrap();
        let queue = WriteQueue::open(dir.path(), 1).unwrap();
        queue.submit(|catalog| {
            let id = catalog.create_notebook("Atomic")?.id;
            let book = catalog.notebook(&id)?;
            let note = book.create_node(&CreateNode::note("Note", "before"), &[])?;
            let snapshot = DocumentSnapshot::new(DocumentId::new(Uuid::parse_str(&id).unwrap(), Uuid::parse_str(&note.node.id).unwrap()), note.node.revision, Uuid::parse_str(note.head_revision_id.as_ref().unwrap()).unwrap(), DocumentContent::new("Note".into(), "before".into(), vec![], false));
            let request = ReadingRequest::new(Uuid::new_v4(), snapshot, ReadingCommand::RecordSession);
            let seq = book.read().metadata().content_seq;
            book.view.db.execute_batch("CREATE TEMP TRIGGER fail_receipt BEFORE INSERT ON extension_data WHEN NEW.key LIKE 'reading.receipt.%' BEGIN SELECT RAISE(ABORT,'injected'); END;")?;
            assert!(book.commit_reading(&request, "fingerprint", "after", Some((0, serde_json::json!({"visits":1})))).is_err());
            assert_eq!(book.read().note(&note.node.id)?.body, "before");
            assert!(book.read().builtin_value("reading.session")?.is_none());
            assert!(book.read().builtin_receipt(&request.operation().to_string(), "fingerprint")?.is_none());
            assert_eq!(book.read().history(&note.node.id)?.len(), 1);
            assert_eq!(book.read().metadata().content_seq, seq);
            book.view.db.execute_batch("DROP TRIGGER fail_receipt;")?;
            let saved = book.commit_reading(&request, "fingerprint", "after", Some((0, serde_json::json!({"visits":1}))))?;
            assert_eq!(saved.body, "after");
            assert_eq!(book.read().builtin_value("reading.session")?.unwrap().value()["visits"], 1);
            Ok(())
        }).unwrap().wait().unwrap();
    }
}
