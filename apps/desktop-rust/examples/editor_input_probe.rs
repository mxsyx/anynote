//! Isolated native editor surface for input, scrolling and drag/drop acceptance.
use anynote_desktop::document_editor::{self, DocumentEditor};
use gpui_kit::*;

fn main() {
    let code = (0..80).map(|ix| format!("line {ix}\n")).collect::<String>();
    let source = format!(
        "# F001 输入验证\n\n- **alpha**\n  - nested\n\n<div>opaque</div>\n\n> quoted tail\n\n中文 English العربية עברית 🦀\n\n| a | b | c | d | e | f | g | h |\n|---|---|---|---|---|---|---|---|\n| cat | dog | eel | fox | red | blue | green | end |\n\n```text\n{code}```\n\ntrailer\n\n"
    );
    gpui_kit::application()
        .with_assets(gpui_kit::assets::Assets)
        .with_quit_mode(QuitMode::LastWindowClosed)
        .run(move |cx| {
            gpui_kit::init(cx);
            document_editor::install_actions(cx);
            let (_, editor) = gpui_kit::open_window(
                WindowOptions {
                    titlebar: Some(TitlebarOptions {
                        title: Some("Anynote · F001 临时输入验证".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                cx,
                |window, cx| cx.new(|cx| DocumentEditor::new(source, window, cx)),
            )
            .expect("native editor window");
            cx.observe(&editor, |editor, cx| {
                if let Some(path) = std::env::var_os("ANYNOTE_INPUT_PROBE_OUTPUT") {
                    std::fs::write(path, editor.read(cx).source()).expect("probe output");
                }
            })
            .detach();
            cx.activate(true);
        });
}
