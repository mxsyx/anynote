use super::catalog::Directory;
use super::write::{input, new_id, now, text_limit};
use super::*;
use rusqlite::{Connection, params};
use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    thread,
};

/// Pins a lease across queued calls. Dropping it does not perform I/O on the caller.
pub struct NotebookPin(Arc<AtomicUsize>);
impl Drop for NotebookPin {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
struct Cached {
    id: String,
    book: WritableNotebook,
    pins: Arc<AtomicUsize>,
}
/// One per backend, exclusively owned by WriteQueue's worker thread.
pub struct WriteCatalog {
    pub(crate) cleanup_plans: super::cleanup::CleanupPlans,
    root: PathBuf,
    catalog: ReadonlyCatalog,
    capacity: usize,
    connections: VecDeque<Cached>,
    preservation: bool,
}
impl WriteCatalog {
    fn open(root: &Path, capacity: usize) -> ReadResult<Self> {
        input((1..=64).contains(&capacity), "写连接预算无效")?;
        let catalog = ReadonlyCatalog::open(root, 1)?;
        Ok(Self {
            cleanup_plans: Default::default(),
            root: root.into(),
            catalog,
            capacity,
            connections: VecDeque::new(),
            preservation: false,
        })
    }
    pub fn notebook(&mut self, id: &str) -> ReadResult<&mut WritableNotebook> {
        uuid(id)?;
        if let Some(index) = self.connections.iter().position(|c| c.id == id) {
            self.connections[index].book.read().check_path()?;
            let cached = self.connections.remove(index).unwrap();
            self.connections.push_back(cached);
        } else {
            let path = self
                .catalog
                .entries()
                .iter()
                .find(|e| e.id == id)
                .ok_or_else(|| ReadError::new(ReadErrorKind::NotFound, "Notebook 尚未登记"))?
                .path
                .clone();
            if self.connections.len() == self.capacity {
                let index = self
                    .connections
                    .iter()
                    .position(|c| c.pins.load(Ordering::Acquire) == 0)
                    .ok_or_else(|| {
                        ReadError::new(ReadErrorKind::Busy, "所有写连接均被活动任务固定")
                    })?;
                self.connections.remove(index);
            }
            self.connections.push_back(Cached {
                id: id.into(),
                book: if self.preservation {
                    WritableNotebook::open_for_preservation(&path, id)?
                } else {
                    WritableNotebook::open(&path, id)?
                },
                pins: Arc::new(AtomicUsize::new(0)),
            });
        }
        Ok(&mut self.connections.back_mut().unwrap().book)
    }
    /// Holds both leases for a cross-notebook protocol. A capacity-one catalog may
    /// temporarily use two connections, then returns to its configured budget.
    pub fn with_pair<T>(
        &mut self,
        source: &str,
        target: &str,
        action: impl FnOnce(&mut WritableNotebook, &mut WritableNotebook) -> ReadResult<T>,
    ) -> ReadResult<T> {
        input(source != target, "跨库操作需要不同 Notebook")?;
        let capacity = self.capacity;
        self.capacity = capacity.max(2);
        let result = (|| {
            let _source_pin = self.pin(source)?;
            let _target_pin = self.pin(target)?;
            let books = self.connections.make_contiguous();
            let a = books.iter().position(|c| c.id == source).unwrap();
            let b = books.iter().position(|c| c.id == target).unwrap();
            if a < b {
                let (left, right) = books.split_at_mut(b);
                action(&mut left[a].book, &mut right[0].book)
            } else {
                let (left, right) = books.split_at_mut(a);
                action(&mut right[0].book, &mut left[b].book)
            }
        })();
        self.capacity = capacity;
        while self.connections.len() > capacity {
            let Some(index) = self
                .connections
                .iter()
                .position(|c| c.pins.load(Ordering::Acquire) == 0)
            else {
                break;
            };
            self.connections.remove(index);
        }
        result
    }
    pub fn pin(&mut self, id: &str) -> ReadResult<NotebookPin> {
        self.notebook(id)?;
        let pins = self.connections.back().unwrap().pins.clone();
        pins.fetch_add(1, Ordering::AcqRel);
        Ok(NotebookPin(pins))
    }
    pub fn notebook_path(&self, id: &str) -> ReadResult<PathBuf> {
        uuid(id)?;
        self.catalog
            .entries()
            .iter()
            .find(|e| e.id == id)
            .map(|e| e.path.clone())
            .ok_or_else(|| ReadError::new(ReadErrorKind::NotFound, "Notebook 尚未登记"))
    }
    pub fn refresh_catalog(&mut self) -> ReadResult<()> {
        self.catalog.refresh()
    }
    pub(crate) fn has_pins(&self, id: &str) -> bool {
        self.connections
            .iter()
            .any(|c| c.id == id && c.pins.load(Ordering::Acquire) > 0)
    }
    pub fn entries(&self) -> &[CatalogEntry] {
        self.catalog.entries()
    }
    pub fn catalog_entries(&mut self) -> ReadResult<Vec<CatalogEntry>> {
        self.catalog.refresh()?;
        let mut entries = self.catalog.entries().to_vec();
        for entry in &mut entries {
            match self.notebook(&entry.id) {
                Ok(book) => {
                    entry.metadata = Some(book.read().metadata().clone());
                    entry.name = book.read().metadata().name.clone();
                }
                Err(error) => {
                    entry.unavailable = true;
                    entry.error = Some(error.kind());
                }
            }
        }
        Ok(entries)
    }
    pub fn attach_directory(&mut self, selected: &Path) -> ReadResult<NotebookMeta> {
        let selected = fs::canonicalize(selected)?;
        let book = ReadonlyNotebook::open(&selected, None)?;
        let meta = book.metadata().clone();
        drop(book);
        self.catalog.refresh()?;
        if let Some(entry) = self
            .catalog
            .entries()
            .iter()
            .find(|entry| entry.id == meta.id)
        {
            input(
                fs::canonicalize(&entry.path)? == selected,
                "Notebook 身份已在另一目录登记",
            )?;
            return Ok(meta);
        }
        let mut entries = self.directories()?;
        input(entries.len() < 1000, "外部 Notebook 数量超限")?;
        entries.push(Directory {
            id: meta.id.clone(),
            path: selected,
            name: meta.name.clone(),
        });
        self.persist_directories(&entries)?;
        self.catalog.refresh()?;
        Ok(meta)
    }
    pub fn detach_directory(&mut self, id: &str) -> ReadResult<()> {
        uuid(id)?;
        let mut entries = self.directories()?;
        input(
            entries.iter().any(|entry| entry.id == id),
            "只能移出外部 Notebook",
        )?;
        self.close_notebook(id)?;
        entries.retain(|entry| entry.id != id);
        self.persist_directories(&entries)?;
        self.catalog.refresh()
    }
    pub fn connection_count(&self) -> usize {
        self.connections.len()
    }
    /// Drain through the FIFO before copying a closed-format database. The caller
    /// must keep the notebook pinned and stop admission until preservation ends.
    pub fn checkpoint_for_preservation(&mut self, id: &str) -> ReadResult<()> {
        let book = self.notebook(id)?;
        book.view.check_path()?;
        book.view
            .db
            .execute_batch("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE; COMMIT;")?;
        Ok(())
    }
    /// Enable ordinary writer initialization only after the preservation journal
    /// has committed activation. No tracker DDL runs during migration preflight.
    pub fn begin_writing(&mut self) -> ReadResult<()> {
        if self.preservation {
            for cached in &mut self.connections {
                cached.book.begin_writing()?;
            }
            self.preservation = false;
        }
        Ok(())
    }
    pub fn close_notebook(&mut self, id: &str) -> ReadResult<()> {
        uuid(id)?;
        if let Some(index) = self.connections.iter().position(|c| c.id == id) {
            if self.connections[index].pins.load(Ordering::Acquire) > 0 {
                return Err(ReadError::new(
                    ReadErrorKind::Busy,
                    "Notebook 仍被活动任务固定",
                ));
            }
            self.connections.remove(index);
        }
        Ok(())
    }
    fn directories(&self) -> ReadResult<Vec<Directory>> {
        let registry = path::local_path(&self.root, "_local/notebook-directories.json")?;
        match fs::read(registry) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.into()),
        }
    }
    fn persist_directories(&self, entries: &[Directory]) -> ReadResult<()> {
        use std::io::Write;
        let registry = path::local_path(&self.root, "_local/notebook-directories.json")?;
        fs::create_dir_all(registry.parent().unwrap())?;
        let temp = path::local_path(
            &self.root,
            &format!("_local/notebook-directories.{}.tmp", new_id()),
        )?;
        let result = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)?;
            file.write_all(&serde_json::to_vec(entries)?)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temp, &registry)?;
            super::write_assets::sync_directory(registry.parent().unwrap())?;
            super::write_assets::sync_directory(&self.root)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result
    }
    pub fn rename_notebook(
        &mut self,
        id: &str,
        title: &str,
        icon: Option<&str>,
        color: Option<&str>,
    ) -> ReadResult<NotebookMeta> {
        let meta = self.notebook(id)?.rename(title, icon, color)?;
        let mut entries = self.directories()?;
        if let Some(entry) = entries.iter_mut().find(|e| e.id == id) {
            entry.name = meta.name.clone();
            self.persist_directories(&entries)?;
            self.catalog.refresh()?;
        }
        Ok(meta)
    }
    pub fn create_notebook(&mut self, title: &str) -> ReadResult<NotebookMeta> {
        self.create_notebook_at(title, None)
    }
    /// The parent is an already-authorized local directory; existing notebooks are never replaced.
    pub fn create_notebook_at(
        &mut self,
        title: &str,
        parent: Option<&Path>,
    ) -> ReadResult<NotebookMeta> {
        text_limit(title.trim(), 1, 240)?;
        let parent = parent.unwrap_or(&self.root).to_path_buf();
        path::local_path(&parent, "notebook.sqlite")?;
        input(parent.is_dir(), "创建位置不是目录")?;
        let id = new_id();
        let staging = path::local_path(&parent, &format!(".anynote-create-{id}"))?;
        let target = path::local_path(&parent, &id)?;
        fs::create_dir(&staging)?;
        let result = (|| {
            let mut db = Connection::open(staging.join("notebook.sqlite"))?;
            db.execute_batch("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;")?;
            let tx = db.transaction()?;
            tx.execute_batch(SCHEMA_V5)?;
            tx.execute(
                "INSERT INTO notebook_meta(id,name,created_at) VALUES(?,?,?)",
                params![id, title.trim(), now()?],
            )?;
            tx.commit()?;
            drop(db);
            let check = ReadonlyNotebook::open(&staging, Some(&id))?;
            let meta = check.metadata().clone();
            drop(check);
            super::write_assets::sync_directory(&staging)?;
            fs::rename(&staging, &target)?;
            super::write_assets::sync_directory(&parent)?;
            if parent != self.root {
                let mut entries = self.directories()?;
                input(entries.len() < 1000, "外部 Notebook 数量超限")?;
                entries.push(Directory {
                    id: id.clone(),
                    path: target.clone(),
                    name: title.trim().into(),
                });
                self.persist_directories(&entries)?;
            }
            self.catalog.refresh()?;
            Ok(meta)
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&staging);
            // Once registered, retain the complete notebook even if refresh fails.
            let registered = self
                .directories()
                .is_ok_and(|entries| entries.iter().any(|e| e.id == id));
            if !registered {
                let _ = fs::remove_dir_all(&target);
            }
        }
        result
    }
}

