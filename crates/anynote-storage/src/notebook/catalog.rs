use super::*;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize)]
#[non_exhaustive]
pub struct CatalogEntry {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub external: bool,
    pub metadata: Option<NotebookMeta>,
    pub unavailable: bool,
    pub error: Option<ReadErrorKind>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Directory {
    pub id: String,
    pub path: PathBuf,
    pub name: String,
}
/// Device catalog and bounded readonly LRU. Borrowed connections cannot be evicted mid-operation.
pub struct ReadonlyCatalog {
    root: PathBuf,
    entries: Vec<CatalogEntry>,
    connections: VecDeque<(String, ReadonlyNotebook)>,
    capacity: usize,
}
impl ReadonlyCatalog {
    pub fn open(root: &Path, capacity: usize) -> ReadResult<Self> {
        if capacity == 0 || capacity > 64 {
            return Err(ReadError::new(
                ReadErrorKind::InvalidInput,
                "只读连接预算无效",
            ));
        }
        let mut catalog = Self {
            root: root.to_path_buf(),
            entries: Vec::new(),
            connections: VecDeque::new(),
            capacity,
        };
        catalog.refresh()?;
        Ok(catalog)
    }
    pub fn refresh(&mut self) -> ReadResult<()> {
        let registry = path::local_path(&self.root, "_local/notebook-directories.json")?;
        let external: Vec<Directory> = match fs::read(registry) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        if external.len() > 1000 {
            return Err(ReadError::new(
                ReadErrorKind::InvalidInput,
                "外部目录数量超限",
            ));
        }
        let mut entries = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let id = entry.file_name().to_string_lossy().into_owned();
            if uuid(&id).is_ok() && entry.file_type()?.is_dir() {
                entries.push(CatalogEntry {
                    name: id.clone(),
                    id,
                    path: entry.path(),
                    external: false,
                    metadata: None,
                    unavailable: false,
                    error: None,
                });
            }
        }
        entries.sort_by(|a, b| a.id.cmp(&b.id));
        let mut ids: HashSet<_> = entries.iter().map(|e| e.id.clone()).collect();
        let mut paths: HashSet<_> = entries.iter().map(|e| e.path.clone()).collect();
        for entry in external {
            uuid(&entry.id)?;
            if !entry.path.is_absolute()
                || entry.name.is_empty()
                || entry.name.encode_utf16().count() > 240
            {
                return Err(ReadError::new(
                    ReadErrorKind::InvalidInput,
                    "外部目录登记无效",
                ));
            }
            if !ids.insert(entry.id.clone()) || !paths.insert(entry.path.clone()) {
                return Err(ReadError::new(
                    ReadErrorKind::IdentityConflict,
                    "Notebook 身份或目录重复登记",
                ));
            }
            entries.push(CatalogEntry {
                id: entry.id,
                name: entry.name,
                path: entry.path,
                external: true,
                metadata: None,
                unavailable: false,
                error: None,
            });
        }
        self.connections.clear();
        self.entries = entries;
        Ok(())
    }
    pub fn entries(&self) -> &[CatalogEntry] {
        &self.entries
    }
    pub fn connection_count(&self) -> usize {
        self.connections.len()
    }
    pub fn read(&mut self, id: &str) -> ReadResult<&ReadonlyNotebook> {
        uuid(id)?;
        let entry = self
            .entries
            .iter()
            .find(|e| e.id == id)
            .ok_or_else(|| ReadError::new(ReadErrorKind::NotFound, "Notebook 尚未登记"))?;
        if let Some(ix) = self.connections.iter().position(|(key, _)| key == id) {
            let cached = self.connections.remove(ix).unwrap();
            if cached.1.check_path().is_ok() {
                self.connections.push_back(cached);
                return Ok(&self.connections.back().unwrap().1);
            }
        }
        if self.connections.len() == self.capacity {
            self.connections.pop_front();
        }
        let book = ReadonlyNotebook::open(&entry.path, Some(id))?;
        self.connections.push_back((id.into(), book));
        Ok(&self.connections.back().unwrap().1)
    }
    pub fn diagnose(&mut self) -> Vec<CatalogEntry> {
        let mut entries = self.entries.clone();
        for entry in &mut entries {
            match self.read(&entry.id) {
                Ok(book) => {
                    entry.metadata = Some(book.metadata().clone());
                    entry.name = book.metadata().name.clone();
                }
                Err(error) => {
                    entry.unavailable = true;
                    entry.error = Some(error.kind());
                }
            }
        }
        entries
    }
}
