//! Lossless video fields use the document's normal transaction and undo history.
use crate::{
    model::{BlockId, Document},
    source::SourceError,
    transaction::{EditKind, Patch, Transaction},
};
use anynote_core::{protocol::rich::Content, video::VideoCard};
use serde_json::Value;
use uuid::Uuid;

pub fn read(document: &Document, id: BlockId) -> Option<(VideoCard, Option<String>, Option<Uuid>)> {
    let Content::Directive(d) = document.block(id)?.parsed().content() else {
        return None;
    };
    if d.attrs().get("type")? != "core.video" || d.attrs().get("version")? != "1" {
        return None;
    }
    let data = d.data()?;
    let card: VideoCard = serde_json::from_value(data.clone()).ok()?;
    if !card.is_valid() {
        return None;
    }
    let title = data
        .get("title")
        .and_then(Value::as_str)
        .map(|s| s.chars().take(240).collect());
    let thumbnail = data
        .get("thumbnailResourceId")
        .and_then(Value::as_str)
        .and_then(|s| Uuid::parse_str(s).ok());
    Some((card, title, thumbnail))
}
pub fn insert(card: &VideoCard) -> String {
    format!(
        ":::anynote{{type=\"core.video\" version=\"1\" id=\"{}\"}}\n{}\n:::\n",
        Uuid::new_v4(),
        serde_json::to_string(card).unwrap()
    )
}
pub fn metadata(
    document: &Document,
    id: BlockId,
    generation: u64,
    title: Option<&str>,
    thumbnail: Option<Uuid>,
    millis: u64,
    fetched_at: u64,
) -> Result<Transaction, SourceError> {
    if generation != document.generation() {
        return Err(SourceError::Stale);
    }
    read(document, id).ok_or(SourceError::InvalidDirective)?;
    let span = document.block(id).ok_or(SourceError::Stale)?.span();
    let source = &document.source()[span.clone()];
    let mut local = Document::new(source.into());
    let id = local.blocks()[0].id();
    if let Some(title) = title {
        local.set_directive_field(
            local.generation(),
            id,
            "title",
            Value::String(title.chars().take(240).collect()),
        )?;
    }
    if let Some(thumbnail) = thumbnail {
        local.set_directive_field(
            local.generation(),
            id,
            "thumbnailResourceId",
            Value::String(thumbnail.to_string()),
        )?;
    }
    local.set_directive_field(local.generation(), id, "fetchedAt", fetched_at.into())?;
    Ok(Transaction::new(
        generation,
        vec![Patch::new(span, source, local.source())],
        EditKind::Format,
        millis,
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{history::HistoryBudget, transaction::Editor};
    #[test]
    fn metadata_preserves_unknown_fields_and_rejects_late_results() {
        let source = ":::anynote{type=\"core.video\" version=\"1\" id=\"video\" extra=\"keep\"}\n{\"provider\":\"vimeo\",\"url\":\"https://vimeo.com/12345678\",\"videoId\":\"12345678\",\"future\":{\"x\":1}}\n:::\n";
        let mut editor = Editor::new(Document::new(source.into()), HistoryBudget::default());
        let id = editor.document().blocks()[0].id();
        let tx = metadata(editor.document(), id, 0, Some("Title"), None, 0, 123).unwrap();
        editor.apply(tx).unwrap();
        assert!(editor.document().source().contains("\"future\""));
        assert!(editor.document().source().contains("extra=\"keep\""));
        assert!(metadata(editor.document(), id, 0, Some("late"), None, 1, 124).is_err());
        editor.undo().unwrap();
        assert_eq!(editor.document().source(), source);
    }
}
