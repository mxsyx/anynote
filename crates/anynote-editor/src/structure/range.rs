use super::*;

impl Structure<'_> {
    /// Replace logical endpoints, preserving unselected atoms and table boundaries.
    pub fn replace_between(
        &self,
        start: (&[usize], usize),
        end: (&[usize], usize),
        text: &str,
        marks: Marks,
        millis: u64,
    ) -> StructureResult<Transaction> {
        let (mut root, mut caret) = self.trim_range(start, end)?;
        let first = root.node_mut(&caret.path)?;
        if matches!(first.kind, NodeKind::Code { .. }) {
            first.code.insert_str(caret.offset, text);
        } else {
            let (left, right) = cut_runs(&first.runs, caret.offset);
            first.runs = normalize([left, vec![Run::literal(text.into(), marks)], right].concat());
        }
        caret.offset += text.len();
        self.finish(root, Some(caret), millis)
    }

    pub fn paste_between(
        &self,
        start: (&[usize], usize),
        end: (&[usize], usize),
        markdown: &str,
        millis: u64,
    ) -> StructureResult<Transaction> {
        let (root, caret) = self.trim_range(start, end)?;
        let (root, caret) = paste_into(
            root,
            &caret.path,
            caret.offset..caret.offset,
            TextUnit::Utf8,
            markdown,
            Some(end.0),
        )?;
        self.finish(root, Some(caret), millis)
            .map(|tx| tx.with_kind(EditKind::Paste))
    }

    /// Copy a balanced subtree. Partial tables retain their rectangular shape;
    /// cells outside the selected range are empty, never copied inadvertently.
    pub fn copy_between(
        &self,
        start: (&[usize], usize),
        end: (&[usize], usize),
    ) -> StructureResult<String> {
        self.validate_endpoints(start, end)?;
        let mut root = self.root.clone();
        copy_trim(&mut root, &mut Vec::new(), start, end, false);
        Ok(render(&root, self.newline, None)?.text)
    }

    fn validate_endpoints(
        &self,
        start: (&[usize], usize),
        end: (&[usize], usize),
    ) -> StructureResult<()> {
        if start.0 > end.0 || (start.0 == end.0 && start.1 > end.1) {
            return Err(StructureError::InvalidPath);
        }
        for (path, offset) in [start, end] {
            let node = self.get(path)?;
            if matches!(node.kind, NodeKind::Atom | NodeKind::Rule) {
                if offset != 0 && offset != '\u{fffc}'.len_utf8() {
                    return Err(StructureError::InvalidPath);
                }
            } else if node.is_inline() || matches!(node.kind, NodeKind::Code { .. }) {
                byte_offset(&node.text(), offset, TextUnit::Utf8)?;
            } else {
                return Err(StructureError::Unsupported);
            }
        }
        Ok(())
    }

    fn trim_range(
        &self,
        start: (&[usize], usize),
        end: (&[usize], usize),
    ) -> StructureResult<(StructureNode, Caret)> {
        self.validate_endpoints(start, end)?;
        let mut root = self.root.clone();
        let mut start_path = start.0.to_vec();
        let mut end_path = end.0.to_vec();
        let mut start_offset = start.1;
        let mut end_offset = end.1;
        let first_atom = matches!(self.get(start.0)?.kind, NodeKind::Atom | NodeKind::Rule);
        if start.0 == end.0 {
            let node = root.node_mut(start.0)?;
            if first_atom {
                let atom = node.clone();
                *node = StructureNode::paragraph(vec![]);
                if start.1 == end.1 {
                    let (ix, parent) = start_path.split_last().unwrap();
                    let ix = *ix;
                    let insert = if start.1 == 0 { ix + 1 } else { ix };
                    root.node_mut(parent)?.children.insert(insert, atom);
                    if start.1 != 0 {
                        *start_path.last_mut().unwrap() += 1;
                    }
                }
                start_offset = 0;
            } else if matches!(node.kind, NodeKind::Code { .. }) {
                node.code.replace_range(start.1..end.1, "");
            } else {
                let left = cut_runs(&node.runs, start.1).0;
                let right = cut_runs(&node.runs, end.1).1;
                node.runs = normalize([left, right].concat());
            }
        } else {
            // Materialize caret paragraphs around atomic endpoints before trimming.
            // Never split an atom's source bytes or turn a half-selected atom into text.
            if matches!(self.get(end.0)?.kind, NodeKind::Atom | NodeKind::Rule) {
                if end.1 == 0 {
                    let (ix, parent) = end_path.split_last().unwrap();
                    root.node_mut(parent)?
                        .children
                        .insert(*ix, StructureNode::paragraph(vec![]));
                } else {
                    *root.node_mut(&end_path)? = StructureNode::paragraph(vec![]);
                }
                end_offset = 0;
            }
            if first_atom {
                if start.1 == 0 {
                    *root.node_mut(&start_path)? = StructureNode::paragraph(vec![]);
                } else {
                    let (ix, parent) = start_path.split_last().unwrap();
                    let insert = ix + 1;
                    root.node_mut(parent)?
                        .children
                        .insert(insert, StructureNode::paragraph(vec![]));
                    if end_path.starts_with(parent) && end_path[parent.len()] >= insert {
                        end_path[parent.len()] += 1;
                    }
                    *start_path.last_mut().unwrap() = insert;
                }
                start_offset = 0;
            }
            let first = root.node(&start_path).unwrap();
            let last = root.node(&end_path).unwrap();
            let joins = matches!(first.kind, NodeKind::Paragraph | NodeKind::Heading(_))
                && matches!(last.kind, NodeKind::Paragraph | NodeKind::Heading(_));
            let suffix = joins.then(|| cut_runs(&last.runs, end_offset).1);
            trim(
                &mut root,
                &mut Vec::new(),
                (&start_path, start_offset),
                (&end_path, end_offset),
                false,
                joins,
            );
            if let Some(suffix) = suffix {
                let first = root.node_mut(&start_path)?;
                first.runs.extend(suffix);
                first.runs = normalize(std::mem::take(&mut first.runs));
            }
        }
        Ok((
            root,
            Caret {
                path: start_path,
                offset: start_offset,
            },
        ))
    }
}

