#![cfg(feature = "ui-tests")]
use anynote_core::{backend::*, document_session::*};
use anynote_desktop::{
    backend_session::BackendSession,
    document_editor::{self, DocumentEditor, RunCommand},
};
use core::prelude::v1::test;
use gpui_kit::{
    test::{TestQueryExt, TestWindowExt},
    *,
};
#[path = "support/media_ui.rs"]
mod media_ui;
use media_ui::{Backend, reply, spin};

#[gpui_kit::test]
fn video_insert_save_reopen_and_consent_use_production_controls(cx: &mut TestAppContext) {
    cx.background_executor.allow_parking();
    let backend = Backend::new();
    let Reply::Document(snapshot) = reply(&backend.client, Command::CreateDocument) else {
        panic!()
    };
    cx.update(|cx| {
        gpui_kit::init(cx);
        document_editor::install_actions(cx);
        BackendSession::install(backend.client.clone(), cx);
    });
    let (window, editor) = cx.update(|cx| {
        gpui_kit::open_window(WindowOptions::default(), cx, |w, cx| {
            cx.new(|cx| DocumentEditor::from_snapshot(snapshot.clone(), w, cx))
        })
        .unwrap()
    });
    cx.update_window(window, |_, w, cx| {
        w.render_frame(cx);
        editor.focus_handle(cx).focus(w, cx);
        w.dispatch_action(Box::new(RunCommand::new("video")), cx);
    })
    .unwrap();
    spin(cx, window, |w, _| w.try_find_by_label("视频地址").is_some());
    cx.update_window(window, |_, w, cx| {
        media_ui::click_label(w, "视频地址", cx);
        w.input("http://example.com", cx);
        w.click("insert-video-confirm", cx);
        w.render_frame(cx);
        assert!(w.try_find_by_label("视频地址").is_some());
        media_ui::click_label(w, "视频地址", cx);
        w.press(
            if cfg!(target_os = "macos") {
                "cmd-a"
            } else {
                "ctrl-a"
            },
            cx,
        );
        w.input("https://vimeo.com/12345678", cx);
        w.click("insert-video-confirm", cx);
    })
    .unwrap();
    spin(cx, window, |w, _| w.try_find_by_label("播放视频").is_some());
    spin(
        cx,
        window,
        |_, cx| matches!(reply(&backend.client,Command::OpenDocument{id:snapshot.id().clone()}),Reply::Document(d) if d.content().body()==editor.read(cx).source()),
    );
    let Reply::Document(saved) = reply(
        &backend.client,
        Command::OpenDocument {
            id: snapshot.id().clone(),
        },
    ) else {
        panic!()
    };
    assert!(saved.content().body().contains("core.video"));
    assert!(saved.content().body().contains("12345678"));
    cx.update_window(window, |_, w, cx| media_ui::click_label(w, "播放视频", cx))
        .unwrap();
    spin(cx, window, |w, _| {
        w.try_find_by_label("播放视频")
            .is_some_and(|b| b.disabled() != Some(true))
    });
    cx.update_window(window, |_, w, cx| {
        w.render_frame(cx);
        assert!(w.try_find("video-player").is_none());
    })
    .unwrap();
    let other = DocumentSnapshot::new(
        DocumentId::new(uuid::Uuid::new_v4(), uuid::Uuid::new_v4()),
        1,
        uuid::Uuid::new_v4(),
        DocumentContent::new("Other".into(), "other".into(), vec![], false),
    );
    cx.update_window(window, |_, w, cx| {
        editor.update(cx, |editor, cx| editor.switch_document(other, w, cx))
    })
    .unwrap();
    spin(cx, window, |_, cx| editor.read(cx).source() == "other");
    cx.update_window(window, |_, w, cx| {
        editor.update(cx, |editor, cx| {
            editor.switch_document(saved.clone(), w, cx)
        })
    })
    .unwrap();
    spin(cx, window, |w, _| w.try_find_by_label("播放视频").is_some());
    cx.update_window(window, |_, w, _| w.remove_window())
        .unwrap();
}

#[test]
fn video_thumbnail_uses_revision_resource_and_normal_save() {
    use anynote_core::{image::ImageCommand, video::VideoCard};
    use uuid::Uuid;
    let backend = Backend::new();
    let Reply::Document(snapshot) = reply(&backend.client, Command::CreateDocument) else {
        panic!()
    };
    let resource = Uuid::new_v4();
    let bytes = include_bytes!("../../../tests/fixtures/rust-migration/corpus/media/pixel.png");
    reply(
        &backend.client,
        Command::Image(ImageCommand::Upload {
            document: snapshot.id().clone(),
            resource,
            name: "video-thumbnail.png".into(),
            offset: 0,
            bytes: bytes.to_vec(),
            complete: true,
        }),
    );
    let source =
        anynote_editor::video::insert(&VideoCard::parse("https://vimeo.com/12345678").unwrap());
    let mut editor = anynote_editor::transaction::Editor::new(
        anynote_editor::model::Document::new(source),
        Default::default(),
    );
    let block = editor.document().blocks()[0].id();
    let tx = anynote_editor::video::metadata(
        editor.document(),
        block,
        0,
        Some("Cached title"),
        Some(resource),
        0,
        1234,
    )
    .unwrap();
    editor.apply(tx).unwrap();
    let proposed = DocumentSnapshot::new(
        snapshot.id().clone(),
        snapshot.revision(),
        snapshot.head(),
        snapshot
            .content()
            .with_body(editor.document().source().into()),
    );
    let command = SaveDocument::new(Uuid::new_v4(), 1, proposed).with_resources(vec![resource]);
    let Reply::DocumentSaved(saved) =
        reply(&backend.client, Command::SaveDocument(command.clone()))
    else {
        panic!()
    };
    assert!(saved.snapshot().resources().contains_key(&resource));
    let Reply::Document(reopened) = reply(
        &backend.client,
        Command::OpenDocument {
            id: snapshot.id().clone(),
        },
    ) else {
        panic!()
    };
    assert!(reopened.content().body().contains("Cached title"));
    assert!(reopened.content().body().contains("fetchedAt"));
    let Reply::DocumentResource { bytes: read } = reply(
        &backend.client,
        Command::DocumentResource {
            id: snapshot.id().clone(),
            revision: reopened.head(),
            resource,
            offset: 0,
            length: bytes.len() as u32,
        },
    ) else {
        panic!()
    };
    assert_eq!(read, bytes);
    // An old base must fail CAS; reconnect reconciliation reads the authoritative snapshot.
    let error = backend
        .client
        .submit(
            Command::SaveDocument(command),
            std::time::Duration::from_secs(10),
        )
        .unwrap()
        .receive_blocking()
        .unwrap_err();
    assert_eq!(error.code(), ErrorCode::Conflict);
}
