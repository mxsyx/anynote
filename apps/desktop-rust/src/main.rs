use anynote_desktop::{
    instance::{self, Instance},
    probe::{self, Probe},
    shell,
};
use gpui_kit::component::Theme;
use std::path::PathBuf;

fn state_directory() -> Result<PathBuf, Box<dyn std::error::Error>> {
    std::env::var_os("ANYNOTE_RUST_STATE_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            directories::ProjectDirs::from("app", "anynote", "anynote-rust")
                .map(|dirs| dirs.data_local_dir().to_path_buf())
        })
        .ok_or_else(|| "no user data directory".into())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let mut probe = Probe::default();
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--backend") => {
                if args.next().is_some() {
                    return Err("--backend accepts no further arguments".into());
                }
                anynote_desktop::backend::run(&state_directory()?)?;
                return Ok(());
            }
            Some("--probe-child") => {
                println!("anynote.native.child.v1");
                return Ok(());
            }
            Some("--platform-probe") => {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&probe::process_report()?)?
                );
                return Ok(());
            }
            Some("--probe-window") => {
                probe = Probe::create(&PathBuf::from(
                    args.next()
                        .ok_or("--probe-window requires an output path")?,
                ))?;
            }
            _ => return Err(format!("unknown argument: {}", arg.to_string_lossy()).into()),
        }
    }
    let directory = state_directory()?;
    let Instance::Primary(_instance, activations) = instance::acquire(&directory)? else {
        return Ok(());
    };
    let backend =
        anynote_desktop::backend_client::BackendClient::launch(std::env::current_exe()?, directory)
            .recv_blocking()??;
    let reopen_probe = probe.clone();
    let application = gpui_kit::application()
        .with_assets(gpui_kit::assets::Assets)
        .with_quit_mode(gpui_kit::QuitMode::Explicit);
    application.on_reopen(move |cx| {
        if let Err(error) = shell::open_or_activate(cx, reopen_probe.clone()) {
            eprintln!("reopen window: {error}");
        }
    });
    application.run(move |cx| {
        gpui_kit::init(cx);
        anynote_desktop::backend_session::BackendSession::install(backend, cx);
        cx.set_app_identity("app.anynote.desktop", "Anynote");
        Theme::sync_system_appearance(None, cx);
        shell::install_actions(cx);
        cx.on_window_closed(|cx, _| {
            if !cfg!(target_os = "macos") && cx.windows().is_empty() {
                anynote_desktop::backend_session::request_quit(cx);
            }
        })
        .detach();
        if let Err(error) = shell::open_or_activate(cx, probe.clone()) {
            eprintln!("open window: {error}");
            cx.quit();
            return;
        }
        cx.spawn(async move |cx| {
            while activations.recv().await.is_ok() {
                let probe = probe.clone();
                cx.update(|cx| {
                    if let Err(error) = shell::open_or_activate(cx, probe) {
                        eprintln!("activate window: {error}");
                    }
                });
            }
        })
        .detach();
    });
    Ok(())
}