fn copy_trim(
    node: &mut StructureNode,
    path: &mut Vec<usize>,
    start: (&[usize], usize),
    end: (&[usize], usize),
    in_table: bool,
) -> bool {
    let contains_endpoint = start.0.starts_with(path) || end.0.starts_with(path);
    let outside = !contains_endpoint && (path.as_slice() < start.0 || path.as_slice() > end.0);
    if outside && !in_table {
        return false;
    }
    if node.children.is_empty() {
        if matches!(node.kind, NodeKind::Atom | NodeKind::Rule) {
            return !outside
                && !(path.as_slice() == start.0 && start.1 != 0
                    || path.as_slice() == end.0 && end.1 == 0);
        }
        let text = node.text();
        let a = if outside {
            0
        } else if path.as_slice() == start.0 {
            start.1
        } else {
            0
        };
        let b = if outside {
            0
        } else if path.as_slice() == end.0 {
            end.1
        } else {
            text.len()
        };
        if matches!(node.kind, NodeKind::Code { .. }) {
            node.code = text[a..b].into();
        } else {
            node.runs = cut_runs(&cut_runs(&node.runs, b).0, a).1;
        }
        return true;
    }
    let in_table = in_table || node.kind == NodeKind::Table;
    let mut ix = 0;
    node.children.retain_mut(|child| {
        path.push(ix);
        ix += 1;
        let keep = copy_trim(child, path, start, end, in_table);
        path.pop();
        keep
    });
    !node.children.is_empty() || path.is_empty()
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

pub(super) fn retain_side(
    node: &mut StructureNode,
    path: &[usize],
    offset: usize,
    before: bool,
) -> StructureResult<()> {
    if let Some((&ix, rest)) = path.split_first() {
        let child = node
            .children
            .get_mut(ix)
            .ok_or(StructureError::InvalidPath)?;
        retain_side(child, rest, offset, before)?;
        if before {
            node.children.truncate(ix + 1);
        } else {
            node.children.drain(..ix);
        }
    } else {
        let (left, right) = cut_runs(&node.runs, offset);
        node.runs = if before { left } else { right };
    }
    Ok(())
}
