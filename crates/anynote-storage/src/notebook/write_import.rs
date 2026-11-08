use super::write::{conflict, input};
use super::*;
use anynote_core::protocol::import::{CaptureReceipt, ImportReport, MediaStatus};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;

pub struct ImportRetryOutcome {
    pub index: usize,
    pub resource: Option<ResourceWrite>,
    pub size: u64,
    pub error: Option<String>,
}
#[derive(Serialize)]
pub struct ImportRetryResult {
    pub note: Note,
    pub report: ImportReport,
    pub applied: usize,
    pub skipped: usize,
}
impl WritableNotebook {
    pub fn import_report(&self, id: &str) -> ReadResult<ImportReport> {
        self.view.note(id)?;
        let raw: String = self.view.db.query_row(
            "SELECT report_json FROM import_reports WHERE note_id=?",
            [id],
            |r| r.get(0),
        )?;
        Ok(serde_json::from_str(&raw)?)
    }
    pub fn commit_import(
        &mut self,
        request: &CreateNode,
        resources: &[ResourceWrite],
        report: &ImportReport,
        receipt: Option<&CaptureReceipt>,
    ) -> ReadResult<Note> {
        self.validate_create(request, resources)?;
        input(
            report.budget.valid() && report.media.len() <= 200,
            "导入报告无效",
        )?;
        if let Some(receipt) = receipt {
            uuid(&receipt.capture_id)?;
            input(
                receipt.digest.len() == 64
                    && receipt
                        .digest
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
                "回执摘要无效",
            )?;
            let prior: Option<(String, String)> = self
                .view
                .db
                .query_row(
                    "SELECT digest,note_id FROM capture_receipts WHERE capture_id=?",
                    [&receipt.capture_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if let Some((digest, id)) = prior {
                conflict(digest == receipt.digest)?;
                return self.view.note(&id);
            }
        }
        let id = write::new_id();
        self.transaction(&id, "import", |book| {
            let note = book.create_inside(&id, request, resources)?;
            book.view.db.execute(
                "INSERT INTO import_reports VALUES(?,?)",
                params![id, serde_json::to_string(report)?],
            )?;
            book.pin_original(&note, report)?;
            if let Some(r) = receipt {
                book.view.db.execute(
                    "INSERT INTO capture_receipts SELECT ?,?,?,content_seq+1 FROM notebook_meta",
                    params![r.capture_id, r.digest, id],
                )?;
            }
            Ok(note)
        })
    }
    fn pin_original(&self, note: &Note, report: &ImportReport) -> ReadResult<()> {
        if let Some(original) = &report.original_html {
            uuid(&original.resource_id)?;
            self.view.db.execute("INSERT OR IGNORE INTO revision_resources SELECT ?,id,asset_hash FROM resources WHERE id=?",params![note.head_revision_id,original.resource_id])?;
            let exists:bool=self.view.db.query_row("SELECT EXISTS(SELECT 1 FROM revision_resources WHERE revision_id=? AND resource_id=?)",params![note.head_revision_id,original.resource_id],|r|r.get(0))?;
            input(exists, "原始 HTML 资源缺失")?;
        }
        Ok(())
    }
    /// Re-read under the single writer; preserve edits outside an unchanged placeholder line.
    pub fn retry_import_media(
        &mut self,
        id: &str,
        expected_report: &ImportReport,
        outcomes: Vec<ImportRetryOutcome>,
    ) -> ReadResult<ImportRetryResult> {
        let note = self.view.note(id)?;
        input(
            note.node.deleted_at.is_none() && note.node.note_type == Some(NoteType::Markdown),
            "笔记不可重试",
        )?;
        let mut report = self.import_report(id)?;
        conflict(&report == expected_report)?;
        let mut body = note.body.clone();
        let mut resources = Vec::new();
        let mut skipped = 0;
        let mut seen = std::collections::HashSet::new();
        let mut replacements = Vec::new();
        let protected = anynote_core::protocol::markdown::fenced_code_ranges(&note.body);
        for outcome in outcomes {
            input(seen.insert(outcome.index), "重复媒体结果")?;
            let item = report
                .media
                .get_mut(outcome.index)
                .ok_or_else(|| ReadError::new(ReadErrorKind::InvalidInput, "媒体索引无效"))?;
            input(item.status == MediaStatus::Failed, "媒体状态已变更")?;
            item.retry_count = item.retry_count.saturating_add(1);
            let exact = item.placeholder.as_deref().filter(|line| {
                item.marker
                    .as_ref()
                    .is_some_and(|m| line.contains(&format!("({m})")))
            });
            let matches: Vec<_> = exact
                .map(|line| {
                    note.body
                        .match_indices(line)
                        .filter(|(at, _)| {
                            let start = note.body[..*at].rfind('\n').map_or(0, |n| n + 1);
                            let end = note.body[*at..]
                                .find('\n')
                                .map_or(note.body.len(), |n| at + n);
                            let expected = item
                                .extra
                                .get("placeholderLine")
                                .and_then(|v| v.as_str())
                                .unwrap_or(line);
                            &note.body[start..end] == expected
                                && !protected.iter().any(|r| r.contains(at))
                        })
                        .map(|(at, _)| at)
                        .collect()
                })
                .unwrap_or_default();
            if matches.len() != 1 {
                item.error = Some("引用已修改，未重写".into());
                skipped += 1;
                continue;
            }
            if let Some(resource) = outcome.resource {
                let next_bytes = report
                    .bytes
                    .checked_add(outcome.size)
                    .ok_or_else(|| ReadError::new(ReadErrorKind::InvalidInput, "媒体预算溢出"))?;
                input(
                    next_bytes + report.original_html.as_ref().map_or(0, |o| o.size)
                        <= report.budget.total_bytes,
                    "媒体总预算超限",
                )?;
                replacements.push((
                    matches[0]..matches[0] + exact.unwrap().len(),
                    item.reference(&resource.id),
                ));
                item.resource_id = Some(resource.id.clone());
                item.status = MediaStatus::Localized;
                item.marker = None;
                item.placeholder = None;
                item.extra.remove("placeholderLine");
                item.error = None;
                report.bytes = next_bytes;
                resources.push(resource);
            } else {
                item.error = outcome.error;
            }
        }
        replacements.sort_by_key(|(range, _)| range.start);
        input(
            replacements.windows(2).all(|r| r[0].0.end <= r[1].0.start),
            "媒体占位范围重叠",
        )?;
        for (range, replacement) in replacements.into_iter().rev() {
            body.replace_range(range, &replacement);
        }
        for item in &mut report.media {
            if let Some(placeholder) = &item.placeholder
                && let Some(expected) = item.extra.get("placeholderLine").and_then(|v| v.as_str())
                && note.body.lines().any(|line| line == expected)
                && let Some(at) = body.find(placeholder)
            {
                let start = body[..at].rfind('\n').map_or(0, |n| n + 1);
                let end = body[at..].find('\n').map_or(body.len(), |n| at + n);
                item.extra.insert(
                    "placeholderLine".into(),
                    serde_json::Value::String(body[start..end].into()),
                );
            }
        }
        report.recount();
        let applied = resources.len();
        self.transaction(id, "import-media-retry", |book| {
            let saved = if resources.is_empty() {
                note.clone()
            } else {
                let current = book.view.note(id)?;
                conflict(current.node.revision == note.node.revision)?;
                let saved = book.save_inside(
                    &current,
                    &NotePatch {
                        body: Some(body),
                        ..Default::default()
                    },
                    &resources,
                    "import-media-retry",
                )?;
                book.pin_original(&saved, &report)?;
                saved
            };
            book.view.db.execute(
                "UPDATE import_reports SET report_json=? WHERE note_id=?",
                params![serde_json::to_string(&report)?, id],
            )?;
            Ok(ImportRetryResult {
                note: saved,
                report,
                applied,
                skipped,
            })
        })
    }
}
