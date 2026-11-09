use crate::archive::{
    ArchiveEntry, ArchiveError, ArchiveResult, MAX_ENTRIES, describe, destination, ensure,
    sync_tree, write_zip,
};
use anynote_storage::notebook::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::Write,
    path::Path,
};
use unicode_normalization::UnicodeNormalization;

const SCENE: &str = "application/vnd.anynote.whiteboard+json";
fn suffix(mime: &str) -> &str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        "image/tiff" => "tiff",
        "image/x-icon" | "image/vnd.microsoft.icon" => "ico",
        "application/pdf" => "pdf",
        SCENE => "excalidraw.json",
        _ => "bin",
    }
}
fn segment(node: &Node) -> String {
    let mut title = String::new();
    for ch in node.title.nfc().map(|c| {
        if c.is_control() || "<>:\"/\\|?*".contains(c) {
            '_'
        } else {
            c
        }
    }) {
        if title.len() + ch.len_utf8() <= 64 {
            title.push(ch);
        }
    }
    title = title.trim_end_matches(['.', ' ']).into();
    if title.is_empty() {
        title = "未命名".into();
    }
    let base = title.split('.').next().unwrap().to_ascii_lowercase();
    if matches!(base.as_str(), "con" | "prn" | "aux" | "nul")
        || (base.len() == 4
            && (base.starts_with("com") || base.starts_with("lpt"))
            && matches!(base.as_bytes()[3], b'1'..=b'9'))
    {
        title.insert(0, '_');
    }
    format!("{title}-{}", node.id)
}
fn link(from: &str, to: &str) -> String {
    let a = from.split('/').collect::<Vec<_>>();
    let b = to.split('/').collect::<Vec<_>>();
    let a = &a[..a.len() - 1];
    let common = a.iter().zip(&b).take_while(|(a, b)| a == b).count();
    let mut parts = vec!["..".to_owned(); a.len() - common];
    parts.extend(b[common..].iter().map(|p| {
        p.bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect::<String>()
    }));
    parts.join("/")
}
struct Stage<'a> {
    root: &'a Path,
    entries: BTreeMap<String, ArchiveEntry>,
    bytes: u64,
    cancel: &'a Cancellation,
}
impl Stage<'_> {
    fn file(&self, path: &str) -> ArchiveResult<File> {
        let p = checked_local_path(self.root, path)?;
        fs::create_dir_all(p.parent().unwrap())?;
        Ok(fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(p)?)
    }
    fn record(&mut self, path: &str) -> ArchiveResult<()> {
        let entry = describe(self.root, path, self.cancel)?;
        self.bytes = self
            .bytes
            .checked_add(entry.size)
            .ok_or_else(|| ArchiveError::Invalid("导出超限".into()))?;
        ensure(
            self.bytes <= SNAPSHOT_BYTES && self.entries.len() < MAX_ENTRIES,
            "开放导出超过预算",
        )?;
        self.entries.insert(path.into(), entry);
        Ok(())
    }
    fn put(&mut self, path: &str, bytes: &[u8]) -> ArchiveResult<()> {
        self.cancel.check()?;
        ensure(
            self.bytes + bytes.len() as u64 <= SNAPSHOT_BYTES,
            "开放导出超过预算",
        )?;
        let mut f = self.file(path)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        self.record(path)
    }
    fn copy(&mut self, path: &str, book: &ReadonlyNotebook, hash: &str) -> ArchiveResult<()> {
        if self.entries.contains_key(path) {
            return Ok(());
        }
        let mut asset = book.asset_by_hash(hash)?;
        let size = asset.info().size;
        ensure(self.bytes + size <= SNAPSHOT_BYTES, "开放导出超过预算")?;
        let mut output = self.file(path)?;
        let mut offset = 0;
        while offset < size {
            self.cancel.check()?;
            let bytes = asset.read_range(
                hash,
                offset,
                (size - offset).min(MAX_RANGE_BYTES as u64) as usize,
            )?;
            output.write_all(&bytes)?;
            offset += bytes.len() as u64;
        }
        output.sync_all()?;
        drop(output);
        self.record(path)
    }
}
fn portable_scene(
    stage: &mut Stage<'_>,
    book: &ReadonlyNotebook,
    hash: &str,
    head: &str,
    pins: &BTreeMap<String, String>,
    assets: &BTreeMap<String, AssetInfo>,
    resources: &mut BTreeMap<String, String>,
) -> ArchiveResult<String> {
    let dest = format!("_assets/{hash}-{head}.excalidraw.json");
    if stage.entries.contains_key(&dest) {
        return Ok(dest);
    }
    stage.copy(&format!("_assets/{hash}.scene.json"), book, hash)?;
    let info = &assets[hash];
    ensure(info.size <= 50 * 1024 * 1024, "白板场景超限")?;
    let mut scene: Value = serde_json::from_slice(&fs::read(
        stage.root.join(format!("_assets/{hash}.scene.json")),
    )?)?;
    let object = scene
        .as_object_mut()
        .ok_or_else(|| ArchiveError::Invalid("场景不是对象".into()))?;
    let files = object.remove("files").unwrap_or_else(|| json!({}));
    let files = files
        .as_object()
        .ok_or_else(|| ArchiveError::Invalid("场景 files 无效".into()))?;
    object.insert("type".into(), json!("excalidraw"));
    object.insert("version".into(), json!(2));
    object.insert("source".into(), json!("Anynote"));
    for file in files.values() {
        let id = file["resourceId"]
            .as_str()
            .ok_or_else(|| ArchiveError::Invalid("场景图片身份缺失".into()))?;
        let hash = pins
            .get(id)
            .ok_or_else(|| ArchiveError::Invalid("场景图片未固定到修订".into()))?;
        let image = assets
            .get(hash)
            .ok_or_else(|| ArchiveError::Invalid("场景图片缺失".into()))?;
        let path = format!("_assets/{hash}.{}", suffix(&image.mime));
        stage.copy(&path, book, hash)?;
        resources.insert(id.into(), path);
    }
    let mut output = stage.file(&dest)?;
    let mut prefix = serde_json::to_vec(&scene)?;
    prefix.pop();
    output.write_all(&prefix)?;
    output.write_all(b",\"files\":{")?;
    let mut written = prefix.len() as u64 + 10;
    for (i, (id, file)) in files.iter().enumerate() {
        stage.cancel.check()?;
        if i > 0 {
            output.write_all(b",")?;
        }
        let hash = &pins[file["resourceId"].as_str().unwrap()];
        let image = &assets[hash];
        let mut metadata = json!({"id":id,"mimeType":image.mime});
        if let Some(created) = file.get("created") {
            metadata["created"] = created.clone();
        }
        let mut header = serde_json::to_string(&metadata)?;
        header.pop();
        let url = serde_json::to_string(&format!("data:{};base64,", image.mime))?;
        let header = format!(
            "{}:{header},\"dataURL\":{}",
            serde_json::to_string(id)?,
            &url[..url.len() - 1]
        );
        written += header.len() as u64 + image.size.div_ceil(3) * 4 + 3;
        ensure(
            stage.bytes + written <= SNAPSHOT_BYTES,
            "嵌图场景超过导出预算",
        )?;
        output.write_all(header.as_bytes())?;
        let mut asset = book.asset_by_hash(hash)?;
        let mut offset = 0;
        while offset < image.size {
            stage.cancel.check()?;
            let bytes =
                asset.read_range(hash, offset, (image.size - offset).min(48 * 1024) as usize)?;
            output.write_all(STANDARD.encode(&bytes).as_bytes())?;
            offset += bytes.len() as u64;
        }
        output.write_all(b"\"}")?;
    }
    output.write_all(b"}}")?;
    output.sync_all()?;
    drop(output);
    stage.record(&dest)?;
    Ok(dest)
}
#[derive(Clone, Copy)]
pub enum OpenExportFormat {
    Directory,
    Zip,
}

