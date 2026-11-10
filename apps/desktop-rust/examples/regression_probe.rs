//! Disposable native-window driver. Timing ends at GPUI draw, not GPU presentation.
use anynote_core::{backend::*, document_session::*, workspace::*};
use anynote_desktop::{
    backend_client::{BackendClient, Response},
    backend_session::BackendSession,
    document_editor::{self, DocumentEditor},
};
use anynote_storage::notebook::*;
use gpui_kit::{test::TestWindowExt, *};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use uuid::Uuid;

fn body(bytes: usize) -> String {
    let line = "Native regression paragraph with searchable text.\n\n";
    let mut value = line.repeat(bytes / line.len() + 1);
    value.truncate(bytes);
    value
}

fn prepare(root: &Path) {
    assert!(!root.exists(), "fixture directory must be new");
    std::fs::create_dir_all(root.join("workspace")).unwrap();
    let queue = WriteQueue::open(&root.join("workspace"), 8).unwrap();
    let id = queue
        .submit(|catalog| {
            let mut target = None;
            for book_ix in 0..4 {
                let book = catalog.create_notebook(&format!("RM31 {book_ix}"))?.id;
                let notebook = catalog.notebook(&book)?;
                for ix in 0..2500 {
                    let request = CreateNode::note(
                        format!("regression-note-{book_ix}-{ix}"),
                        if ix == 0 {
                            body(52_216)
                        } else {
                            format!("searchtoken{book_ix}x{ix}")
                        },
                    );
                    let node = notebook.create_node(&request, &[])?;
                    if book_ix == 0 && ix == 0 {
                        target = Some(DocumentId::new(
                            Uuid::parse_str(&book).unwrap(),
                            Uuid::parse_str(&node.node.id).unwrap(),
                        ));
                    }
                }
                if book_ix == 0 {
                    let mut parent = None;
                    for ix in 0..1000 {
                        let mut request = CreateNode::note(format!("depth-{ix}"), "");
                        request.kind = NodeKind::Folder;
                        request.note_type = None;
                        request.parent_id = parent;
                        parent = Some(notebook.create_node(&request, &[])?.node.id);
                    }
                }
                for ix in 0..16 {
                    let target = target.as_ref().unwrap();
                    notebook.create_node(
                        &CreateNode::note(
                            format!("link-{ix}"),
                            format!(
                                "[target](anynote://notebook/{}/note/{})",
                                target.notebook(),
                                target.note()
                            ),
                        ),
                        &[],
                    )?;
                }
            }
            Ok(target.unwrap())
        })
        .unwrap()
        .wait()
        .unwrap();
    std::fs::write(
        root.join("fixture.json"),
        serde_json::to_vec(
            &json!({"document":id,"books":4,"nodes":11064,"depth":1000,"open_bytes":52216}),
        )
        .unwrap(),
    )
    .unwrap();
}

async fn reply(client: &BackendClient, command: Command) -> Result<Reply, String> {
    match client
        .submit(command, Duration::from_secs(20))
        .map_err(|e| format!("{e:?}"))?
        .receive()
        .await
        .map_err(|e| format!("{e:?}"))?
    {
        Response::Reply(reply) => Ok(reply),
        _ => Err("unexpected stream response".into()),
    }
}

fn sample(report: &mut Value, name: &str, start: Instant) {
    report["samples"][name]
        .as_array_mut()
        .unwrap()
        .push(json!(start.elapsed().as_secs_f64() * 1000.));
}

