use super::*;
use anynote_storage::notebook::ResourceWrite;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};
use tempfile::NamedTempFile;
use url::Url;

pub(super) struct StagedResource {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub file: NamedTempFile,
}
impl StagedResource {
    pub fn into_write(self) -> ImportResult<ResourceWrite> {
        // The owned handle stays readable after the staging pathname is removed.
        Ok(ResourceWrite::file(
            self.id,
            self.name,
            self.mime,
            self.file.reopen()?,
        )?)
    }
}
pub(super) struct Staging {
    pub dir: tempfile::TempDir,
    pub budget: ImportBudget,
    pub bytes: u64,
}
impl Staging {
    pub fn new(root: &Path, budget: ImportBudget) -> ImportResult<Self> {
        check(budget.valid(), "导入预算无效")?;
        Ok(Self {
            dir: tempfile::Builder::new()
                .prefix("import.")
                .tempdir_in(root)?,
            budget,
            bytes: 0,
        })
    }
    fn limit(&self, limit: u64) -> u64 {
        limit.min(self.budget.total_bytes.saturating_sub(self.bytes))
    }
    pub fn stage_reader(
        &mut self,
        reader: &mut impl Read,
        mime: &str,
        name: &str,
        limit: u64,
        cancel: &CancellationToken,
    ) -> ImportResult<StagedResource> {
        let mut file = NamedTempFile::new_in(self.dir.path())?;
        let mut buffer = [0u8; 64 * 1024];
        let mut size = 0;
        loop {
            cancelled(cancel)?;
            let n = reader.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            size += n as u64;
            check(size <= self.limit(limit), "资源大小超过预算")?;
            file.write_all(&buffer[..n])?;
        }
        self.finish(file, mime, name, size, cancel)
    }
    fn finish(
        &mut self,
        mut file: NamedTempFile,
        mime: &str,
        name: &str,
        size: u64,
        cancel: &CancellationToken,
    ) -> ImportResult<StagedResource> {
        cancelled(cancel)?;
        check(size <= self.limit(50 * MIB), "媒体总量超过预算")?;
        if mime.starts_with("image/") {
            validate_image(file.as_file_mut(), mime, self.budget.decode_bytes)?;
        }
        file.flush()?;
        file.seek(SeekFrom::Start(0))?;
        self.bytes += size;
        Ok(StagedResource {
            id: uuid::Uuid::new_v4().to_string(),
            name: truncate_utf16(name, 240),
            mime: mime.into(),
            size,
            file,
        })
    }
    pub async fn load(
        &mut self,
        item: &ImportMedia,
        base: Option<&str>,
        directory: Option<&DirectoryGrant>,
        cancel: &CancellationToken,
    ) -> ImportResult<StagedResource> {
        cancelled(cancel)?;
        let limit = self.limit(self.budget.media_bytes.min(self.budget.response_bytes));
        check(limit > 0, "媒体总量超过预算")?;
        if item.source.starts_with("data:") {
            let (header, data) = item
                .source
                .split_once(",")
                .ok_or_else(|| ImportError::invalid("内嵌图片无效"))?;
            let mime = header
                .strip_prefix("data:")
                .and_then(|s| s.strip_suffix(";base64"))
                .ok_or_else(|| ImportError::invalid("不支持的内嵌图片"))?;
            validate_mime(mime, &item.kind)?;
            check(
                data.len() as u64 <= limit.div_ceil(3) * 4 + 4,
                "内嵌图片超过预算",
            )?;
            let data: String = data.chars().filter(|c| !c.is_ascii_whitespace()).collect();
            let mut reader = base64::read::DecoderReader::new(
                data.as_bytes(),
                &base64::engine::general_purpose::STANDARD,
            );
            return self.stage_reader(&mut reader, mime, &item.name, limit, cancel);
        }
        if let Some(base) = base {
            let url = Url::parse(base)
                .and_then(|b| b.join(&item.source))
                .map_err(|_| ImportError::invalid("媒体 URL 无效"))?;
            let file = NamedTempFile::new_in(self.dir.path())?;
            let mut output = tokio::fs::File::from_std(file.reopen()?);
            let result = crate::network::download(
                url.as_str(),
                limit,
                self.budget.response_ms,
                cancel,
                &mut output,
            )
            .await?;
            drop(output);
            let mime = result
                .content_type
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            validate_mime(&mime, &item.kind)?;
            return self.finish(file, &mime, &item.name, result.size, cancel);
        }
        let directory = directory.ok_or_else(|| ImportError::invalid("需要相邻资源目录授权"))?;
        let mut file = directory.open(&item.source)?;
        let before = file.metadata()?;
        check(before.len() <= limit, "资源大小超过预算")?;
        let mime = mime_for_name(&item.source);
        validate_mime(mime, &item.kind)?;
        let result = self.stage_reader(&mut file, mime, &item.name, limit, cancel)?;
        let after = file.metadata()?;
        if before.len() != after.len() || before.modified()? != after.modified()? {
            self.bytes -= result.size;
            return Err(ImportError::invalid("资源在读取期间改变"));
        }
        Ok(result)
    }
}
pub(super) fn mime_for_name(name: &str) -> &'static str {
    match name
        .split(['?', '#'])
        .next()
        .unwrap_or(name)
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        _ => "application/octet-stream",
    }
}
fn validate_mime(mime: &str, kind: &MediaKind) -> ImportResult<()> {
    let valid = match kind {
        MediaKind::Image => ["image/png", "image/jpeg", "image/webp"].contains(&mime),
        MediaKind::Video => {
            ["video/mp4", "video/webm", "video/ogg", "video/quicktime"].contains(&mime)
        }
        MediaKind::Audio => [
            "audio/mpeg",
            "audio/mp4",
            "audio/ogg",
            "audio/wav",
            "audio/webm",
            "audio/aac",
            "audio/flac",
        ]
        .contains(&mime),
        MediaKind::Attachment => mime == "application/pdf",
        _ => false,
    };
    check(valid, "不支持的媒体类型")
}
pub(super) fn validate_image(file: &mut File, mime: &str, decode_bytes: u64) -> ImportResult<()> {
    file.seek(SeekFrom::Start(0))?;
    let mut head = Vec::new();
    file.take(256 * 1024).read_to_end(&mut head)?;
    let format = image::guess_format(&head).map_err(|_| ImportError::invalid("图片类型无效"))?;
    check(format.to_mime_type() == mime, "图片类型与实际内容不匹配")?;
    let (w, h) = image::ImageReader::with_format(std::io::Cursor::new(head), format)
        .into_dimensions()
        .map_err(|_| ImportError::invalid("无法在有界头部读取图片尺寸"))?;
    check(
        w > 0 && h > 0 && w <= 16384 && h <= 16384,
        "图片边长超过预算",
    )?;
    check(
        u64::from(w) * u64::from(h) * 4 <= decode_bytes,
        "图片解码超过预算",
    )?;
    file.seek(SeekFrom::Start(0))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partial_staging_is_removed_on_read_error_and_midstream_cancel() {
        struct Broken {
            calls: usize,
            cancel: CancellationToken,
            abort: bool,
        }
        impl Read for Broken {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                self.calls += 1;
                if self.calls == 1 {
                    buffer[..10].fill(1);
                    if self.abort {
                        self.cancel.cancel();
                    }
                    Ok(10)
                } else {
                    Err(std::io::Error::other("injected read failure"))
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm07");
        std::fs::create_dir_all(&root).unwrap();
        for abort in [false, true] {
            let cancel = CancellationToken::new();
            let mut stage = Staging::new(&root, ImportBudget::default()).unwrap();
            let mut reader = Broken {
                calls: 0,
                cancel: cancel.clone(),
                abort,
            };
            assert!(
                stage
                    .stage_reader(&mut reader, "video/mp4", "test", 100, &cancel)
                    .is_err()
            );
            assert_eq!(stage.bytes, 0);
            assert_eq!(std::fs::read_dir(stage.dir.path()).unwrap().count(), 0);
        }
    }
}
