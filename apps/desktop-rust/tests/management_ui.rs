#![cfg(feature = "ui-tests")]
use anynote_core::{backend::*, management::*};
use anynote_desktop::{backend_session::BackendSession, management::ManagementView};
use gpui_kit::{
    AppContext, Bounds, TestAppContext, WindowBounds, WindowOptions, px, size, test::TestWindowExt,
};
#[allow(dead_code)]
#[path = "support/media_ui.rs"]
mod media_ui;
use media_ui::{Backend, reply};
#[track_caller]
fn spin(
    cx: &mut TestAppContext,
    window: gpui_kit::AnyWindowHandle,
    condition: impl Fn(&mut gpui_kit::Window, &mut gpui_kit::App) -> bool,
) {
    for _ in 0..400 {
        cx.background_executor
            .advance_clock(std::time::Duration::from_millis(100));
        cx.run_until_parked();
        if cx
            .update_window(window, |_, w, cx| {
                w.render_frame(cx);
                condition(w, cx)
            })
            .unwrap()
        {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let state = cx
        .update_window(window, |_, w, _| {
            (
                w.try_find("management-status")
                    .and_then(|s| s.label().map(str::to_owned)),
                w.try_find("management-report-summary")
                    .and_then(|s| s.label().map(str::to_owned)),
            )
        })
        .unwrap();
    panic!("management UI did not settle: {state:?}");
}
#[gpui_kit::test]
fn management_controls_run_integrity_and_diagnostics_with_real_backend(cx: &mut TestAppContext) {
    cx.background_executor.allow_parking();
    let backend = Backend::new();
    let Reply::Document(d) = reply(&backend.client, Command::CreateDocument) else {
        panic!()
    };
    let notebook = d.id().notebook().to_string();
    cx.update(|cx| {
        gpui_kit::init(cx);
        BackendSession::install(backend.client.clone(), cx);
    });
    let (window, _) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(1100.), px(850.)),
                ))),
                ..Default::default()
            },
            cx,
            |w, cx| cx.new(|cx| ManagementView::new(w, cx)),
        )
        .unwrap()
    });
    spin(cx, window, |w, _| {
        w.try_find("management-report-summary").is_some()
    });
    cx.update_window(window, |_, w, cx| {
        w.click("management-page-diagnostics", cx);
        w.click("management-integrity", cx);
    })
    .unwrap();
    spin(cx, window, |w, _| {
        w.try_find("management-form-submit").is_some()
    });
    cx.update_window(window, |_, w, cx| {
        w.click("management-form-submit", cx);
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(window, |_, w, cx| {
        w.render_frame(cx);
        assert!(w.try_find("management-form-submit").is_some());
        w.click(format!("management-choice-{notebook}"), cx);
        w.click("management-form-submit", cx);
    })
    .unwrap();
    spin(cx, window, |w, _| {
        w.try_find("management-report-summary")
            .and_then(|s| s.label().map(str::to_owned))
            .as_deref()
            == Some("完整性检查通过")
    });
    let Reply::Management(ManagementReply::Jobs(jobs)) = reply(
        &backend.client,
        Command::Management(ManagementCommand::Jobs),
    ) else {
        panic!()
    };
    assert!(jobs.iter().any(
        |j| matches!(j.operation(),Some(Operation::Integrity{notebook:book})if book==&notebook)
            && j.task().status() == TaskStatus::Completed
    ));
    cx.update_window(window, |_, w, cx| w.click("diagnostics-full", cx))
        .unwrap();
    spin(
        cx,
        window,
        |_, _| matches!(reply(&backend.client,Command::GetDiagnostics),Reply::Diagnostics(d)if d.level()==DiagnosticLevel::Full),
    );
    cx.update_window(window, |_, w, cx| w.click("diagnostics-clear", cx))
        .unwrap();
    spin(cx, window, |w, _| {
        w.try_find("diagnostics-clear-confirm").is_some()
    });
    cx.update_window(window, |_, w, cx| w.press("escape", cx))
        .unwrap();
    spin(cx, window, |w, _| {
        w.try_find("diagnostics-clear-confirm").is_none()
    });
    cx.update_window(window, |_, w, cx| {
        assert_eq!(w.find("diagnostics-clear").focused(), Some(true));
        w.click("diagnostics-clear", cx);
    })
    .unwrap();
    spin(cx, window, |w, _| {
        w.try_find("diagnostics-clear-confirm").is_some()
    });
    cx.update_window(window, |_, w, cx| w.click("diagnostics-clear-confirm", cx))
        .unwrap();
    spin(
        cx,
        window,
        |_, _| matches!(reply(&backend.client,Command::GetDiagnostics),Reply::Diagnostics(d)if d.events().is_empty()),
    );
}
#[gpui_kit::test]
fn connection_form_validation_masking_and_cancel_preserve_focus(cx: &mut TestAppContext) {
    cx.background_executor.allow_parking();
    let backend = Backend::new();
    cx.update(|cx| {
        gpui_kit::init(cx);
        BackendSession::install(backend.client.clone(), cx);
    });
    let (window, _) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(900.), px(700.)),
                ))),
                ..Default::default()
            },
            cx,
            |w, cx| cx.new(|cx| ManagementView::new(w, cx)),
        )
        .unwrap()
    });
    spin(cx, window, |w, _| {
        w.try_find("management-report-summary").is_some()
    });
    cx.update_window(window, |_, w, cx| {
        w.click("management-page-cloud", cx);
        w.click("management-add-connection", cx);
    })
    .unwrap();
    spin(cx, window, |w, _| {
        w.try_find("management-field-2").is_some()
    });
    cx.update_window(window, |_, w, cx| {
        w.click("management-field-2", cx);
        w.input("secret-test-token", cx);
        assert_ne!(
            w.find("management-field-2").value(),
            Some("secret-test-token")
        );
        w.click("management-form-submit", cx);
        w.render_frame(cx);
        assert!(w.try_find("management-form-submit").is_some());
        w.press("escape", cx);
    })
    .unwrap();
    spin(cx, window, |w, _| {
        w.try_find("management-form-submit").is_none()
    });
    cx.update_window(window, |_, w, _| {
        assert_eq!(w.find("management-add-connection").focused(), Some(true))
    })
    .unwrap();
    let Reply::Management(ManagementReply::Jobs(jobs)) = reply(
        &backend.client,
        Command::Management(ManagementCommand::Jobs),
    ) else {
        panic!()
    };
    assert!(!jobs.iter().any(|j| j.title() == "保存云连接"));
}
