//! Exercises the production editor and backend in a disposable workspace and real system WebView.
use anynote_core::{backend::*, board, document_session::*, image::*};
use anynote_desktop::{
    backend_client::{BackendClient, Response},
    backend_session::BackendSession,
    document_editor::{self, DocumentEditor},
};
use gpui_kit::{
    test::{TestEventExt, TestQueryExt, TestWindowExt},
    *,
};
use serde_json::{Value, json};
use std::{path::PathBuf, time::Duration};
use uuid::Uuid;

fn reply(client: &BackendClient, command: Command) -> Reply {
    match client
        .submit(command, Duration::from_secs(20))
        .unwrap()
        .receive_blocking()
        .unwrap()
    {
        Response::Reply(reply) => reply,
        _ => panic!("unexpected response"),
    }
}
fn doc(client: &BackendClient, command: Command) -> DocumentSnapshot {
    match reply(client, command) {
        Reply::Document(doc) => doc,
        Reply::DocumentSaved(saved) => saved.snapshot().clone(),
        _ => panic!("unexpected document"),
    }
}
fn resource(client: &BackendClient, document: &DocumentSnapshot, resource: Uuid) -> Vec<u8> {
    let Reply::Image(ImageReply::Info { length, .. }) = reply(
        client,
        Command::Image(ImageCommand::Info {
            scope: ImageScope {
                document: document.id().clone(),
                revision: document.head(),
                resource,
            },
        }),
    ) else {
        panic!("missing resource");
    };
    let mut output = Vec::new();
    while output.len() < length as usize {
        let Reply::DocumentResource { bytes } = reply(
            client,
            Command::DocumentResource {
                id: document.id().clone(),
                revision: document.head(),
                resource,
                offset: output.len() as u64,
                length: (length as usize - output.len()).min(MAX_CHUNK_BYTES) as u32,
            },
        ) else {
            panic!("missing resource chunk");
        };
        assert!(!bytes.is_empty());
        output.extend(bytes);
    }
    output
}
fn main() {
    let output = PathBuf::from(std::env::args_os().nth(1).expect("output directory"));
    let state = output.join("state");
    assert!(!state.exists(), "use a new fixture directory");
    std::fs::create_dir_all(&state).unwrap();
    let binary = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(if cfg!(windows) {
            "anynote-desktop.exe"
        } else {
            "anynote-desktop"
        });
    let client = BackendClient::launch(binary, state.canonicalize().unwrap())
        .recv_blocking()
        .unwrap()
        .unwrap();
    let initial = doc(&client, Command::CreateDocument);
    let initial = doc(
        &client,
        Command::SaveDocument(SaveDocument::new(
            Uuid::new_v4(),
            1,
            DocumentSnapshot::new(
                initial.id().clone(),
                initial.revision(),
                initial.head(),
                initial
                    .content()
                    .with_body(format!("白板验证正文\n\n{}", board::empty(Uuid::new_v4()))),
            ),
        )),
    );
    #[cfg(target_os = "linux")]
    let app = gpui_kit::platform::linux(WindowingModes::X11);
    #[cfg(not(target_os = "linux"))]
    let app = gpui_kit::application();
    app.with_assets(gpui_kit::assets::Assets).with_quit_mode(QuitMode::Explicit).run(move |cx| {
        gpui_kit::init(cx);
        anynote_desktop::release::register_fonts(cx).unwrap();
        document_editor::install_actions(cx);
        BackendSession::install(client.clone(), cx);
        let initial_id = initial.id().clone();
        let (window, editor) = gpui_kit::open_window(WindowOptions {
            window_bounds:Some(WindowBounds::Windowed(Bounds::new(point(px(0.),px(0.)),size(px(1100.),px(800.))))),
            titlebar:Some(TitlebarOptions {title:Some("Anynote whiteboard session probe".into()), ..Default::default()}),
            ..Default::default()
        },cx,|w,cx|cx.new(|cx|DocumentEditor::from_snapshot(initial,w,cx))).unwrap();
        cx.spawn(async move |cx| {
            let mut last = 0;
            loop {
                cx.background_executor().timer(Duration::from_millis(80)).await;
                let command = std::fs::read(output.join("command.json")).ok().and_then(|b|serde_json::from_slice::<Value>(&b).ok());
                let Some(command) = command else {continue};
                let id = command["id"].as_u64().unwrap();
                if id == last {continue;} last=id;
                let action = command["action"].as_str().unwrap();
                if action == "quit" { reply(&client,Command::Shutdown); cx.update(|cx|cx.quit()); break; }
                let result = cx.update_window(window, |_,w,cx| {
                    w.render_frame(cx);
                    match action {
                        "open" => {
                            let at=w.find_all_by_label("编辑白板…")[0].bounds().center();
                            w.pointer_down(at,MouseButton::Left,cx);w.pointer_up(at,MouseButton::Left,cx);
                        },
                        "copy"|"save"|"cancel" => {
                            if action == "copy" { cx.write_to_clipboard(ClipboardItem::new_string("pending".into())); }
                            w.click(format!("board-session-{action}"),cx);
                        },
                        "clipboard" => cx.write_to_clipboard(ClipboardItem::new_string(command["text"].as_str().unwrap().to_owned())),
                        "conflict" => {
                            let current=doc(&client,Command::OpenDocument{id:initial_id.clone()});
                            doc(&client,Command::SaveDocument(SaveDocument::new(Uuid::new_v4(),1,DocumentSnapshot::new(current.id().clone(),current.revision(),current.head(),current.content().with_body(format!("{}\n并发更新",current.content().body()))))));
                        },
                        "draft" => { editor.focus_handle(cx).focus(w,cx); w.render_frame(cx);w.input("打开前的草稿",cx); },
                        _=>{},
                    }
                    w.render_frame(cx);
                    let document=doc(&client,Command::OpenDocument{id:initial_id.clone()});
                    let blocks: Vec<_> = anynote_core::protocol::markdown::parse_blocks(document.content().body()).iter().filter_map(|b| board::parse(&document.content().body()[b.span()])).collect();
                    let mut scene=Value::Null;
                    if let Some(resource)=blocks.first().and_then(|b|b.resource()) {
                        scene=serde_json::from_slice(&self::resource(&client,&document,resource)).unwrap();
                    }
                    let save=w.try_find("board-session-save");
                    json!({"ready":save.as_ref().is_some_and(|b|b.disabled()!=Some(true)),"editing":save.is_some(),"clipboard":cx.read_from_clipboard().and_then(|c|c.text()),"body":document.content().body(),"revision":document.revision(),"resources":document.resources().len(),"scene":scene,"source":editor.read(cx).source()})
                }).unwrap();
                let pending=output.join("response.pending");
                std::fs::write(&pending,serde_json::to_vec_pretty(&result).unwrap()).unwrap();
                std::fs::rename(pending,output.join(format!("response-{id}.json"))).unwrap();
            }
        }).detach();
    });
}
