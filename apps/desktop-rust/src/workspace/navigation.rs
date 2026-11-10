use anynote_core::document_session::DocumentId;

#[derive(Default)]
pub(super) struct Navigation {
    pub tabs: Vec<(DocumentId, String)>,
    pub current: Option<DocumentId>,
    back: Vec<DocumentId>,
    forward: Vec<DocumentId>,
}
impl Navigation {
    pub fn visit(&mut self, id: DocumentId, title: String, record: bool) {
        if self.current.as_ref() != Some(&id) {
            if record {
                if let Some(previous) = self.current.take() {
                    self.back.push(previous);
                }
                if self.back.len() > 100 {
                    self.back.remove(0);
                }
                self.forward.clear();
            } else if self.back.last() == Some(&id) {
                self.back.pop();
                if let Some(previous) = self.current.take() {
                    self.forward.push(previous);
                }
            } else if self.forward.last() == Some(&id) {
                self.forward.pop();
                if let Some(previous) = self.current.take() {
                    self.back.push(previous);
                }
            }
        }
        if !self.tabs.iter().any(|(key, _)| key == &id) {
            if self.tabs.len() == 30 {
                self.tabs.remove(0);
            }
            self.tabs.push((id.clone(), title));
        } else if let Some(tab) = self.tabs.iter_mut().find(|(key, _)| key == &id) {
            tab.1 = title;
        }
        self.current = Some(id);
    }
    pub fn back(&self) -> Option<DocumentId> {
        self.back.last().cloned()
    }
    pub fn forward(&self) -> Option<DocumentId> {
        self.forward.last().cloned()
    }
    pub fn has_back(&self) -> bool {
        !self.back.is_empty()
    }
    pub fn has_forward(&self) -> bool {
        !self.forward.is_empty()
    }
    pub fn close_current(&mut self) -> Option<DocumentId> {
        self.tabs
            .retain(|(id, _)| Some(id) != self.current.as_ref());
        self.current = None;
        self.tabs.last().map(|(id, _)| id.clone())
    }
}
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
    fn failed_navigation_keeps_history_and_new_visit_discards_forward() {
        let book = uuid::Uuid::new_v4();
        let a = DocumentId::new(book, uuid::Uuid::new_v4());
        let b = DocumentId::new(book, uuid::Uuid::new_v4());
        let c = DocumentId::new(book, uuid::Uuid::new_v4());
        let mut nav = Navigation::default();
        nav.visit(a.clone(), "A".into(), true);
        nav.visit(b.clone(), "B".into(), true);
        assert_eq!(nav.back(), Some(a.clone()));
        assert_eq!(nav.current, Some(b.clone()));
        nav.visit(a.clone(), "A".into(), false);
        assert_eq!(nav.forward(), Some(b));
        nav.visit(c, "C".into(), true);
        assert!(!nav.has_forward());
        assert_eq!(nav.back(), Some(a));
    }
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