async fn exercise(
    cx: &mut AsyncApp,
    client: &BackendClient,
    id: DocumentId,
    started: Instant,
    seconds: u64,
    report: &mut Value,
) -> Result<(), String> {
    let first_open = Instant::now();
    let Reply::Document(initial) = reply(client, Command::OpenDocument { id: id.clone() }).await?
    else {
        return Err("missing fixture document".into());
    };
    let (mut window, mut editor) = cx
        .update(|cx| {
            gpui_kit::open_window(window_options(), cx, |w, cx| {
                cx.new(|cx| DocumentEditor::from_snapshot(initial.clone(), w, cx))
            })
        })
        .map_err(|e| e.to_string())?;
    window
        .update(cx, |_, w, cx| {
            w.render_frame(cx);
            editor.focus_handle(cx).focus(w, cx);
            w.render_frame(cx);
            assert!(w.find("save-document").visible());
            assert_eq!(editor.read(cx).source(), initial.content().body());
        })
        .map_err(|e| e.to_string())?;
    sample(report, "startup_draw_ms", started);
    sample(report, "first_open_draw_ms", first_open);
    let open_start = Instant::now();
    let Reply::Document(_) = reply(client, Command::OpenDocument { id: id.clone() }).await? else {
        return Err("open failed".into());
    };
    sample(report, "open_ipc_ms", open_start);
    for _ in 0..20 {
        window
            .update(cx, |_, w, _| w.remove_window())
            .map_err(|e| e.to_string())?;
        let start = Instant::now();
        let Reply::Document(snapshot) =
            reply(client, Command::OpenDocument { id: id.clone() }).await?
        else {
            return Err("open failed".into());
        };
        (window, editor) = cx
            .update(|cx| {
                gpui_kit::open_window(window_options(), cx, |w, cx| {
                    cx.new(|cx| DocumentEditor::from_snapshot(snapshot.clone(), w, cx))
                })
            })
            .map_err(|e| e.to_string())?;
        window
            .update(cx, |_, w, cx| {
                w.render_frame(cx);
                editor.focus_handle(cx).focus(w, cx);
                w.render_frame(cx);
                assert!(w.find("save-document").visible());
                assert_eq!(editor.read(cx).source(), snapshot.content().body());
            })
            .map_err(|e| e.to_string())?;
        sample(report, "open_draw_ms", start);
        let start = Instant::now();
        let Reply::Workspace(WorkspaceReply::Search { hits, .. }) = reply(
            client,
            Command::Workspace(WorkspaceCommand::Search(Search::new(
                "searchtoken3x2499".into(),
            ))),
        )
        .await?
        else {
            return Err("search failed".into());
        };
        if hits.len() != 1 {
            return Err(format!("search expected one result, got {}", hits.len()));
        }
        sample(report, "search_ipc_ms", start);
        let start = Instant::now();
        let Reply::Workspace(WorkspaceReply::Backlinks(links)) = reply(
            client,
            Command::Workspace(WorkspaceCommand::Backlinks { id: id.clone() }),
        )
        .await?
        else {
            return Err("backlinks failed".into());
        };
        if links.len() != 64 {
            return Err(format!("expected 64 backlinks, got {}", links.len()));
        }
        sample(report, "backlinks_ipc_ms", start);
    }
    // The acknowledgement and reopened bytes, not the button callback, end a save sample.
    for _ in 0..20 {
        let expected = window
            .update(cx, |_, w, cx| {
                editor.focus_handle(cx).focus(w, cx);
                w.render_frame(cx);
                let before = editor.read(cx).text().len();
                w.input("x", cx);
                assert_eq!(
                    editor.read(cx).text().len(),
                    before + 1,
                    "input must reach editor"
                );
                editor.read(cx).source().to_owned()
            })
            .map_err(|e| e.to_string())?;
        let start = Instant::now();
        window
            .update(cx, |_, w, cx| w.click("save-document", cx))
            .map_err(|e| e.to_string())?;
        loop {
            if let Reply::Document(saved) =
                reply(client, Command::OpenDocument { id: id.clone() }).await?
                && saved.content().body() == expected
            {
                break;
            }
            if start.elapsed() > Duration::from_secs(20) {
                return Err("save receipt timeout".into());
            }
            cx.background_executor()
                .timer(Duration::from_millis(5))
                .await;
        }
        sample(report, "save_ack_ms", start);
    }
    window
        .update(cx, |_, w, _| w.remove_window())
        .map_err(|e| e.to_string())?;
    drop(editor);
    let (window, editor) = cx
        .update(|cx| {
            gpui_kit::open_window(window_options(), cx, |w, cx| {
                cx.new(|cx| DocumentEditor::new(body(100 * 1024), w, cx))
            })
        })
        .map_err(|e| e.to_string())?;
    window
        .update(cx, |_, w, cx| {
            w.render_frame(cx);
            editor.focus_handle(cx).focus(w, cx);
            w.render_frame(cx);
        })
        .map_err(|e| e.to_string())?;
    for _ in 0..100 {
        let start = Instant::now();
        window
            .update(cx, |_, w, cx| w.input("x", cx))
            .map_err(|e| e.to_string())?;
        sample(report, "input_draw_ms", start);
        let start = Instant::now();
        window
            .update(cx, |_, w, cx| w.press("down", cx))
            .map_err(|e| e.to_string())?;
        sample(report, "navigation_draw_ms", start);
    }
    window
        .update(cx, |_, w, cx| {
            editor.update(cx, |v, cx| v.set_selected_text_range(0..0, w, cx));
            w.render_frame(cx);
        })
        .map_err(|e| e.to_string())?;
    for ix in 0..100 {
        let start = Instant::now();
        window
            .update(cx, |_, w, cx| {
                let before = editor.update(cx, |v, cx| {
                    v.bounds_for_range(0..1, Bounds::default(), w, cx)
                });
                w.dispatch_event(
                    ScrollEvent {
                        position: point(px(600.), px(400.)),
                        delta: ScrollDelta::Pixels(point(
                            px(0.),
                            px(if ix % 2 == 0 { -400. } else { 400. }),
                        )),
                        ..Default::default()
                    }
                    .to_platform_input(),
                    cx,
                );
                w.render_frame(cx);
                let after = editor.update(cx, |v, cx| {
                    v.bounds_for_range(0..1, Bounds::default(), w, cx)
                });
                assert_ne!(
                    before, after,
                    "wheel event must change visible text geometry"
                );
            })
            .map_err(|e| e.to_string())?;
        sample(report, "scroll_draw_ms", start);
    }
    let deadline = Instant::now() + Duration::from_secs(seconds);
    while Instant::now() < deadline {
        let start = Instant::now();
        window
            .update(cx, |_, w, cx| {
                w.input("x", cx);
                w.press("backspace", cx);
            })
            .map_err(|e| e.to_string())?;
        sample(report, "load_draw_ms", start);
        cx.background_executor()
            .timer(Duration::from_millis(100))
            .await;
    }
    window
        .update(cx, |_, w, _| w.remove_window())
        .map_err(|e| e.to_string())?;
    let weak = editor.downgrade();
    drop(editor);
    cx.background_executor()
        .timer(Duration::from_millis(100))
        .await;
    if weak.upgrade().is_some() {
        return Err("closed editor entity retained".into());
    }
    Ok(())
}

