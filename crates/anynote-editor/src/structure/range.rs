use super::*;

impl Structure<'_> {
    /// Replace a logical range across nested blocks. Table cell boundaries stay
    /// intact; prose endpoints join in the first endpoint's container.
    pub fn replace_between(
        &self,
        start: (&[usize], usize),
        end: (&[usize], usize),
        text: &str,
        marks: Marks,
        millis: u64,
    ) -> StructureResult<Transaction> {
        if start.0 >= end.0 {
            return Err(StructureError::InvalidPath);
        }
        let first = self.get(start.0)?;
        let last = self.get(end.0)?;
        let editable =
            |node: &StructureNode| node.is_inline() || matches!(node.kind, NodeKind::Code { .. });
        if !editable(first) || !editable(last) {
            return Err(StructureError::Unsupported);
        }
        byte_offset(&first.text(), start.1, TextUnit::Utf8)?;
        byte_offset(&last.text(), end.1, TextUnit::Utf8)?;
        let joins = matches!(first.kind, NodeKind::Paragraph | NodeKind::Heading(_))
            && matches!(last.kind, NodeKind::Paragraph | NodeKind::Heading(_));
        let suffix = joins.then(|| cut_runs(&last.runs, end.1).1);
        let mut root = self.root.clone();
        trim(&mut root, &mut Vec::new(), start, end, false, joins);
        let first = root.node_mut(start.0)?;
        if matches!(first.kind, NodeKind::Code { .. }) {
            first.code.push_str(text);
        } else {
            first.runs.push(Run::literal(text.into(), marks));
            first.runs.extend(suffix.unwrap_or_default());
            first.runs = normalize(std::mem::take(&mut first.runs));
        }
        self.finish(
            root,
            Some(Caret {
                path: start.0.to_vec(),
                offset: start.1 + text.len(),
            }),
            millis,
        )
    }
}

fn trim(
    node: &mut StructureNode,
    path: &mut Vec<usize>,
    start: (&[usize], usize),
    end: (&[usize], usize),
    in_table: bool,
    joins: bool,
) -> bool {
    if path.as_slice() == start.0 {
        if matches!(node.kind, NodeKind::Code { .. }) {
            node.code.truncate(start.1);
        } else {
            node.runs = cut_runs(&node.runs, start.1).0;
        }
        return true;
    }
    if path.as_slice() == end.0 {
        if joins {
            return false;
        }
        if matches!(node.kind, NodeKind::Code { .. }) {
            node.code = node.code[end.1..].into();
        } else {
            node.runs = cut_runs(&node.runs, end.1).1;
        }
        return true;
    }
    let contains_endpoint = start.0.starts_with(path) || end.0.starts_with(path);
    let selected = start.0 < path.as_slice() && path.as_slice() < end.0;
    if !contains_endpoint && selected && !in_table {
        return false;
    }
    if node.children.is_empty() {
        if selected {
            node.runs.clear();
            node.code.clear();
        }
        return true;
    }
    // Keep rectangular rows when a range enters or leaves a table. A table
    // wholly inside the selection was already removed above.
    let in_table = in_table || node.kind == NodeKind::Table;
    let mut ix = 0;
    node.children.retain_mut(|child| {
        path.push(ix);
        ix += 1;
        let keep = trim(child, path, start, end, in_table, joins);
        path.pop();
        keep
    });
    !node.children.is_empty() || path.is_empty()
}
