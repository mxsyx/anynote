use super::media::{StagedResource, Staging};
use super::*;
use markdown::mdast::Node;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    ops::Range,
};

pub fn canonical(value: &Value) -> ImportResult<String> {
    Ok(match value {
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|k| Ok(format!(
                        "{}:{}",
                        serde_json::to_string(k)?,
                        canonical(&map[k])?
                    )))
                    .collect::<ImportResult<Vec<_>>>()?
                    .join(",")
            )
        }
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical)
                .collect::<ImportResult<Vec<_>>>()?
                .join(",")
        ),
        Value::Number(n) => {
            let n = n
                .as_f64()
                .filter(|v| v.is_finite())
                .ok_or_else(|| ImportError::invalid("JSON 数值无效"))?;
            ryu_js::Buffer::new().format(n).to_owned()
        }
        _ => serde_json::to_string(value)?,
    })
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Manifest {
    format: String,
    version: u32,
    capture_id: String,
    title: String,
    source: Source,
    body: Body,
    assets: Vec<Asset>,
    missing: Vec<Missing>,
    complete: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Source {
    kind: String,
    url: String,
    captured_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    conversation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    adapter_version: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Body {
    path: String,
    sha256: String,
    size: u64,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Asset {
    path: String,
    sha256: String,
    size: u64,
    mime: String,
    name: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Missing {
    name: String,
    reason: String,
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn utf16(s: &str, max: usize) -> bool {
    s.encode_utf16().count() <= max
}
fn asset_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("assets/") else {
        return false;
    };
    let Some((h, e)) = rest.split_once('.') else {
        return false;
    };
    h.len() == 64
        && h.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        && (1..=10).contains(&e.len())
        && e.bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}
pub(super) struct Capture {
    pub title: String,
    pub body: String,
    pub source: String,
    pub receipt: CaptureReceipt,
    pub resources: Vec<StagedResource>,
    pub report: ImportReport,
}
pub(super) fn prepare(
    mut file: File,
    stage: &mut Staging,
    cancel: &CancellationToken,
) -> ImportResult<Capture> {
    check(
        file.metadata()?.is_file() && file.metadata()?.len() <= 90 * MIB,
        "采集包超过 90 MiB",
    )?;
    let count = crate::archive::preflight_zip(
        &mut file,
        90 * MIB,
        202,
        |name| name == "manifest.json" || name == "content.md" || asset_path(name),
        || cancelled(cancel).map_err(|e| crate::archive::ArchiveError::Invalid(e.message)),
    )
    .map_err(|e| ImportError::invalid(e.to_string()))?;
    let mut zip = zip::ZipArchive::new(file)?;
    check(zip.len() == count, "采集包含重复条目")?;
    let central = zip.central_directory_start();
    let mut ranges = Vec::new();
    for i in 0..zip.len() {
        let entry = zip.by_index(i)?;
        let end = entry
            .data_start()
            .checked_add(entry.compressed_size())
            .ok_or_else(|| ImportError::invalid("采集包范围溢出"))?;
        check(
            entry.header_start() < entry.data_start() && end <= central,
            "采集包数据越界",
        )?;
        ranges.push((entry.header_start(), end));
    }
    ranges.sort_unstable();
    check(
        ranges.windows(2).all(|r| r[0].1 <= r[1].0),
        "采集包数据重叠",
    )?;
    check(zip.len() <= 202, "采集条目过多")?;
    let mut entries = BTreeMap::new();
    let mut total = 0;
    for i in 0..zip.len() {
        cancelled(cancel)?;
        let mut entry = zip.by_index(i)?;
        let name = entry.name().to_owned();
        check(
            name == "manifest.json" || name == "content.md" || asset_path(&name),
            "采集包路径无效",
        )?;
        check(
            !entries.contains_key(&name)
                && !entry.encrypted()
                && matches!(
                    entry.compression(),
                    zip::CompressionMethod::Stored | zip::CompressionMethod::Deflated
                )
                && entry
                    .unix_mode()
                    .is_none_or(|m| m & 0xf000 == 0 || m & 0xf000 == 0x8000),
            "重复、加密或非普通采集条目",
        )?;
        let limit = if name == "manifest.json" {
            MIB
        } else if name == "content.md" {
            8 * MIB
        } else {
            20 * MIB
        };
        check(entry.size() <= limit, "采集条目超过预算")?;
        let mut output = tempfile::NamedTempFile::new_in(stage.dir.path())?;
        let mut hasher = Sha256::new();
        let mut size = 0;
        let mut bytes = [0u8; 64 * 1024];
        loop {
            cancelled(cancel)?;
            let n = entry.read(&mut bytes)?;
            if n == 0 {
                break;
            }
            size += n as u64;
            total += n as u64;
            check(size <= limit && total <= 90 * MIB, "采集包解压超过预算")?;
            hasher.update(&bytes[..n]);
            output.write_all(&bytes[..n])?;
        }
        check(size == entry.size(), "采集条目大小不匹配")?;
        output.seek(SeekFrom::Start(0))?;
        entries.insert(name, (output, size, format!("{:x}", hasher.finalize())));
    }
    let mut metadata = entries
        .remove("manifest.json")
        .ok_or_else(|| ImportError::invalid("缺少采集清单"))?
        .0;
    let mut raw = String::new();
    metadata.read_to_string(&mut raw)?;
    let value: Value = serde_json::from_str(&raw)?;
    for name in ["conversationId", "messageIds", "adapterVersion"] {
        check(
            value["source"].get(name).is_none_or(|v| !v.is_null()),
            "采集可选字段不能为 null",
        )?;
    }
    let canonical_manifest = canonical(&value)?;
    check(canonical_manifest.len() as u64 <= MIB, "采集清单超过预算")?;
    let manifest: Manifest = serde_json::from_str(&canonical_manifest)?;
    check(
        manifest.format == "anynote.capture"
            && manifest.version == 1
            && uuid::Uuid::parse_str(&manifest.capture_id).is_ok()
            && manifest.capture_id.len() == 36,
        "采集格式或身份无效",
    )?;
    check(
        !manifest.title.is_empty()
            && utf16(&manifest.title, 240)
            && ["selection", "chatgpt"].contains(&manifest.source.kind.as_str()),
        "采集标题或来源无效",
    )?;
    let source = crate::network::public_url(&manifest.source.url)?;
    check(
        source.query().is_none()
            && source.fragment().is_none()
            && source.as_str() == manifest.source.url
            && utf16(source.as_str(), 4000),
        "采集来源含隐私字段或未规范化",
    )?;
    let captured = chrono::DateTime::parse_from_rfc3339(&manifest.source.captured_at)
        .map_err(|_| ImportError::invalid("采集时间无效"))?;
    check(
        manifest.source.captured_at.ends_with('Z')
            && manifest
                .source
                .conversation_id
                .as_ref()
                .is_none_or(|s| utf16(s, 200))
            && manifest
                .source
                .adapter_version
                .as_ref()
                .is_none_or(|s| utf16(s, 40))
            && manifest
                .source
                .message_ids
                .as_ref()
                .is_none_or(|v| v.len() <= 10000 && v.iter().all(|s| utf16(s, 200))),
        "采集来源元数据超限",
    )?;
    check(
        manifest.assets.len() + manifest.missing.len() <= stage.budget.media_count
            && manifest.complete == manifest.missing.is_empty()
            && manifest
                .missing
                .iter()
                .all(|m| utf16(&m.name, 240) && utf16(&m.reason, 500)),
        "采集缺失报告无效",
    )?;
    let mut content = entries
        .remove("content.md")
        .ok_or_else(|| ImportError::invalid("缺少正文"))?;
    check(
        manifest.body.path == "content.md"
            && manifest.body.size == content.1
            && manifest.body.sha256 == content.2,
        "采集正文大小或哈希不匹配",
    )?;
    let mut body = String::new();
    content.0.read_to_string(&mut body)?;
    check(
        utf16(&body, 2_000_000) && !body.contains("anynote-resource:"),
        "采集正文超限或含笔记资源",
    )?;
    check(entries.len() == manifest.assets.len(), "未声明的采集文件")?;
    let mut paths = BTreeMap::new();
    let mut hashes = HashSet::new();
    let mut resources = Vec::new();
    let mut report = ImportReport {
        budget: stage.budget.clone(),
        source: Some(source.to_string()),
        final_url: None,
        fetched_at: captured.timestamp_millis().max(0) as u64,
        created_at: timestamp(),
        mode: "capture".into(),
        fallback: false,
        keep_original: false,
        original_html: None,
        media: Vec::new(),
        localized: 0,
        failed: 0,
        bytes: 0,
        extra: BTreeMap::new(),
    };
    for asset in manifest.assets {
        cancelled(cancel)?;
        check(
            asset_path(&asset.path)
                && asset.path.starts_with(&format!("assets/{}.", asset.sha256))
                && hashes.insert(asset.sha256.clone())
                && !asset.name.is_empty()
                && utf16(&asset.name, 240)
                && !asset.mime.is_empty()
                && utf16(&asset.mime, 120),
            "采集资源声明无效",
        )?;
        let mut entry = entries
            .remove(&asset.path)
            .ok_or_else(|| ImportError::invalid("采集资源缺失或重复"))?;
        check(
            asset.size == entry.1 && asset.sha256 == entry.2,
            "采集资源大小或哈希不匹配",
        )?;
        let mime = if asset.mime.starts_with("image/")
            && !["image/png", "image/jpeg", "image/webp"].contains(&asset.mime.as_str())
        {
            "application/octet-stream"
        } else {
            &asset.mime
        };
        let resource = stage.stage_reader(
            entry.0.as_file_mut(),
            mime,
            &asset.name,
            stage.budget.media_bytes,
            cancel,
        )?;
        paths.insert(asset.path, format!("anynote-resource:{}", resource.id));
        let mut item = ImportMedia::pending(
            "采集包".into(),
            asset.name,
            if mime.starts_with("image/") {
                MediaKind::Image
            } else {
                MediaKind::Attachment
            },
        );
        item.status = MediaStatus::Localized;
        item.resource_id = Some(resource.id.clone());
        report.bytes += resource.size;
        report.media.push(item);
        resources.push(resource);
    }
    for missing in manifest.missing {
        let mut item = ImportMedia::pending("采集包".into(), missing.name, MediaKind::Unsupported);
        item.status = MediaStatus::Skipped;
        item.error = Some(missing.reason);
        report.media.push(item);
    }
    report.recount();
    let body = localize_body(&body, &paths)?;
    Ok(Capture {
        title: manifest.title,
        body,
        source: source.to_string(),
        receipt: CaptureReceipt {
            capture_id: manifest.capture_id,
            digest: hash(canonical_manifest.as_bytes()),
        },
        resources,
        report,
    })
}
pub(super) fn localize_body(body: &str, paths: &BTreeMap<String, String>) -> ImportResult<String> {
    let root = markdown::to_mdast(body, &markdown::ParseOptions::gfm())
        .map_err(|_| ImportError::invalid("采集 Markdown 无效"))?;
    let mut stack = vec![&root];
    let mut replacements = Vec::new();
    while let Some(node) = stack.pop() {
        if let Some(children) = node.children() {
            stack.extend(children);
        }
        if let Node::Html(html) = node {
            static RAW: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
                regex::Regex::new(r"(?i)<(?:img|audio|video|source|iframe|object|embed|a)\b")
                    .unwrap()
            });
            check(
                !RAW.is_match(&html.value),
                "采集 HTML 媒体或链接必须转为 Markdown",
            )?;
        }
        let (url, definition) = match node {
            Node::Link(n) => (&n.url, false),
            Node::Image(n) => (&n.url, false),
            Node::Definition(n) => (&n.url, true),
            _ => continue,
        };
        let Some(target) = paths.get(url) else {
            check(
                url.starts_with('#')
                    || url.split(':').next().is_some_and(|s| {
                        ["https", "http", "mailto"].contains(&s.to_ascii_lowercase().as_str())
                    }),
                "采集正文包含未声明或不安全的资源引用",
            )?;
            continue;
        };
        let p = node.position().unwrap();
        let range = destination_range(&body[p.start.offset..p.end.offset], definition)
            .ok_or_else(|| ImportError::invalid("无法定位采集链接"))?;
        replacements.push((
            p.start.offset + range.start..p.start.offset + range.end,
            target,
        ));
    }
    replacements.sort_by_key(|(r, _)| r.start);
    let mut result = body.to_owned();
    for (range, target) in replacements.into_iter().rev() {
        result.replace_range(range, target);
    }
    Ok(result)
}
fn destination_range(s: &str, definition: bool) -> Option<Range<usize>> {
    let bytes = s.as_bytes();
    let mut at = usize::from(bytes.first() == Some(&b'!'));
    if bytes.get(at) != Some(&b'[') {
        return None;
    }
    at += 1;
    let mut depth = 1;
    while at < bytes.len() {
        if bytes[at] == b'\\' {
            at += 2;
            continue;
        }
        if bytes[at] == b'[' {
            depth += 1;
        }
        if bytes[at] == b']' {
            depth -= 1;
            if depth == 0 {
                at += 1;
                break;
            }
        }
        at += 1;
    }
    while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
        at += 1;
    }
    if bytes.get(at) != Some(&if definition { b':' } else { b'(' }) {
        return None;
    }
    at += 1;
    while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
        at += 1;
    }
    let angled = bytes.get(at) == Some(&b'<');
    if angled {
        at += 1;
    }
    let start = at;
    depth = 0;
    while at < bytes.len() {
        let c = bytes[at];
        if c == b'\\' {
            at += 2;
            continue;
        }
        if angled {
            if c == b'>' {
                break;
            }
        } else {
            if c == b'(' {
                depth += 1;
            }
            if c == b')' {
                if depth == 0 {
                    break;
                }
                depth -= 1;
            }
            if c.is_ascii_whitespace() && depth == 0 {
                break;
            }
        }
        at += 1;
    }
    (at <= bytes.len()).then_some(start..at)
}