fn main() {
    let started = Instant::now();
    let args: Vec<_> = std::env::args().collect();
    let root = PathBuf::from(
        args.get(2)
            .expect("usage: regression_probe prepare|run STATE [BINARY REPORT SECONDS]"),
    );
    if args[1] == "prepare" {
        prepare(&root);
        return;
    }
    assert_eq!(args[1], "run");
    let binary = PathBuf::from(&args[3]);
    let output = PathBuf::from(&args[4]);
    let seconds = args.get(5).map(|s| s.parse::<u64>().unwrap()).unwrap_or(60);
    let fixture: Value =
        serde_json::from_slice(&std::fs::read(root.join("fixture.json")).unwrap()).unwrap();
    let id: DocumentId = serde_json::from_value(fixture["document"].clone()).unwrap();
    let client = BackendClient::launch(binary, root)
        .recv_blocking()
        .unwrap()
        .unwrap();
    #[cfg(target_os = "linux")]
    let app = gpui_kit::platform::linux(WindowingModes::X11);
    #[cfg(not(target_os = "linux"))]
    let app = gpui_kit::application();
    app.with_assets(gpui_kit::assets::Assets).run(move |cx| {
        gpui_kit::init(cx);document_editor::install_actions(cx);BackendSession::install(client.clone(),cx);
        cx.activate(true);
        cx.spawn(async move |cx| {
            let mut report=json!({"schema":1,"platform":std::env::consts::OS,"arch":std::env::consts::ARCH,"cache":"os_cache_retained","fixture":fixture,"load_seconds":seconds,"samples":{},"evidence":"real OS windows; GPUI input dispatch and synchronous draw; no compositor present fence or native IME"});
            for name in ["startup_draw_ms","first_open_draw_ms","backlinks_ipc_ms","open_ipc_ms","open_draw_ms","search_ipc_ms","save_ack_ms","input_draw_ms","navigation_draw_ms","scroll_draw_ms","load_draw_ms"] {report["samples"][name]=json!([]);}
            let result=exercise(cx,&client,id,started,seconds,&mut report).await;
            report["failure"]=json!(result.err());
            let shutdown=reply(&client,Command::Shutdown).await;
            report["shutdown_error"]=json!(shutdown.err());
            std::fs::write(output,serde_json::to_vec_pretty(&report).unwrap()).unwrap();
            cx.update(|cx|cx.quit());
        }).detach();
    });
}

fn window_options() -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
            Default::default(),
            size(px(1200.), px(800.)),
        ))),
        ..Default::default()
    }
}
