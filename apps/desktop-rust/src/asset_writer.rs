use std::{
    io::{Read, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

pub(crate) fn export(path: &Path, bytes: &[u8], cancel: &AtomicBool) -> Result<(), String> {
    export_reader(path, bytes, cancel)
}

pub(crate) fn export_reader(
    path: &Path,
    mut reader: impl Read,
    cancel: &AtomicBool,
) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("导出已取消".into());
    }
    let parent = path.parent().ok_or("导出位置无效")?;
    let temporary = parent.join(format!(".anynote-export-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "无法创建导出文件")?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err("导出已取消");
            }
            let count = reader.read(&mut buffer).map_err(|_| "文件读取失败")?;
            if count == 0 {
                break;
            }
            output.write_all(&buffer[..count]).map_err(|_| "导出失败")?;
        }
        output.sync_all().map_err(|_| "导出失败")?;
        drop(output);
        if cancel.load(Ordering::Relaxed) {
            return Err("导出已取消");
        }
        std::fs::rename(&temporary, path).map_err(|_| "无法写入导出位置")
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result.map_err(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stream_export_failure_and_cancellation_preserve_destination() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tmp/pdf-webview/export")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("document.pdf");
        std::fs::write(&path, b"previous").unwrap();
        struct Broken(bool);
        impl Read for Broken {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                if !self.0 {
                    self.0 = true;
                    buffer[..7].copy_from_slice(b"partial");
                    return Ok(7);
                }
                Err(std::io::ErrorKind::UnexpectedEof.into())
            }
        }
        assert!(export_reader(&path, Broken(false), &AtomicBool::new(false)).is_err());
        assert!(export_reader(&path, &b"replacement"[..], &AtomicBool::new(true)).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"previous");
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        let fresh = root.join("exported.pdf");
        export_reader(&fresh, &b"original PDF bytes"[..], &AtomicBool::new(false)).unwrap();
        assert_eq!(std::fs::read(fresh).unwrap(), b"original PDF bytes");
        std::fs::remove_dir_all(root).unwrap();
    }
}
