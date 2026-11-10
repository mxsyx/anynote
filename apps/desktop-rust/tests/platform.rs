use anynote_desktop::instance::{self, Instance};
use std::{
    io::Read,
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn directory() -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tmp");
    std::fs::create_dir_all(&root).unwrap();
    root.canonicalize().unwrap().join(format!(
        "anynote.rm02.{}.{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

#[test]
fn activation_and_crash_recovery() {
    let directory = directory();
    let Instance::Primary(guard, activations) = instance::acquire(&directory).unwrap() else {
        panic!("expected owner")
    };
    let mut secondary = Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "instance_child"])
        .env("ANYNOTE_TEST_INSTANCE", &directory)
        .env("ANYNOTE_TEST_SECONDARY", "1")
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    assert!(secondary.wait().unwrap().success());
    let deadline = Instant::now() + Duration::from_secs(5);
    while activations.try_recv().is_err() {
        assert!(Instant::now() < deadline, "activation did not arrive");
        std::thread::sleep(Duration::from_millis(10));
    }
    drop(guard);
    let mut primary = Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "instance_child"])
        .env("ANYNOTE_TEST_INSTANCE", &directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !directory.join("ready").exists() {
        assert!(Instant::now() < deadline, "child owner did not start");
        std::thread::sleep(Duration::from_millis(10));
    }
    primary.kill().unwrap();
    primary.wait().unwrap();
    let Instance::Primary(guard, _) = instance::acquire(&directory).unwrap() else {
        panic!("lock remained after crash")
    };
    drop(guard);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
#[ignore = "subprocess fixture invoked by activation_and_crash_recovery"]
fn instance_child() {
    let directory = PathBuf::from(std::env::var_os("ANYNOTE_TEST_INSTANCE").unwrap());
    let instance = instance::acquire(&directory).unwrap();
    if std::env::var_os("ANYNOTE_TEST_SECONDARY").is_some() {
        assert!(matches!(instance, Instance::Activated));
    } else {
        assert!(matches!(instance, Instance::Primary(..)));
        std::fs::write(directory.join("ready"), b"ready").unwrap();
        let _ = std::io::stdin().read(&mut [0]);
    }
}

#[test]
fn binary_process_probe_does_not_initialize_window_system() {
    let output = Command::new(env!("CARGO_BIN_EXE_anynote-desktop"))
        .arg("--platform-probe")
        .env_remove("DISPLAY")
        .env_remove("WAYLAND_DISPLAY")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["child_process"], "passed");
    assert_eq!(report["window"], "not_tested");
}
