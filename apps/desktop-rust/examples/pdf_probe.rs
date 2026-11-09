//! Isolated native-window smoke harness; no user workspace is opened.
use anynote_core::{asset::AssetScope, backend::Command, document_session::DocumentId};
use anynote_desktop::{backend_client::BackendClient, pdf::PdfView};
use anynote_storage::notebook::*;
use gpui_kit::{AppContext, Bounds, WindowBounds, WindowOptions, px, size};
use std::{path::PathBuf, time::Duration};
use uuid::Uuid;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/pdf/geometry.pdf")
        });
    if std::fs::metadata(&path)?.len() > 32 * 1024 * 1024 {
        return Err("probe input exceeds 32 MiB".into());
    }
    let bytes = std::fs::read(path)?;
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tmp/rm25/window")
        .join(Uuid::new_v4().to_string());
    std::fs::create_dir_all(root.join("workspace"))?;
    let root = root.canonicalize()?;
    let queue = WriteQueue::open(&root.join("workspace"), 8)?;
    let scope = queue
        .submit(move |catalog| {
            let book = catalog.create_notebook("PDF window probe")?.id;
            let resource = Uuid::new_v4();
            let mut request = CreateNode::note("PDF window probe", "");
            request.note_type = Some(NoteType::Pdf);
            request.primary_resource_id = Some(resource.to_string());
            let node = catalog.notebook(&book)?.create_node(
                &request,
                &[ResourceWrite::bytes(
                    resource.to_string(),
                    "probe.pdf".into(),
                    "application/pdf".into(),
                    bytes,
                )?],
            )?;
            Ok(AssetScope::new(
                DocumentId::new(
                    Uuid::parse_str(&book).unwrap(),
                    Uuid::parse_str(&node.node.id).unwrap(),
                ),
                Uuid::parse_str(node.head_revision_id.as_ref().unwrap()).unwrap(),
                resource,
            ))
        })?
        .wait()?;
    drop(queue);
    let executable = std::env::current_exe()?
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(if cfg!(windows) {
            "anynote-desktop.exe"
        } else {
            "anynote-desktop"
        });
    let client = BackendClient::launch(executable, root.clone()).recv_blocking()??;
    let ui_client = client.clone();
    gpui_kit::application()
        .with_assets(gpui_kit::assets::Assets)
        .with_quit_mode(gpui_kit::QuitMode::LastWindowClosed)
        .run(move |cx| {
            gpui_kit::init(cx);
            gpui_kit::component::Theme::sync_system_appearance(None, cx);
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                        None,
                        size(px(1000.), px(800.)),
                        cx,
                    ))),
                    titlebar: Some(gpui_kit::TitlebarOptions {
                        title: Some("Anynote · PDF".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                cx,
                |window, cx| cx.new(|cx| PdfView::new(scope, ui_client, window, cx)),
            )
            .expect("PDF probe window");
            cx.activate(true);
        });
    let _ = client
        .submit(Command::Shutdown, Duration::from_secs(5))
        .and_then(|h| h.receive_blocking());
    for _ in 0..100 {
        if client.has_exited() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let _ = std::fs::remove_dir_all(root);
    Ok(())
}
