#![cfg(feature = "ui-tests")]

use anynote_desktop::{
    probe::Probe,
    shell::{self, Shell},
};
use gpui_kit::{
    AppContext, Bounds, TestAppContext, WindowBounds, WindowOptions,
    component::{ActiveTheme, Theme},
    px, size,
    test::{TestAppContextExt, TestWindowExt},
};

#[gpui_kit::test]
async fn input_clipboard_dialog_focus_theme_and_zoom(cx: &mut TestAppContext) {
    let (window, _) = cx.update(|cx| {
        gpui_kit::init(cx);
        cx.set_reduce_motion(true);
        shell::install_actions(cx);
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(800.), px(560.)),
                ))),
                ..Default::default()
            },
            cx,
            |window, cx| cx.new(|cx| Shell::new(window, cx, Probe::default())),
        )
        .unwrap()
    });
    cx.update_window(window, |_, window, cx| {
        let modifier = if cfg!(target_os = "macos") {
            "cmd"
        } else {
            "ctrl"
        };
        window.render_frame(cx);
        window.click("test-text", cx);
        window.input("中文 e\u{301} 🦀", cx);
        assert_eq!(window.find("test-text").value(), Some("中文 e\u{301} 🦀"));
        window.press(&format!("{modifier}-a"), cx);
        window.press(&format!("{modifier}-c"), cx);
        assert_eq!(
            cx.read_from_clipboard()
                .and_then(|item| item.text())
                .as_deref(),
            Some("中文 e\u{301} 🦀")
        );
        window.press("backspace", cx);
        window.press(&format!("{modifier}-v"), cx);
        assert_eq!(window.find("test-text").value(), Some("中文 e\u{301} 🦀"));

        window.press(&format!("{modifier}-shift-e"), cx);
    })
    .unwrap();
    cx.wait_for(window, std::time::Duration::from_secs(1), |window, _| {
        window.try_find("draft-text").is_some()
    })
    .await;
    cx.update_window(window, |_, window, cx| {
        let modifier = if cfg!(target_os = "macos") {
            "cmd"
        } else {
            "ctrl"
        };
        assert!(window.find("draft-text").visible());
        window.click("draft-text", cx);
        window.press(&format!("{modifier}-a"), cx);
        window.input("取消的输入", cx);
        window.press("escape", cx);
    })
    .unwrap();
    cx.wait_for(window, std::time::Duration::from_secs(1), |window, _| {
        window.try_find("draft-text").is_none()
    })
    .await;
    cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        assert_eq!(window.find("test-text").value(), Some("中文 e\u{301} 🦀"));
        assert_eq!(window.find("test-text").focused(), Some(true));

        window.click("edit-text", cx);
    })
    .unwrap();
    cx.wait_for(window, std::time::Duration::from_secs(1), |window, _| {
        window.try_find("draft-text").is_some()
    })
    .await;
    cx.update_window(window, |_, window, cx| {
        let modifier = if cfg!(target_os = "macos") {
            "cmd"
        } else {
            "ctrl"
        };
        window.click("draft-text", cx);
        window.press(&format!("{modifier}-a"), cx);
        window.input("应用后的输入", cx);
        window.click("apply-draft", cx);
    })
    .unwrap();
    cx.wait_for(window, std::time::Duration::from_secs(1), |window, _| {
        window.try_find("draft-text").is_none()
    })
    .await;

    let (dark, initial) = cx
        .update_window(window, |_, window, cx| {
            assert_eq!(window.find("test-text").value(), Some("应用后的输入"));
            let previous = (cx.theme().mode.is_dark(), cx.theme().font_size);
            window.click("toggle-theme", cx);
            previous
        })
        .unwrap();
    cx.wait_for(window, std::time::Duration::from_secs(1), |_, cx| {
        cx.theme().mode.is_dark() != dark
    })
    .await;

    let modifier = if cfg!(target_os = "macos") {
        "cmd"
    } else {
        "ctrl"
    };
    cx.update_window(window, |_, window, cx| {
        window.click("test-text", cx);
        window.press(&format!("{modifier}-="), cx);
    })
    .unwrap();
    cx.wait_for(window, std::time::Duration::from_secs(1), |_, cx| {
        cx.theme().font_size == initial + px(2.)
    })
    .await;
    cx.update_window(window, |_, window, cx| {
        window.press(&format!("{modifier}-0"), cx)
    })
    .unwrap();
    cx.wait_for(window, std::time::Duration::from_secs(1), |_, cx| {
        cx.theme().font_size == px(16.)
    })
    .await;
    cx.update_window(window, |_, window, cx| {
        for font_size in [12., 16., 24.] {
            Theme::update(cx, |theme| theme.font_size = px(font_size));
            window.render_frame(cx);
            let input = window.find("test-text");
            let button = window.find("edit-text");
            assert!(input.visible() && button.visible());
            assert!(button.bounds().top() >= input.bounds().bottom());
        }
    })
    .unwrap();
}

#[gpui_kit::test]
async fn file_picker_selection_and_cancellation(cx: &mut TestAppContext) {
    let (window, _) = cx.update(|cx| {
        gpui_kit::init(cx);
        shell::install_actions(cx);
        gpui_kit::open_window(WindowOptions::default(), cx, |window, cx| {
            cx.new(|cx| Shell::new(window, cx, Probe::default()))
        })
        .unwrap()
    });
    cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window.click("choose-file", cx);
        assert_eq!(window.find("choose-file").disabled(), Some(true));
    })
    .unwrap();
    assert!(cx.did_prompt_for_paths());
    cx.simulate_path_prompt_response(|options| {
        assert!(options.files && !options.directories && !options.multiple);
        Some(vec![std::path::PathBuf::from("chosen.md")])
    });
    cx.wait_for(window, std::time::Duration::from_secs(1), |window, _| {
        window.find("file-selection").label() == Some("chosen.md")
    })
    .await;
    cx.update_window(window, |_, window, cx| window.click("choose-file", cx))
        .unwrap();
    cx.simulate_path_prompt_response(|_| None);
    cx.wait_for(window, std::time::Duration::from_secs(1), |window, _| {
        window.find("file-selection").label() == Some("已取消选择")
    })
    .await;
}