type Job = Box<dyn FnOnce(&mut WriteCatalog) + Send>;
struct QueueInner {
    sender: Option<mpsc::SyncSender<Job>>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Drop for QueueInner {
    fn drop(&mut self) {
        self.sender.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
/// Bounded global FIFO. Submit from services; wait off the UI thread. The last
/// handle drains accepted work and releases all SQLite leases before returning.
#[derive(Clone)]
pub struct WriteQueue(Arc<QueueInner>);
pub struct WriteTicket<T>(mpsc::Receiver<ReadResult<T>>);
impl<T> WriteTicket<T> {
    pub fn wait(self) -> ReadResult<T> {
        self.0
            .recv()
            .map_err(|_| ReadError::new(ReadErrorKind::Cancelled, "写队列已停止"))?
    }
}
impl WriteQueue {
    pub fn open(root: &Path, capacity: usize) -> ReadResult<Self> {
        Self::open_mode(root, capacity, false)
    }
    /// Migration owns admission and pins every notebook before preservation.
    pub fn open_for_preservation(root: &Path, capacity: usize) -> ReadResult<Self> {
        Self::open_mode(root, capacity, true)
    }
    fn open_mode(root: &Path, capacity: usize, preservation: bool) -> ReadResult<Self> {
        let mut catalog = WriteCatalog::open(root, capacity)?;
        catalog.preservation = preservation;
        let (sender, receiver) = mpsc::sync_channel::<Job>(64);
        let worker = thread::Builder::new()
            .name("anynote.storage.writer".into())
            .spawn(move || {
                let mut catalog = catalog;
                while let Ok(job) = receiver.recv() {
                    job(&mut catalog);
                }
            })?;
        Ok(Self(Arc::new(QueueInner {
            sender: Some(sender),
            worker: Some(worker),
        })))
    }
    pub fn submit<T: Send + 'static>(
        &self,
        action: impl FnOnce(&mut WriteCatalog) -> ReadResult<T> + Send + 'static,
    ) -> ReadResult<WriteTicket<T>> {
        let (sender, receiver) = mpsc::channel();
        self.0
            .sender
            .as_ref()
            .unwrap()
            .try_send(Box::new(move |catalog| {
                let _ = sender.send(action(catalog));
            }))
            .map_err(|e| match e {
                mpsc::TrySendError::Full(_) => ReadError::new(ReadErrorKind::Busy, "写队列已满"),
                mpsc::TrySendError::Disconnected(_) => {
                    ReadError::new(ReadErrorKind::Cancelled, "写队列已停止")
                }
            })?;
        Ok(WriteTicket(receiver))
    }
}