pub fn export_markdown(
    snapshot: &mut FrozenSnapshot,
    output: &Path,
    format: OpenExportFormat,
    cancel: &Cancellation,
) -> ArchiveResult<()> {
    if snapshot.mode().is_none() {
        snapshot.prepare(SnapshotMode::Current, cancel)?;
    }
    ensure(
        snapshot.mode() == Some(SnapshotMode::Current),
        "开放导出需要仅当前切面",
    )?;
    let target = destination(output)?;
    ensure(!target.exists(), "导出目标已存在")?;
    let directory = tempfile::Builder::new()
        .prefix("anynote.markdown.")
        .tempdir_in(target.parent().unwrap())?;
    let book = ReadonlyNotebook::open(snapshot.path(), Some(snapshot.notebook_id()))?;
    let nodes = book.nodes()?;
    ensure(nodes.len() <= MAX_ENTRIES - 2, "导出节点超限")?;
    let by_id = nodes
        .iter()
        .map(|n| (n.id.clone(), n))
        .collect::<BTreeMap<_, _>>();
    let assets = book
        .assets()?
        .into_iter()
        .map(|a| (a.hash.clone(), a))
        .collect::<BTreeMap<_, _>>();
    let mut pins: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for r in book.revision_resources()? {
        pins.entry(r.revision_id)
            .or_default()
            .insert(r.resource_id, r.asset_hash);
    }
    let mut paths: BTreeMap<String, String> = BTreeMap::new();
    let mut warnings = BTreeSet::new();
    for node in &nodes {
        let mut chain = Vec::new();
        let mut current = *by_id.get(&node.id).unwrap();
        while !paths.contains_key(&current.id) {
            chain.push(current);
            if let Some(id) = &current.parent_id {
                current = by_id[id];
            } else {
                break;
            }
        }
        for node in chain.into_iter().rev() {
            let extension = if node.kind == NodeKind::Folder {
                String::new()
            } else if node.note_type == Some(NoteType::Markdown) {
                ".md".into()
            } else {
                let note = book.note(&node.id)?;
                let hash = &pins[note.head_revision_id.as_ref().unwrap()]
                    [note.primary_resource_id.as_ref().unwrap()];
                format!(".{}", suffix(&assets[hash].mime))
            };
            let name = format!("{}{extension}", segment(node));
            let mut path = node
                .parent_id
                .as_ref()
                .map_or_else(|| name.clone(), |id| format!("{}/{name}", paths[id]));
            if path.len() > 220 {
                path = format!("_long/{name}");
                warnings.insert("过长目录已映射到 _long；原目录关系见 EXPORT-MAP.json。".into());
            }
            paths.insert(node.id.clone(), path);
        }
    }
    let mut stage = Stage {
        root: directory.path(),
        entries: BTreeMap::new(),
        bytes: 0,
        cancel,
    };
    let pattern = regex::Regex::new(
        r"(?i)anynote://notebook/([a-f0-9-]{36})/note/([a-f0-9-]{36})(#[^\s)]*)?",
    )
    .unwrap();
    let mut resources = Vec::new();
    for node in &nodes {
        cancel.check()?;
        let path = &paths[&node.id];
        if node.kind == NodeKind::Folder {
            fs::create_dir_all(stage.root.join(path))?;
            continue;
        }
        let note = book.note(&node.id)?;
        let head = note.head_revision_id.as_ref().unwrap();
        let empty = BTreeMap::new();
        let pinned = pins.get(head).unwrap_or(&empty);
        let mut exported = BTreeMap::new();
        if node.note_type == Some(NoteType::Markdown) {
            for (id, hash) in pinned {
                let asset = &assets[hash];
                let dest = if asset.mime == SCENE {
                    portable_scene(
                        &mut stage,
                        &book,
                        hash,
                        head,
                        pinned,
                        &assets,
                        &mut exported,
                    )?
                } else {
                    let dest = format!("_assets/{hash}.{}", suffix(&asset.mime));
                    stage.copy(&dest, &book, hash)?;
                    dest
                };
                exported.insert(id.clone(), dest);
            }
            let mut body = String::new();
            for block in anynote_core::protocol::markdown::parse_blocks(&note.body) {
                let source = &note.body[block.span()];
                let Some(d) = block.directive() else {
                    body.push_str(source);
                    continue;
                };
                let kind = d
                    .attrs()
                    .get("type")
                    .map(String::as_str)
                    .unwrap_or("unknown");
                let version = d
                    .attrs()
                    .get("version")
                    .map(String::as_str)
                    .unwrap_or("unknown");
                let data = d.data().unwrap_or(&Value::Null);
                if kind == "core.image"
                    && version == "1"
                    && d.attrs().contains_key("id")
                    && data["resourceId"]
                        .as_str()
                        .is_some_and(|id| exported.contains_key(id))
                    && data
                        .get("width")
                        .is_none_or(|w| w.as_u64().is_some_and(|w| (32..=4096).contains(&w)))
                    && ["alt", "title"]
                        .iter()
                        .all(|k| data.get(*k).is_none_or(Value::is_string))
                {
                    let escape = |s: &str| {
                        s.replace('\\', "\\\\")
                            .replace('[', "\\[")
                            .replace(']', "\\]")
                            .replace("\r\n", " ")
                            .replace('\n', " ")
                    };
                    let title = data["title"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(|s| {
                            format!(
                                " {}",
                                serde_json::to_string(&s.replace("\r\n", " ").replace('\n', " "))
                                    .unwrap()
                            )
                        })
                        .unwrap_or_default();
                    body.push_str(&format!(
                        "![{}]({}{title})\n",
                        escape(data["alt"].as_str().unwrap_or("")),
                        link(path, &exported[data["resourceId"].as_str().unwrap()])
                    ));
                } else if kind == "core.video" && version == "1" && data["url"].is_string() {
                    body.push_str(&format!(
                        "[{}]({})\n",
                        data["title"]
                            .as_str()
                            .unwrap_or("视频链接")
                            .replace(['[', ']', '\\'], ""),
                        data["url"].as_str().unwrap()
                    ));
                } else if kind == "core.whiteboard" && version == "1" {
                    let mut parts = Vec::new();
                    for (key, label, marker) in [
                        ("previewResourceId", "白板预览", "!"),
                        ("resourceId", "白板场景", ""),
                    ] {
                        if let Some(dest) = data[key].as_str().and_then(|id| exported.get(id)) {
                            parts.push(format!("{marker}[{label}]({})", link(path, dest)));
                        }
                    }
                    body.push_str(&parts.join("\n\n"));
                    body.push('\n');
                } else {
                    warnings.insert(format!(
                        "保留原始扩展块：{kind}@{version}；开放阅读器可能无法渲染。"
                    ));
                    body.push_str(source);
                }
            }
            for (id, dest) in &exported {
                body = body.replace(&format!("anynote-resource:{id}"), &link(path, dest));
            }
            body = pattern
                .replace_all(&body, |c: &regex::Captures| {
                    if &c[1] == snapshot.notebook_id() && paths.contains_key(&c[2]) {
                        format!(
                            "{}{}",
                            link(path, &paths[&c[2]]),
                            c.get(3).map_or("", |m| m.as_str())
                        )
                    } else {
                        warnings.insert(
                            "跨库或未导出目标链接保留 anynote:// 地址，需要 Anynote 打开。".into(),
                        );
                        c[0].into()
                    }
                })
                .into_owned();
            stage.put(path, body.as_bytes())?;
            resources.push(json!({"noteId":node.id,"revisionId":head,"resources":exported}));
        } else {
            let hash = &pinned[note.primary_resource_id.as_ref().unwrap()];
            stage.copy(path, &book, hash)?;
            let annotations = book.annotations(&node.id, false)?;
            for a in &annotations {
                let asset = &assets[&a.target_asset_hash];
                stage.copy(
                    &format!("_assets/{}.{}", asset.hash, suffix(&asset.mime)),
                    &book,
                    &asset.hash,
                )?;
            }
            if !annotations.is_empty() {
                stage.put(
                    &format!("{path}.annotations.json"),
                    &serde_json::to_vec_pretty(&annotations)?,
                )?;
            }
        }
    }
    stage.put("EXPORT-MAP.json",&serde_json::to_vec_pretty(&json!({"format":"anynote.open-export.v1","notebookId":snapshot.notebook_id(),"resources":resources,"nodes":nodes.iter().map(|n|json!({"id":n.id,"parentId":n.parent_id,"title":n.title,"path":paths[&n.id]})).collect::<Vec<_>>()}))?)?;
    let report = format!(
        "普通 Markdown 导出：仅当前未删除内容。历史、回收站、图片显示尺寸、标签收藏与插件编辑能力不包含；扩展独立状态不包含。白板保留原场景 .scene.json、预览、图片原件与嵌图 Excalidraw 场景；批注为 JSON sidecar，target_asset_hash 对应 _assets 原件。EXPORT-MAP.json 保存目录和名称映射。完整恢复请使用完整 .anynote 导出。\n{}",
        warnings.into_iter().collect::<Vec<_>>().join("\n")
    );
    stage.put("EXPORT-REPORT.txt", report.as_bytes())?;
    cancel.check()?;
    match format {
        OpenExportFormat::Directory => {
            sync_tree(stage.root)?;
            destination(output)?;
            ensure(!target.exists(), "目标在导出期间出现")?;
            fs::rename(stage.root, &target)?;
            sync_directory(target.parent().unwrap())?;
        }
        OpenExportFormat::Zip => {
            let mut entries = stage.entries.into_values().collect::<Vec<_>>();
            for node in nodes.iter().filter(|n| n.kind == NodeKind::Folder) {
                entries.push(ArchiveEntry {
                    path: paths[&node.id].clone(),
                    size: 0,
                    sha256: String::new(),
                    mime_type: None,
                });
            }
            write_zip(directory.path(), output, &entries, None, false, cancel)?;
        }
    }
    Ok(())
}
