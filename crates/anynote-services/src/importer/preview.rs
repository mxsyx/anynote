use super::media::{StagedResource, Staging, mime_for_name};
use super::*;
use anynote_storage::notebook::{
    CreateNode, ImportRetryOutcome, ImportRetryResult, Note, NoteType, WriteQueue,
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    time::{Duration, Instant},
};

const TTL: Duration = Duration::from_secs(30 * 60);
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewTarget {
    pub notebook_id: String,
    pub parent_id: Option<String>,
}
pub enum ImportInput {
    Html(String),
    Url(String),
    Markdown {
        title: String,
        body: String,
    },
    /// Owned file from the native picker; no arbitrary path crosses the UI protocol.
    File {
        file: File,
        name: String,
    },
}
#[derive(Default)]
pub struct ImportOptions {
    pub budget: ImportBudget,
    pub page: bool,
    pub keep_original: bool,
    pub directory_grant: Option<String>,
    pub selected_sources: Option<HashSet<String>>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSummary {
    pub id: String,
    pub title: String,
    pub body: String,
    pub truncated: bool,
    pub report: ImportReport,
}
struct Preview {
    target: PreviewTarget,
    created: Instant,
    request: CreateNode,
    resources: Vec<StagedResource>,
    report: ImportReport,
    receipt: Option<CaptureReceipt>,
    _stage: Staging,
}
struct Grant {
    book: String,
    created: Instant,
    directory: DirectoryGrant,
}
pub struct ImportService {
    root: tempfile::TempDir,
    previews: HashMap<String, Preview>,
    grants: HashMap<String, Grant>,
}
impl ImportService {
    pub fn new(temporary_root: &Path) -> ImportResult<Self> {
        Ok(Self {
            root: tempfile::Builder::new()
                .prefix("import.session.")
                .tempdir_in(temporary_root)?,
            previews: HashMap::new(),
            grants: HashMap::new(),
        })
    }
    pub fn authorize_directory(&mut self, notebook_id: &str, path: &Path) -> ImportResult<String> {
        self.prune();
        check(
            uuid::Uuid::parse_str(notebook_id).is_ok(),
            "Notebook 身份无效",
        )?;
        check(self.grants.len() < 8, "目录授权数量已满")?;
        let id = uuid::Uuid::new_v4().to_string();
        self.grants.insert(
            id.clone(),
            Grant {
                book: notebook_id.into(),
                created: Instant::now(),
                directory: DirectoryGrant::authorize(path)?,
            },
        );
        Ok(id)
    }
    pub fn revoke_directory(&mut self, notebook_id: &str, id: &str) {
        if self.grants.get(id).is_some_and(|g| g.book == notebook_id) {
            self.grants.remove(id);
        }
    }
    pub fn prune(&mut self) {
        self.previews.retain(|_, p| p.created.elapsed() < TTL);
        self.grants.retain(|_, g| g.created.elapsed() < TTL);
    }
    fn directory(&self, book: &str, id: Option<&str>) -> ImportResult<Option<&DirectoryGrant>> {
        id.map(|id| {
            self.grants
                .get(id)
                .filter(|g| g.book == book && g.created.elapsed() < TTL)
                .map(|g| &g.directory)
                .ok_or_else(|| ImportError::invalid("资源目录授权已失效"))
        })
        .transpose()
    }
    pub async fn preview(
        &mut self,
        target: PreviewTarget,
        input: ImportInput,
        options: ImportOptions,
        cancel: &CancellationToken,
    ) -> ImportResult<PreviewSummary> {
        self.prune();
        cancelled(cancel)?;
        check(self.previews.len() < 4, "预览数量已满，请关闭已有预览")?;
        check(
            uuid::Uuid::parse_str(&target.notebook_id).is_ok()
                && target
                    .parent_id
                    .as_ref()
                    .is_none_or(|s| uuid::Uuid::parse_str(s).is_ok()),
            "预览目标身份无效",
        )?;
        let directory = self.directory(&target.notebook_id, options.directory_grant.as_deref())?;
        let mut stage = Staging::new(self.root.path(), options.budget.clone())?;
        let mut resources = Vec::new();
        let mut request = CreateNode::note("导入", "");
        request.parent_id = target.parent_id.clone();
        let mut report = ImportReport {
            budget: options.budget.clone(),
            source: None,
            final_url: None,
            fetched_at: timestamp(),
            created_at: timestamp(),
            mode: "markdown".into(),
            fallback: false,
            keep_original: options.keep_original,
            original_html: None,
            media: Vec::new(),
            localized: 0,
            failed: 0,
            bytes: 0,
            extra: BTreeMap::new(),
        };
        let mut receipt = None;
        let html = match input {
            ImportInput::Html(html) => Some(html),
            ImportInput::Url(url) => {
                let mut bytes = Vec::new();
                let result = crate::network::download(
                    &url,
                    options.budget.html_bytes.min(options.budget.response_bytes),
                    options.budget.response_ms,
                    cancel,
                    &mut bytes,
                )
                .await?;
                report.source = Some(url);
                report.final_url = Some(result.url.clone());
                report.fetched_at = timestamp();
                request.source_uri = Some(result.url);
                Some(decode_html(&bytes, &result.content_type))
            }
            ImportInput::Markdown { title, body } => {
                request.title = title;
                request.body = body;
                None
            }
            ImportInput::File { mut file, name } => {
                if name.to_ascii_lowercase().ends_with(".anyclip") {
                    let c = super::capture::prepare(file, &mut stage, cancel)?;
                    request.title = c.title;
                    request.body = c.body;
                    request.source_uri = Some(c.source);
                    resources = c.resources;
                    report = c.report;
                    receipt = Some(c.receipt);
                    None
                } else {
                    check(
                        file.metadata()?.is_file() && file.metadata()?.len() <= 50 * MIB,
                        "普通单文件超过 50 MiB",
                    )?;
                    file.seek(SeekFrom::Start(0))?;
                    request.title = truncate_utf16(&name, 240);
                    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
                    if ["html", "htm", "md", "markdown", "txt"].contains(&ext.as_str()) {
                        let mut bytes = Vec::new();
                        let limit = if ext == "html" || ext == "htm" {
                            options.budget.html_bytes
                        } else {
                            8 * MIB
                        };
                        file.take(limit + 1).read_to_end(&mut bytes)?;
                        check(bytes.len() as u64 <= limit, "文本文件超过预算")?;
                        if ext == "html" || ext == "htm" {
                            Some(decode_html(&bytes, ""))
                        } else {
                            request.body = String::from_utf8(bytes)
                                .map_err(|_| ImportError::invalid("Markdown 不是 UTF-8"))?;
                            None
                        }
                    } else {
                        let mime = mime_for_name(&name);
                        let resource =
                            stage.stage_reader(&mut file, mime, &name, 50 * MIB, cancel)?;
                        request.note_type = Some(if mime.starts_with("image/") {
                            NoteType::Image
                        } else if mime == "application/pdf" {
                            NoteType::Pdf
                        } else {
                            NoteType::Markdown
                        });
                        if request.note_type == Some(NoteType::Markdown) {
                            request.body = format!("[附件](anynote-resource:{})", resource.id);
                        } else {
                            request.primary_resource_id = Some(resource.id.clone());
                        }
                        let mut item = ImportMedia::pending(
                            name.clone(),
                            name,
                            if mime.starts_with("image/") {
                                MediaKind::Image
                            } else {
                                MediaKind::Attachment
                            },
                        );
                        item.status = MediaStatus::Localized;
                        item.resource_id = Some(resource.id.clone());
                        report.bytes = resource.size;
                        report.media.push(item);
                        resources.push(resource);
                        report.mode = "file".into();
                        None
                    }
                }
            }
        };
        if let Some(html) = html {
            report.mode = if options.page { "page" } else { "article" }.into();
            let converted = convert_html(
                &html,
                report
                    .final_url
                    .as_deref()
                    .unwrap_or("https://anynote.invalid/"),
                options.page,
                &options.budget,
                cancel,
            )?;
            request.title = converted.title;
            request.body = converted.body;
            report.fallback = converted.fallback;
            report.media = converted.media;
            if options.keep_original {
                let name = format!("{}.html", truncate_utf16(&request.title, 235));
                let resource = stage.stage_reader(
                    &mut html.as_bytes(),
                    "text/html",
                    &name,
                    options.budget.html_bytes,
                    cancel,
                )?;
                report.original_html = Some(OriginalHtml {
                    resource_id: resource.id.clone(),
                    name,
                    size: resource.size,
                });
                resources.push(resource);
            }
            for item in &mut report.media {
                cancelled(cancel)?;
                let marker = item.marker.clone().unwrap();
                let needle = format!("({marker})");
                let selected = options
                    .selected_sources
                    .as_ref()
                    .is_none_or(|s| s.contains(&item.source));
                let replacement = if item.kind == MediaKind::Embed {
                    format!(
                        ":::anynote{{type=\"core.video\" version=\"1\" id=\"{}\"}}\n{}\n:::",
                        uuid::Uuid::new_v4(),
                        serde_json::to_string_pretty(&item.extra.remove("video").unwrap())?
                    )
                } else if item.kind == MediaKind::Unsupported
                    || !selected
                    || (item.kind == MediaKind::Attachment
                        && directory.is_none()
                        && options.selected_sources.is_none())
                {
                    item.status = MediaStatus::Skipped;
                    item.error = Some(
                        if selected {
                            "无法本地化的媒体，保留来源"
                        } else {
                            "未选择下载"
                        }
                        .into(),
                    );
                    safe_external(item, report.final_url.as_deref())
                } else {
                    match stage
                        .load(item, report.final_url.as_deref(), directory, cancel)
                        .await
                    {
                        Ok(resource) => {
                            item.status = MediaStatus::Localized;
                            item.resource_id = Some(resource.id.clone());
                            report.bytes += resource.size;
                            let text = item.reference(&resource.id);
                            resources.push(resource);
                            text
                        }
                        Err(e) => {
                            cancelled(cancel)?;
                            item.error = Some(e.message);
                            let text = format!(
                                "({marker}) [媒体未下载：{}]",
                                item.name.replace(['\r', '\n', '[', ']'], " ")
                            );
                            item.placeholder = Some(text.clone());
                            text
                        }
                    }
                };
                request.body = request.body.replace(&needle, &replacement);
                if item.status != MediaStatus::Failed {
                    item.marker = None;
                }
            }
        }
        cancelled(cancel)?;
        check(
            !request.title.trim().is_empty()
                && request.title.encode_utf16().count() <= 240
                && request.body.encode_utf16().count() <= 2_000_000,
            "导入标题或正文超过预算",
        )?;
        for item in &mut report.media {
            if let Some(placeholder) = &item.placeholder
                && let Some(at) = request.body.find(placeholder)
            {
                let start = request.body[..at].rfind('\n').map_or(0, |n| n + 1);
                let end = request.body[at..]
                    .find('\n')
                    .map_or(request.body.len(), |n| at + n);
                item.extra.insert(
                    "placeholderLine".into(),
                    serde_json::Value::String(request.body[start..end].into()),
                );
            }
        }
        report.recount();
        let id = uuid::Uuid::new_v4().to_string();
        self.previews.insert(
            id.clone(),
            Preview {
                target: target.clone(),
                created: Instant::now(),
                request,
                resources,
                report,
                receipt,
                _stage: stage,
            },
        );
        self.get_preview(&target, &id)
    }
    pub fn get_preview(
        &mut self,
        target: &PreviewTarget,
        id: &str,
    ) -> ImportResult<PreviewSummary> {
        self.prune();
        let p = self
            .previews
            .get(id)
            .filter(|p| &p.target == target)
            .ok_or_else(|| ImportError::invalid("预览已失效或目标已变化"))?;
        let mut units = 0;
        let body = p
            .request
            .body
            .chars()
            .take_while(|c| {
                units += c.len_utf16();
                units <= 20000
            })
            .collect::<String>();
        let truncated = body.len() != p.request.body.len();
        Ok(PreviewSummary {
            id: id.into(),
            title: p.request.title.clone(),
            body,
            truncated,
            report: p.report.clone(),
        })
    }
    pub fn discard(&mut self, target: &PreviewTarget, id: &str) -> ImportResult<()> {
        self.get_preview(target, id)?;
        self.previews.remove(id);
        Ok(())
    }
    /// Run on a backend worker. Once the writer begins committing, cancellation cannot undo a commit.
    pub fn commit(
        &mut self,
        queue: &WriteQueue,
        target: &PreviewTarget,
        id: &str,
        cancel: &CancellationToken,
    ) -> ImportResult<Note> {
        self.get_preview(target, id)?;
        let p = self.previews.remove(id).unwrap();
        cancelled(cancel)?;
        let resources = p
            .resources
            .into_iter()
            .map(StagedResource::into_write)
            .collect::<ImportResult<Vec<_>>>()?;
        let cancel = cancel.clone();
        queue
            .submit(move |catalog| {
                Ok((|| -> ImportResult<Note> {
                    cancelled(&cancel)?;
                    Ok(catalog.notebook(&p.target.notebook_id)?.commit_import(
                        &p.request,
                        &resources,
                        &p.report,
                        p.receipt.as_ref(),
                    )?)
                })())
            })?
            .wait()?
    }
    pub async fn retry_media(
        &self,
        queue: &WriteQueue,
        book: &str,
        note: &str,
        sources: Option<&HashSet<String>>,
        grant: Option<&str>,
        cancel: &CancellationToken,
    ) -> ImportResult<ImportRetryResult> {
        cancelled(cancel)?;
        let b = book.to_owned();
        let n = note.to_owned();
        let ticket = queue.submit(move |c| c.notebook(&b)?.import_report(&n))?;
        let report = tokio::task::spawn_blocking(move || ticket.wait())
            .await
            .map_err(|_| ImportError::invalid("等待导入报告失败"))??;
        let directory = self.directory(book, grant)?;
        let mut stage = Staging::new(self.root.path(), report.budget.clone())?;
        stage.bytes = report.bytes + report.original_html.as_ref().map_or(0, |o| o.size);
        let mut outcomes = Vec::new();
        for (index, item) in report.media.iter().enumerate().filter(|(_, m)| {
            m.status == MediaStatus::Failed && sources.is_none_or(|s| s.contains(&m.source))
        }) {
            match stage
                .load(item, report.final_url.as_deref(), directory, cancel)
                .await
            {
                Ok(resource) => {
                    let size = resource.size;
                    outcomes.push(ImportRetryOutcome {
                        index,
                        size,
                        resource: Some(resource.into_write()?),
                        error: None,
                    });
                }
                Err(e) => {
                    cancelled(cancel)?;
                    outcomes.push(ImportRetryOutcome {
                        index,
                        size: 0,
                        resource: None,
                        error: Some(e.message),
                    });
                }
            }
        }
        cancelled(cancel)?;
        let b = book.to_owned();
        let n = note.to_owned();
        let cancel = cancel.clone();
        let ticket = queue.submit(move |c| {
            Ok((|| -> ImportResult<ImportRetryResult> {
                cancelled(&cancel)?;
                Ok(c.notebook(&b)?.retry_import_media(&n, &report, outcomes)?)
            })())
        })?;
        tokio::task::spawn_blocking(move || ticket.wait())
            .await
            .map_err(|_| ImportError::invalid("等待媒体重试提交失败"))?
            .map_err(ImportError::from)?
    }
}
fn safe_external(item: &ImportMedia, base: Option<&str>) -> String {
    let label = item.name.replace(['\r', '\n', '[', ']', '\\'], " ");
    let source = base
        .and_then(|b| url::Url::parse(b).ok())
        .and_then(|b| b.join(&item.source).ok())
        .map(|u| u.to_string())
        .unwrap_or_else(|| item.source.clone());
    if let Ok(url) = crate::network::public_url(&source) {
        format!(
            "[{label}]({})（未本地化）",
            url.as_str().replace('(', "%28").replace(')', "%29")
        )
    } else {
        format!("（未本地化媒体：{label}）")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn expiry_discard_and_failed_capture_drop_private_staging() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm07");
        std::fs::create_dir_all(&root).unwrap();
        let mut service = ImportService::new(&root).unwrap();
        let target = PreviewTarget {
            notebook_id: uuid::Uuid::new_v4().to_string(),
            parent_id: None,
        };
        let p = service
            .preview(
                target.clone(),
                ImportInput::Html("<p>leased</p>".into()),
                ImportOptions {
                    keep_original: true,
                    ..Default::default()
                },
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(std::fs::read_dir(service.root.path()).unwrap().count(), 1);
        service.previews.get_mut(&p.id).unwrap().created = Instant::now() - TTL;
        assert!(service.get_preview(&target, &p.id).is_err());
        assert_eq!(std::fs::read_dir(service.root.path()).unwrap().count(), 0);
        let p = service
            .preview(
                target.clone(),
                ImportInput::Html("<p>leased</p>".into()),
                ImportOptions {
                    keep_original: true,
                    ..Default::default()
                },
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        service.discard(&target, &p.id).unwrap();
        assert_eq!(std::fs::read_dir(service.root.path()).unwrap().count(), 0);
        let file = File::open(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../tests/fixtures/rust-migration/corpus/invalid/body-hash.anyclip"),
        )
        .unwrap();
        assert!(
            service
                .preview(
                    target,
                    ImportInput::File {
                        file,
                        name: "bad.anyclip".into()
                    },
                    ImportOptions::default(),
                    &CancellationToken::new()
                )
                .await
                .is_err()
        );
        assert_eq!(std::fs::read_dir(service.root.path()).unwrap().count(), 0);
    }
}
