use anynote_core::{backend::*, document_session::*, workspace::*};
use anynote_desktop::backend_client::{BackendClient, Response};
use std::{path::PathBuf, time::Duration};
use uuid::Uuid;
const WAIT: Duration = Duration::from_secs(20);
struct Backend {
    root: PathBuf,
    client: BackendClient,
}
impl Backend {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tmp/rm28-ipc")
            .join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let client = BackendClient::launch(
            PathBuf::from(env!("CARGO_BIN_EXE_anynote-desktop")),
            root.clone(),
        )
        .recv_blocking()
        .unwrap()
        .unwrap();
        Self { root, client }
    }
    fn request(&self, command: Command) -> ServiceResult<Reply> {
        match self.client.submit(command, WAIT)?.receive_blocking()? {
            Response::Reply(reply) => Ok(reply),
            _ => panic!(),
        }
    }
    fn call(&self, command: WorkspaceCommand) -> WorkspaceReply {
        match self.request(Command::Workspace(command)).unwrap() {
            Reply::Workspace(reply) => reply,
            _ => panic!(),
        }
    }
    fn book(&self, title: &str) -> Uuid {
        let WorkspaceReply::Book(book) = self.call(WorkspaceCommand::CreateBook {
            title: title.into(),
        }) else {
            panic!()
        };
        book.id
    }
    fn note(&self, book: Uuid, title: &str, folder: bool) -> Entry {
        let WorkspaceReply::Node(node) = self.call(WorkspaceCommand::CreateNode {
            book,
            parent: None,
            title: title.into(),
            folder,
        }) else {
            panic!()
        };
        node
    }
    fn open(&self, id: &DocumentId) -> DocumentSnapshot {
        let Reply::Document(snapshot) = self
            .request(Command::OpenDocument { id: id.clone() })
            .unwrap()
        else {
            panic!()
        };
        snapshot
    }
    fn save(&self, base: DocumentSnapshot, body: &str) -> DocumentSnapshot {
        let base = DocumentSnapshot::new(
            base.id().clone(),
            base.revision(),
            base.head(),
            base.content().with_body(body.into()),
        )
        .with_resources(base.resources().clone());
        let Reply::DocumentSaved(saved) = self
            .request(Command::SaveDocument(SaveDocument::new(
                Uuid::new_v4(),
                1,
                base,
            )))
            .unwrap()
        else {
            panic!()
        };
        saved.snapshot().clone()
    }
}
impl Drop for Backend {
    fn drop(&mut self) {
        let _ = self.request(Command::Shutdown);
        for _ in 0..100 {
            if self.client.has_exited() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
#[test]
fn organization_history_search_and_transfer_use_real_backend() {
    let b = Backend::new();
    let book = b.book("工作笔记");
    let target = b.book("归档");
    let folder = b.note(book, "目录", true);
    let note = b.note(book, "测试笔记", false);
    let first = b.open(&note.id);
    let saved = b.save(first.clone(), "# 标题\n\nneedle 中文内容");
    b.call(WorkspaceCommand::Patch {
        id: note.id.clone(),
        expected: saved.revision(),
        title: None,
        tags: Some(vec!["知识".into()]),
        favorite: Some(true),
    });
    let saved = b.open(&note.id);
    b.call(WorkspaceCommand::Place {
        id: note.id.clone(),
        expected: saved.revision(),
        parent: Some(folder.id.note()),
        before: None,
    });
    let WorkspaceReply::Nodes { entries, .. } = b.call(WorkspaceCommand::Nodes {
        book,
        trash: false,
        offset: 0,
    }) else {
        panic!()
    };
    let node = entries.iter().find(|n| n.id == note.id).unwrap();
    assert_eq!(node.parent, Some(folder.id.note()));
    assert!(node.favorite);
    let cycle = b.request(Command::Workspace(WorkspaceCommand::Place {
        id: folder.id.clone(),
        expected: folder.revision,
        parent: Some(folder.id.note()),
        before: None,
    }));
    assert!(cycle.is_err());
    let mut search = Search::new("needle".into());
    search.tag = Some("知识".into());
    let WorkspaceReply::Search { hits, warnings, .. } = b.call(WorkspaceCommand::Search(search))
    else {
        panic!()
    };
    assert_eq!(hits.len(), 1, "{warnings:?}");
    assert_eq!(hits[0].entry.id, note.id);
    let transfer = WorkspaceCommand::Transfer {
        id: note.id.clone(),
        expected: node.revision,
        target,
        parent: None,
        copy: true,
        operation: Uuid::new_v4(),
    };
    let WorkspaceReply::Transferred { id: copy, .. } = b.call(transfer.clone()) else {
        panic!()
    };
    let WorkspaceReply::Transferred { id: retry, .. } = b.call(transfer) else {
        panic!()
    };
    assert_eq!(copy, retry);
    assert!(b.open(&copy).content().body().contains("needle"));
    b.call(WorkspaceCommand::RestoreRevision {
        id: note.id.clone(),
        expected: node.revision,
        revision: first.head(),
    });
    let restored = b.open(&note.id);
    assert_eq!(restored.content().body(), "");
    assert_ne!(restored.head(), first.head());
    let WorkspaceReply::History { entries, .. } = b.call(WorkspaceCommand::History {
        id: note.id.clone(),
        offset: 0,
    }) else {
        panic!()
    };
    assert!(entries.len() >= 3);
    b.call(WorkspaceCommand::Trash {
        id: note.id.clone(),
        restore: false,
    });
    let WorkspaceReply::Nodes { entries, .. } = b.call(WorkspaceCommand::Nodes {
        book,
        trash: false,
        offset: 0,
    }) else {
        panic!()
    };
    assert!(!entries.iter().any(|n| n.id == note.id));
    b.call(WorkspaceCommand::Trash {
        id: note.id.clone(),
        restore: true,
    });
    assert_eq!(b.open(&note.id).id(), &note.id);
}
#[test]
fn external_detach_retains_files_and_preferences_survive_reconnect() {
    let b = Backend::new();
    let external = Backend::new();
    let id = external.book("外部库");
    external.request(Command::Shutdown).unwrap();
    while !external.client.has_exited() {
        std::thread::sleep(Duration::from_millis(5));
    }
    let path = external.root.join("workspace").join(id.to_string());
    b.call(WorkspaceCommand::Attach { path: path.clone() });
    let WorkspaceReply::Books(books) = b.call(WorkspaceCommand::Books) else {
        panic!()
    };
    assert!(books.iter().any(|book| book.id == id && book.external));
    b.call(WorkspaceCommand::Detach { book: id });
    assert!(path.join("notebook.sqlite").exists());
    let mut prefs = Preferences::default();
    prefs.theme = "dark".into();
    prefs.font_size = 24.;
    b.call(WorkspaceCommand::SetPreferences(prefs));
    b.request(Command::Shutdown).unwrap();
    while !b.client.has_exited() {
        std::thread::sleep(Duration::from_millis(5));
    }
    let client = BackendClient::launch(
        PathBuf::from(env!("CARGO_BIN_EXE_anynote-desktop")),
        b.root.clone(),
    )
    .recv_blocking()
    .unwrap()
    .unwrap();
    let Response::Reply(Reply::Workspace(WorkspaceReply::Preferences(prefs))) = client
        .submit(Command::Workspace(WorkspaceCommand::Preferences), WAIT)
        .unwrap()
        .receive_blocking()
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(prefs.theme, "dark");
    assert_eq!(prefs.font_size, 24.);
    client
        .submit(Command::Shutdown, WAIT)
        .unwrap()
        .receive_blocking()
        .unwrap();
}
#[test]
fn search_cancellation_and_invalid_settings_do_not_break_session() {
    let b = Backend::new();
    let book = b.book("搜索");
    b.note(book, "匹配", false);
    let search = Search::new("匹配".into());
    let token = search.token;
    let pending = b
        .client
        .submit(Command::Workspace(WorkspaceCommand::Search(search)), WAIT)
        .unwrap();
    b.call(WorkspaceCommand::CancelSearch { token });
    assert!(pending.receive_blocking().is_ok());
    let mut prefs = Preferences::default();
    prefs.font_size = 100.;
    assert!(
        b.request(Command::Workspace(WorkspaceCommand::SetPreferences(prefs)))
            .is_err()
    );
    assert!(matches!(b.request(Command::Ping), Ok(Reply::Pong)));
}

#[test]
fn workspace_reply_roundtrip() {
    let message = ServerMessage::Response {
        epoch: Uuid::new_v4(),
        request_id: 1,
        result: Ok(Reply::Workspace(WorkspaceReply::Preferences(
            Preferences::default(),
        ))),
    };
    let bytes = serde_json::to_vec(&message).unwrap();
    serde_json::from_slice::<ServerMessage>(&bytes).unwrap();
}
#[test]
fn paged_search_does_not_repeat_equal_timestamp_results_and_import_is_real() {
    let b = Backend::new();
    let book = b.book("分页搜索");
    for ix in 0..205 {
        b.note(book, &format!("needle {ix:03}"), false);
    }
    let WorkspaceReply::Search {
        hits: first,
        truncated,
        ..
    } = b.call(WorkspaceCommand::Search(Search::new("needle".into())))
    else {
        panic!()
    };
    assert_eq!(first.len(), 200);
    assert!(truncated);
    let last = first.last().unwrap();
    let mut query = Search::new("needle".into());
    query.after = Some(SearchCursor::new(
        last.entry.updated,
        last.entry.id.notebook(),
        last.entry.id.note(),
    ));
    let WorkspaceReply::Search {
        hits: second,
        truncated,
        ..
    } = b.call(WorkspaceCommand::Search(query))
    else {
        panic!()
    };
    assert_eq!(second.len(), 5);
    assert!(!truncated);
    assert!(
        second
            .iter()
            .all(|hit| !first.iter().any(|prior| prior.entry.id == hit.entry.id))
    );
    let path = b.root.join("导入.md");
    std::fs::write(&path, "# 导入的正文\n\n离线文件").unwrap();
    b.call(WorkspaceCommand::Import {
        book,
        parent: None,
        path,
    });
    let WorkspaceReply::Search { hits, .. } =
        b.call(WorkspaceCommand::Search(Search::new("离线文件".into())))
    else {
        panic!()
    };
    assert_eq!(hits.len(), 1);
    assert!(
        b.open(&hits[0].entry.id)
            .content()
            .body()
            .contains("离线文件")
    );
}

#[test]
fn backlinks_survive_rename_and_external_offline_state_recovers() {
    let b = Backend::new();
    let book = b.book("链接");
    let a = b.note(book, "目标", false);
    let source = b.note(book, "来源", false);
    b.save(
        b.open(&source.id),
        &format!(
            "[目标](anynote://notebook/{}/note/{}#标题)",
            book,
            a.id.note()
        ),
    );
    b.call(WorkspaceCommand::Patch {
        id: a.id.clone(),
        expected: a.revision,
        title: Some("重命名目标".into()),
        tags: None,
        favorite: None,
    });
    let WorkspaceReply::Backlinks(links) = b.call(WorkspaceCommand::Backlinks { id: a.id }) else {
        panic!()
    };
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].id, source.id);
    let external = Backend::new();
    let id = external.book("可拔出库");
    external.request(Command::Shutdown).unwrap();
    while !external.client.has_exited() {
        std::thread::sleep(Duration::from_millis(5));
    }
    let path = external.root.join("workspace").join(id.to_string());
    b.call(WorkspaceCommand::Attach { path: path.clone() });
    b.call(WorkspaceCommand::Books);
    let offline = external.root.join("offline");
    std::fs::rename(&path, &offline).unwrap();
    let WorkspaceReply::Books(books) = b.call(WorkspaceCommand::Books) else {
        panic!()
    };
    assert!(books.iter().any(|book| book.id == id && book.unavailable));
    let WorkspaceReply::Search { complete, .. } =
        b.call(WorkspaceCommand::Search(Search::new(String::new())))
    else {
        panic!()
    };
    assert!(!complete);
    std::fs::rename(&offline, &path).unwrap();
    let WorkspaceReply::Books(books) = b.call(WorkspaceCommand::Books) else {
        panic!()
    };
    assert!(books.iter().any(|book| book.id == id && !book.unavailable));
    b.call(WorkspaceCommand::Detach { book: id });
}
