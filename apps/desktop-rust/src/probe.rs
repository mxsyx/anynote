use serde::Serialize;
use std::{
    fs::File,
    io::{self, Write},
    path::Path,
    process::Command,
    sync::{Arc, Mutex},
};

#[derive(Clone, Default)]
pub struct Probe(Option<Arc<Mutex<File>>>);

impl Probe {
    pub fn create(path: &Path) -> io::Result<Self> {
        Ok(Self(Some(Arc::new(Mutex::new(File::create(path)?)))))
    }

    pub fn record(&self, event: &str, value: impl Serialize) {
        if let Some(file) = &self.0 {
            let result = (|| -> io::Result<()> {
                let mut file = file
                    .lock()
                    .map_err(|_| io::Error::other("probe lock poisoned"))?;
                serde_json::to_writer(
                    &mut *file,
                    &serde_json::json!({"event": event, "value": value}),
                )?;
                file.write_all(b"\n")?;
                file.flush()
            })();
            if let Err(error) = result {
                eprintln!("platform probe: {error}");
            }
        }
    }
}

pub fn process_report() -> io::Result<serde_json::Value> {
    let child = Command::new(std::env::current_exe()?)
        .arg("--probe-child")
        .output()?;
    if !child.status.success() || child.stdout != b"anynote.native.child.v1\n" {
        return Err(io::Error::other("native child probe failed"));
    }
    Ok(serde_json::json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "child_process": "passed",
        "window": "not_tested",
        "ime": "not_tested",
        "power_events": "interface_only",
        "network_events": "interface_only",
        "resume_events": "interface_only"
    }))
}
