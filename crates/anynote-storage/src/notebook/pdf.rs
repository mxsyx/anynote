use super::{
    write::{conflict, input},
    *,
};
use anynote_core::{asset::AssetScope, pdf::*};
use rusqlite::{OptionalExtension, params};
use uuid::Uuid;

impl ReadonlyNotebook {
    pub fn pdf_scope(&self, scope: &AssetScope, hash: &str) -> ReadResult<bool> {
        input(
            scope.document().notebook().to_string() == self.metadata().id,
            "PDF 笔记本不匹配",
        )?;
        let note = self.note(&scope.document().note().to_string())?;
        input(
            note.node.note_type == Some(NoteType::Pdf) && note.node.deleted_at.is_none(),
            "PDF 笔记不可用",
        )?;
        input(
            note.primary_resource_id.as_deref() == Some(&scope.resource().to_string()),
            "PDF 主资源不匹配",
        )?;
        let resource = self.resource(
            &scope.resource().to_string(),
            Some(ResourceScope::note(&note.node.id).with_revision(&scope.revision().to_string())),
        )?;
        conflict(resource.info().hash == hash)?;
        input(
            resource.info().mime == "application/pdf",
            "PDF 资源类型无效",
        )?;
        Ok(note.head_revision_id.as_deref() == Some(&scope.revision().to_string()))
    }
    pub fn pdf_coverage(&self, note: &str, hash: &str) -> ReadResult<Option<IndexCoverage>> {
        let value: Option<String> = self.db.query_row("SELECT value_json FROM extension_data WHERE extension_id='anynote.pdf.index' AND key=?", [format!("note.{note}")], |r| r.get(0)).optional()?;
        value
            .map(|raw| {
                let v: serde_json::Value = serde_json::from_str(&raw)?;
                if v["hash"] != hash {
                    return Ok(None);
                }
                Ok(Some(serde_json::from_value(v["coverage"].clone())?))
            })
            .transpose()
            .map(Option::flatten)
    }
}
impl WritableNotebook {
    pub fn execute_pdf(&mut self, command: PdfCommand) -> ReadResult<PdfReply> {
        let (scope, hash) = match &command {
            PdfCommand::Load { scope, hash }
            | PdfCommand::Annotate { scope, hash, .. }
            | PdfCommand::Delete { scope, hash, .. }
            | PdfCommand::Reanchor { scope, hash }
            | PdfCommand::ReadingNote { scope, hash, .. } => (scope, hash),
            _ => return Err(ReadError::invalid_input("PDF 命令无效")),
        };
        let current = self.read().pdf_scope(scope, hash)?;
        let id = scope.document().note().to_string();
        if !matches!(
            command,
            PdfCommand::Load { .. } | PdfCommand::ReadingNote { .. }
        ) {
            conflict(current)?;
        }
        match &command {
            PdfCommand::Load { .. } => {
                let annotations = self
                    .read()
                    .annotations(&id, false)?
                    .into_iter()
                    .map(|a| {
                        Ok(PdfAnnotation::new(
                            Uuid::parse_str(&a.id)
                                .map_err(|_| ReadError::invalid_input("批注 ID 无效"))?,
                            a.target_asset_hash,
                            AnnotationDraft::new(
                                a.page as u16,
                                serde_json::from_value(a.selector)?,
                                a.quote,
                                a.body,
                            ),
                        ))
                    })
                    .collect::<ReadResult<_>>()?;
                Ok(PdfReply::Loaded {
                    annotations,
                    current,
                    coverage: self.read().pdf_coverage(&id, hash)?,
                })
            }
            PdfCommand::Annotate { draft, .. } => {
                input(draft.is_valid(), "PDF 选区或批注无效")?;
                let annotation = self.add_annotation(
                    &id,
                    &AnnotationInput {
                        asset_hash: hash.clone(),
                        page: i64::from(draft.page()),
                        selector: draft
                            .rectangles()
                            .iter()
                            .map(|r| Rectangle {
                                x: r.x,
                                y: r.y,
                                width: r.width,
                                height: r.height,
                            })
                            .collect(),
                        quote: draft.quote().into(),
                        body: draft.body().into(),
                        color: "yellow".into(),
                    },
                )?;
                Ok(PdfReply::Annotation {
                    id: Uuid::parse_str(&annotation).unwrap(),
                })
            }
            PdfCommand::Delete { annotation, .. } => {
                input(
                    self.read()
                        .annotations(&id, false)?
                        .iter()
                        .any(|a| a.id == annotation.to_string()),
                    "批注不属于此笔记",
                )?;
                self.delete_annotation(&annotation.to_string())?;
                Ok(PdfReply::Ack)
            }
            PdfCommand::Reanchor { .. } => {
                self.reanchor_annotations(&id, hash)?;
                Ok(PdfReply::Ack)
            }
            PdfCommand::ReadingNote {
                draft, annotation, ..
            } => {
                input(draft.is_valid(), "PDF 选区无效")?;
                if let Some(annotation) = annotation {
                    input(
                        self.read().annotations(&id, false)?.iter().any(|a| {
                            a.id == annotation.to_string()
                                && a.target_asset_hash == *hash
                                && a.page == i64::from(draft.page())
                        }),
                        "批注回链无效",
                    )?;
                }
                let note = self.create_node(
                    &CreateNode::note(
                        "阅读笔记",
                        reading_body(scope.document(), draft, *annotation),
                    ),
                    &[],
                )?;
                Ok(PdfReply::Note {
                    document: anynote_core::document_session::DocumentId::new(
                        scope.document().notebook(),
                        Uuid::parse_str(&note.node.id).unwrap(),
                    ),
                })
            }
            _ => unreachable!(),
        }
    }
    pub fn publish_pdf_index(
        &mut self,
        scope: &AssetScope,
        hash: &str,
        body: &str,
        coverage: &IndexCoverage,
    ) -> ReadResult<()> {
        conflict(self.read().pdf_scope(scope, hash)?)?;
        let id = scope.document().note().to_string();
        self.transaction(&id, "pdf-index", |book| {
            book.view.db.execute("INSERT INTO note_text(note_id,asset_hash,body) VALUES(?,?,?) ON CONFLICT(note_id) DO UPDATE SET asset_hash=excluded.asset_hash,body=excluded.body", params![id,hash,body])?;
            book.view.db.execute("INSERT INTO extension_data(extension_id,key,value_json) VALUES('anynote.pdf.index',?,?) ON CONFLICT(extension_id,key) DO UPDATE SET value_json=excluded.value_json,revision=revision+1", params![format!("note.{id}"),serde_json::to_string(&serde_json::json!({"hash":hash,"coverage":coverage}))?])?;
            book.index(&id)
        })
    }
}
