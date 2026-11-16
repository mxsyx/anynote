use super::*;

impl DocumentEditor {
    pub(crate) fn headings(&self) -> impl Iterator<Item = (u64, u8, &str)> {
        self.state
            .projection
            .leaves
            .iter()
            .zip(&self.keys)
            .filter_map(|(leaf, key)| {
                if let NodeKind::Heading(level) = leaf.kind {
                    Some((*key, level, leaf.text.as_str()))
                } else {
                    None
                }
            })
    }

    pub(crate) fn focus_heading(&mut self, key: u64, window: &mut Window, cx: &mut Context<Self>) {
        if self.is_composing() || self.source.is_some() {
            return;
        }
        let Some(ix) = self.keys.iter().position(|candidate| *candidate == key) else {
            return;
        };
        let at = self.state.projection.leaves[ix].logical.start;
        let result = self.state.select(at, at);
        self.changed(result, window, cx);
        self.focus.focus(window, cx);
    }

    pub(crate) fn active_heading(&self) -> Option<u64> {
        self.state
            .projection
            .leaves
            .iter()
            .zip(&self.keys)
            .take_while(|(leaf, _)| leaf.logical.start <= self.state.head)
            .filter(|(leaf, _)| matches!(leaf.kind, NodeKind::Heading(_)))
            .map(|(_, key)| *key)
            .last()
    }

    pub(crate) fn has_source_editor(&self) -> bool {
        self.source.is_some()
    }
}
