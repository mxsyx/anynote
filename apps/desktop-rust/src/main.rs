#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

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
            Some("--release-check") => {
                if args.next().is_some() {
                    return Err("--release-check accepts no further arguments".into());
                }
                println!("{}", anynote_desktop::release::check()?);
                return Ok(());
            }
            Some("--check-notebook") => {
                let path = PathBuf::from(args.next().ok_or("missing notebook directory")?);
                if args.next().is_some() {
                    return Err("--check-notebook accepts one directory".into());
                }
                anynote_storage::notebook::ReadonlyNotebook::open(&path, None)?;
                println!("anynote.notebook-check.v1: passed");
                return Ok(());
            }
            Some("--board-window") => {
                let scene = if let Some(path) = args.next() {
                    use std::io::Read;
                    let mut source = String::new();
                    std::fs::File::open(path)?
                        .take(16 * 1024 * 1024 + 1)
                        .read_to_string(&mut source)?;
                    if source.len() > 16 * 1024 * 1024 {
                        return Err("board scene exceeds 16 MiB".into());
                    }
                    anynote_editor::board::Scene::parse(&source)?
                } else {
                    anynote_editor::board::Scene::parse(
                        "{\"elements\":[],\"files\":{},\"appState\":{}}",
                    )?
                };
                if args.next().is_some() {
                    return Err("--board-window accepts at most one scene path".into());
                }
                gpui_kit::application()
                    .with_assets(gpui_kit::assets::Assets)
                    .with_quit_mode(gpui_kit::QuitMode::LastWindowClosed)
                    .run(move |cx| {
                        use gpui_kit::AppContext;
                        gpui_kit::init(cx);
                        anynote_desktop::release::register_fonts(cx).expect("bundled font");
                        anynote_desktop::board::install_actions(cx);
                        Theme::sync_system_appearance(None, cx);
                        gpui_kit::open_window(
                            gpui_kit::WindowOptions {
                                window_bounds: Some(gpui_kit::WindowBounds::Windowed(
                                    gpui_kit::Bounds::centered(
                                        None,
                                        gpui_kit::size(gpui_kit::px(1100.), gpui_kit::px(760.)),
                                        cx,
                                    ),
                                )),
                                titlebar: Some(gpui_kit::TitlebarOptions {
                                    title: Some("Anynote · 白板临时草稿".into()),
                                    ..Default::default()
                                }),
                                ..Default::default()
                            },
                            cx,
                            move |window, cx| {
                                cx.new(|cx| {
                                    anynote_desktop::board::BoardView::new(scene, window, cx)
                                })
                            },
                        )
                        .expect("open board window");
                        cx.activate(true);
                    });
                return Ok(());
            }
            Some("--backend") => {
                if args.next().is_some() {
                    return Err("--backend accepts no further arguments".into());
                }
                anynote_desktop::backend::run(&state_directory()?)?;
                return Ok(());
            }
            Some("--migration-rehearsal") => {
                let path = PathBuf::from(args.next().ok_or("missing rehearsal directory")?);
                if args.next().is_some() {
                    return Err("unexpected rehearsal argument".into());
                }
                println!("{}", anynote_desktop::migration::prepare_clone(&path)?);
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
    // The WebView host requires this GPUI backend. Relaunch with a child-only
    // environment instead of mutating process environment after threads may exist.
    #[cfg(target_os = "windows")]
    if std::env::var("GPUI_DISABLE_DIRECT_COMPOSITION").as_deref() != Ok("1") {
        let status = std::process::Command::new(std::env::current_exe()?)
            .args(std::env::args_os().skip(1))
            .env("GPUI_DISABLE_DIRECT_COMPOSITION", "1")
            .status()?;
        return if status.success() {
            Ok(())
        } else {
            Err("native child failed".into())
        };
    }
    let directory = state_directory()?;
    let Instance::Primary(_instance, activations) = instance::acquire(&directory)? else {
        return Ok(());
    };
    let backend =
        anynote_desktop::backend_client::BackendClient::launch(std::env::current_exe()?, directory)
            .recv_blocking()??;
    let reopen_probe = probe.clone();
    #[cfg(target_os = "linux")]
    let application = gpui_kit::platform::linux(gpui_kit::WindowingModes::X11);
    #[cfg(not(target_os = "linux"))]
    let application = gpui_kit::application();
    let application = application
        .with_assets(gpui_kit::assets::Assets)
        .with_quit_mode(gpui_kit::QuitMode::Explicit);
    application.on_reopen(move |cx| {
        if let Err(error) = shell::open_or_activate(cx, reopen_probe.clone()) {
            eprintln!("reopen window: {error}");
        }
    });
    application.run(move |cx| {
        gpui_kit::init(cx);
        anynote_desktop::release::register_fonts(cx).expect("bundled font");
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
