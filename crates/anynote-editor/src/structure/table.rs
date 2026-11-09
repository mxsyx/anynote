use super::{NodeKind, Structure, StructureError, StructureNode, StructureResult, tree::Caret};
use crate::{
    selection::{Affinity, Position, Selection},
    transaction::Transaction,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CellAddress {
    row: usize,
    column: usize,
}
impl CellAddress {
    pub fn new(row: usize, column: usize) -> Self {
        Self { row, column }
    }
    pub fn row(self) -> usize {
        self.row
    }
    pub fn column(self) -> usize {
        self.column
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CellDirection {
    Next,
    Previous,
    Above,
    Below,
}

impl Structure<'_> {
    /// Insert the table at an inline selection, preserving the paragraph on either side.
    pub fn insert_table(
        &self,
        path: &[usize],
        range: std::ops::Range<usize>,
        unit: crate::selection::TextUnit,
        size: (usize, usize),
        millis: u64,
    ) -> StructureResult<Transaction> {
        let (rows, columns) = size;
        table_budget(rows, columns)?;
        let table = StructureNode::new(NodeKind::Table, (0..rows).map(|_| row(columns)).collect());
        let markdown = super::tree::render(&table, self.newline, None)?.text;
        self.paste(path, range, unit, &markdown, millis)
    }
    /// Paste a rectangular clipboard matrix, growing the current table and committing once.
    /// Values are literal text; callers convert HTML with the existing importer before this seam.
    pub fn paste_cells(
        &self,
        path: &[usize],
        origin: CellAddress,
        values: &[Vec<String>],
        millis: u64,
    ) -> StructureResult<Transaction> {
        let (rows, columns) = self.table_size(path)?;
        validate_cell(rows, columns, origin)?;
        let width = values.first().map_or(0, Vec::len);
        if width == 0 || values.iter().any(|r| r.len() != width) {
            return Err(StructureError::InvalidTable);
        }
        let next_rows = rows.max(
            origin
                .row
                .checked_add(values.len())
                .ok_or(StructureError::Budget)?,
        );
        let next_columns = columns.max(
            origin
                .column
                .checked_add(width)
                .ok_or(StructureError::Budget)?,
        );
        table_budget(next_rows, next_columns)?;
        let mut root = self.root.clone();
        let table = root.node_mut(path)?;
        for r in &mut table.children {
            r.children
                .resize_with(next_columns, || StructureNode::new(NodeKind::Cell, vec![]));
        }
        table.children.resize_with(next_rows, || row(next_columns));
        for (r, values) in values.iter().enumerate() {
            for (c, value) in values.iter().enumerate() {
                let cell = &mut table.children[origin.row + r].children[origin.column + c];
                cell.runs = crate::inline::normalize(vec![crate::inline::Run::literal(
                    value.clone(),
                    crate::inline::Marks::default(),
                )]);
            }
        }
        self.finish(
            root,
            Some(Caret {
                path: [path, &[origin.row, origin.column]].concat(),
                offset: 0,
            }),
            millis,
        )
    }
    pub fn table_size(&self, path: &[usize]) -> StructureResult<(usize, usize)> {
        let node = self.get(path)?;
        if node.kind != NodeKind::Table {
            return Err(StructureError::InvalidTable);
        }
        Ok((
            node.children.len(),
            node.children.first().map_or(0, |r| r.children.len()),
        ))
    }
    pub fn adjacent_cell(
        &self,
        path: &[usize],
        cell: CellAddress,
        direction: CellDirection,
    ) -> StructureResult<Option<CellAddress>> {
        let (rows, columns) = self.table_size(path)?;
        validate_cell(rows, columns, cell)?;
        let flat = cell.row * columns + cell.column;
        Ok(match direction {
            CellDirection::Next if flat + 1 < rows * columns => {
                Some(CellAddress::new((flat + 1) / columns, (flat + 1) % columns))
            }
            CellDirection::Previous if flat > 0 => {
                Some(CellAddress::new((flat - 1) / columns, (flat - 1) % columns))
            }
            CellDirection::Above if cell.row > 0 => {
                Some(CellAddress::new(cell.row - 1, cell.column))
            }
            CellDirection::Below if cell.row + 1 < rows => {
                Some(CellAddress::new(cell.row + 1, cell.column))
            }
            _ => None,
        })
    }
    /// Source range for one cell, including empty cells; rectangular selection stays a view concern.
    pub fn cell_selection(&self, path: &[usize], cell: CellAddress) -> StructureResult<Selection> {
        let (rows, columns) = self.table_size(path)?;
        validate_cell(rows, columns, cell)?;
        let node = self.get(path)?.children[cell.row]
            .children
            .get(cell.column)
            .ok_or(StructureError::InvalidTable)?;
        let span = if let Some(span) = node.span() {
            span
        } else {
            let row = &self.get(path)?.children[cell.row];
            let end = row.span().ok_or(StructureError::Unsupported)?.end;
            return Ok(Selection::caret(self.document.generation(), end));
        };
        let raw = &self.document.source()[span.clone()];
        let start = span.start + raw.len() - raw.trim_start_matches([' ', '\t', '|']).len();
        let end = (span.start + raw.trim_end_matches([' ', '\t', '|']).len()).max(start);
        Ok(Selection::new(
            self.document.generation(),
            Position::new(start, Affinity::Before),
            Position::new(end, Affinity::After),
        ))
    }
    pub fn insert_row(
        &self,
        path: &[usize],
        at: usize,
        millis: u64,
    ) -> StructureResult<Transaction> {
        let (rows, columns) = self.table_size(path)?;
        if at > rows {
            return Err(StructureError::InvalidTable);
        }
        table_budget(rows + 1, columns)?;
        let mut root = self.root.clone();
        root.node_mut(path)?.children.insert(at, row(columns));
        self.finish(
            root,
            Some(Caret {
                path: [path, &[at, 0]].concat(),
                offset: 0,
            }),
            millis,
        )
    }
    pub fn delete_row(
        &self,
        path: &[usize],
        at: usize,
        millis: u64,
    ) -> StructureResult<Transaction> {
        let (rows, _) = self.table_size(path)?;
        if at >= rows {
            return Err(StructureError::InvalidTable);
        }
        let mut root = self.root.clone();
        if rows == 1 {
            return self.remove_table(root, path, millis);
        }
        root.node_mut(path)?.children.remove(at);
        self.finish(
            root,
            Some(Caret {
                path: [path, &[at.min(rows - 2), 0]].concat(),
                offset: 0,
            }),
            millis,
        )
    }
    pub fn insert_column(
        &self,
        path: &[usize],
        at: usize,
        millis: u64,
    ) -> StructureResult<Transaction> {
        let (rows, columns) = self.table_size(path)?;
        if at > columns {
            return Err(StructureError::InvalidTable);
        }
        table_budget(rows, columns + 1)?;
        let mut root = self.root.clone();
        for row in &mut root.node_mut(path)?.children {
            row.children
                .insert(at, StructureNode::new(NodeKind::Cell, vec![]));
        }
        self.finish(
            root,
            Some(Caret {
                path: [path, &[0, at]].concat(),
                offset: 0,
            }),
            millis,
        )
    }
    pub fn delete_column(
        &self,
        path: &[usize],
        at: usize,
        millis: u64,
    ) -> StructureResult<Transaction> {
        let (_, columns) = self.table_size(path)?;
        if at >= columns {
            return Err(StructureError::InvalidTable);
        }
        let mut root = self.root.clone();
        if columns == 1 {
            return self.remove_table(root, path, millis);
        }
        for row in &mut root.node_mut(path)?.children {
            row.children.remove(at);
        }
        self.finish(
            root,
            Some(Caret {
                path: [path, &[0, at.min(columns - 2)]].concat(),
                offset: 0,
            }),
            millis,
        )
    }
    /// Tab after the final cell appends one row in the same undo history.
    pub fn tab(
        &self,
        path: &[usize],
        cell: CellAddress,
        backwards: bool,
        millis: u64,
    ) -> StructureResult<Transaction> {
        let direction = if backwards {
            CellDirection::Previous
        } else {
            CellDirection::Next
        };
        if let Some(next) = self.adjacent_cell(path, cell, direction)? {
            let selected = self.cell_selection(path, next)?;
            return Ok(Transaction::new(
                self.document.generation(),
                vec![],
                crate::transaction::EditKind::Format,
                millis,
            )
            .with_selection(Selection::caret(
                self.document.generation(),
                selected.range().start,
            )));
        }
        if !backwards {
            self.insert_row(path, self.table_size(path)?.0, millis)
        } else {
            Err(StructureError::InvalidTable)
        }
    }
    /// Replace a block with the current editor's default 3-row, 2-column header table.
    pub fn create_table(
        &self,
        path: &[usize],
        rows: usize,
        columns: usize,
        millis: u64,
    ) -> StructureResult<Transaction> {
        table_budget(rows, columns)?;
        let mut root = self.root.clone();
        let node = root.node_mut(path)?;
        if matches!(
            node.kind,
            NodeKind::Root | NodeKind::Row | NodeKind::Cell | NodeKind::Item { .. }
        ) {
            return Err(StructureError::InvalidTable);
        }
        *node = StructureNode::new(NodeKind::Table, (0..rows).map(|_| row(columns)).collect());
        self.finish(
            root,
            Some(Caret {
                path: [path, &[0, 0]].concat(),
                offset: 0,
            }),
            millis,
        )
    }
    fn remove_table(
        &self,
        mut root: StructureNode,
        path: &[usize],
        millis: u64,
    ) -> StructureResult<Transaction> {
        *root.node_mut(path)? = StructureNode::paragraph(vec![]);
        self.finish(
            root,
            Some(Caret {
                path: path.into(),
                offset: 0,
            }),
            millis,
        )
    }
}
fn row(columns: usize) -> StructureNode {
    StructureNode::new(
        NodeKind::Row,
        (0..columns)
            .map(|_| StructureNode::new(NodeKind::Cell, vec![]))
            .collect(),
    )
}
fn validate_cell(rows: usize, columns: usize, cell: CellAddress) -> StructureResult<()> {
    if cell.row >= rows || cell.column >= columns {
        Err(StructureError::InvalidTable)
    } else {
        Ok(())
    }
}
fn table_budget(rows: usize, columns: usize) -> StructureResult<()> {
    if rows == 0 || columns == 0 {
        return Err(StructureError::InvalidTable);
    }
    if columns
        .checked_add(1)
        .and_then(|n| rows.checked_mul(n))
        .is_none_or(|n| n >= anynote_core::protocol::rich::MAX_BLOCK_NODES)
    {
        return Err(StructureError::Budget);
    }
    Ok(())
}
