use anynote_core::document_session::DocumentId;

pub(super) fn internal_link(url: &str) -> Option<(DocumentId, Option<String>)> {
    let path = url.strip_prefix("anynote://notebook/")?;
    let (book, rest) = path.split_once("/note/")?;
    let (note, anchor) = rest
        .split_once('#')
        .map_or((rest, None), |(id, anchor)| (id, Some(anchor.to_owned())));
    Some((
        DocumentId::new(book.parse().ok()?, note.parse().ok()?),
        anchor,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn internal_link_keeps_identity_and_anchor() {
        let book = uuid::Uuid::new_v4();
        let note = uuid::Uuid::new_v4();
        assert_eq!(
            internal_link(&format!("anynote://notebook/{book}/note/{note}#标题")),
            Some((DocumentId::new(book, note), Some("标题".into())))
        );
        assert!(internal_link("anynote://notebook/bad/note/bad").is_none());
    }
}
