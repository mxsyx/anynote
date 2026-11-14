use std::{env, fs, path::Path, process::Command};

fn collect(root: &Path, directory: &Path, entries: &mut Vec<(String, String)>) {
    for entry in fs::read_dir(directory).expect("whiteboard assets") {
        let path = entry.expect("asset entry").path();
        if path.is_dir() {
            collect(root, &path, entries);
        } else {
            entries.push((
                path.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
                path.to_str().expect("UTF-8 build path").to_owned(),
            ));
        }
    }
}

fn main() {
    println!("cargo:rerun-if-changed=whiteboard");
    let out = env::var_os("OUT_DIR").expect("OUT_DIR");
    let status = Command::new("node")
        .arg("whiteboard/build.mjs")
        .arg(&out)
        .status()
        .expect("building the bundled whiteboard requires Node.js 24+ and npm");
    assert!(status.success(), "whiteboard asset build failed");
    let root = Path::new(&out).join("whiteboard/dist");
    let mut entries = Vec::new();
    collect(&root, &root, &mut entries);
    entries.sort();
    let mut source = String::from("pub const ASSETS: &[(&str, &[u8])] = &[\n");
    for (name, path) in entries {
        source.push_str(&format!("({name:?}, include_bytes!({path:?})),\n"));
    }
    source.push_str("];\n");
    fs::write(Path::new(&out).join("whiteboard_assets.rs"), source).expect("asset index");
}
