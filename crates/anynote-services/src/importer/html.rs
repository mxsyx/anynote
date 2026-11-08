use super::*;
use dom_query::{Document, NodeRef};
use regex::Regex;
use std::sync::LazyLock;
use url::Url;

pub struct ConvertedHtml {
    pub title: String,
    pub body: String,
    pub fallback: bool,
    pub media: Vec<ImportMedia>,
}
pub fn decode_html(bytes: &[u8], content_type: &str) -> String {
    static CHARSET: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"(?i)charset\s*=\s*["']?([\w-]+)"#).unwrap());
    let prefix = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]);
    let label = CHARSET
        .captures(content_type)
        .or_else(|| CHARSET.captures(&prefix))
        .and_then(|c| c.get(1).map(|m| m.as_str()));
    let encoding = label
        .and_then(|s| encoding_rs::Encoding::for_label(s.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    encoding.decode(bytes).0.into_owned()
}
pub fn convert_html(
    html: &str,
    source: &str,
    page: bool,
    budget: &ImportBudget,
    cancel: &CancellationToken,
) -> ImportResult<ConvertedHtml> {
    check(
        budget.valid() && !html.is_empty() && html.len() as u64 <= budget.html_bytes,
        "HTML 为空或超过预算",
    )?;
    cancelled(cancel)?;
    let original = Document::from(html);
    let mut nodes = 0;
    let mut stack = vec![(original.root(), 0)];
    while let Some((node, depth)) = stack.pop() {
        nodes += 1;
        check(nodes <= 100_000 && depth <= 256, "HTML 结构超过预算")?;
        for child in node.children_it(false) {
            stack.push((child, depth + 1));
        }
    }
    let title = truncate_utf16(original.select("title").text().trim(), 240);
    // Drop active/hidden content before discovery so it cannot become a download request.
    original
        .select("script,style,input,button,template,noscript,svg,math,head base")
        .remove();
    original.select("form").rename("div");
    // Match DOMPurify's attribute removal before the established link conversion rules.
    for link in original.select("a[href]").iter() {
        let href = link.attr("href").unwrap();
        if Url::parse(source)
            .and_then(|b| b.join(&href))
            .is_ok_and(|u| !["http", "https", "mailto"].contains(&u.scheme()))
        {
            link.remove_attr("href");
        }
    }
    for img in original.select("img").iter() {
        let mut source = String::new();
        for attr in [
            "data-src",
            "data-original",
            "data-lazy-src",
            "data-actualsrc",
            "data-original-src",
            "data-lazy",
            "data-echo",
            "data-url",
            "data-image",
        ] {
            if let Some(v) = img.attr(attr).filter(|s| !s.is_empty()) {
                source = v.to_string();
                break;
            }
        }
        if source.is_empty() {
            for attr in ["srcset", "data-srcset", "data-lazy-srcset"] {
                if let Some(v) = img.attr(attr).and_then(|s| pick_srcset(&s)) {
                    source = v;
                    break;
                }
            }
        }
        if !source.is_empty() {
            img.set_attr("src", &source);
        }
    }
    for picture in original.select("picture").iter() {
        let selected = picture
            .select("source")
            .iter()
            .filter(|s| s.attr("type").is_none_or(|t| t.starts_with("image/")))
            .find_map(|s| {
                s.attr("srcset")
                    .or_else(|| s.attr("data-srcset"))
                    .and_then(|s| pick_srcset(&s))
                    .or_else(|| s.attr("src").map(|s| s.to_string()))
            });
        let img = picture.select("img").first();
        if let Some(src) = selected {
            if img.exists() {
                img.set_attr("src", &src);
            } else {
                picture.append_html("<img>");
                picture.select("img").set_attr("src", &src);
            }
        }
        picture.replace_with_selection(&picture.select("img").first());
    }
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let mut media = Vec::new();
    for element in original
        .select("img,video,audio,iframe,object,embed,a[href]")
        .iter()
    {
        let node = *element.nodes().first().unwrap();
        let tag = node.node_name().unwrap_or_default();
        let raw = if tag.as_ref() == "a" {
            element.attr("href")
        } else {
            element
                .attr("src")
                .or_else(|| element.attr("data"))
                .or_else(|| element.select("source").attr("src"))
        }
        .unwrap_or_default()
        .to_string();
        if tag.as_ref() == "a" && !element.has_attr("download") && !attachment(&raw) {
            continue;
        }
        let kind = match tag.as_ref() {
            "img" => MediaKind::Image,
            "video" => MediaKind::Video,
            "audio" => MediaKind::Audio,
            "a" => MediaKind::Attachment,
            _ => MediaKind::Unsupported,
        };
        let name = element
            .attr("alt")
            .or_else(|| element.attr("title"))
            .or_else(|| element.attr("aria-label"))
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                if tag.as_ref() == "a" {
                    element.text().trim().to_owned()
                } else {
                    "媒体".into()
                }
            });
        let mut item = ImportMedia::pending(raw, truncate_utf16(&name, 240), kind);
        if ["iframe", "video", "audio"].contains(&tag.as_ref())
            && let Some(card) = video_card(&item.source, source)
        {
            item.kind = MediaKind::Embed;
            item.status = MediaStatus::Embedded;
            item.extra.insert("video".into(), card);
        }
        let marker = format!("anynote-media-{nonce}-{}", media.len());
        item.marker = Some(marker.clone());
        element.replace_with_html(format!("<p>({marker})</p>"));
        media.push(item);
        check(media.len() <= budget.media_count, "媒体数量超过预算")?;
    }
    let input = original.html().to_string();
    let article = if page {
        None
    } else {
        let config = dom_smoothie::Config {
            max_elements_to_parse: 100_000,
            ..Default::default()
        };
        dom_smoothie::Readability::new(input.as_str(), Some(source), Some(config))
            .ok()
            .and_then(|mut r| r.parse().ok())
    };
    cancelled(cancel)?;
    let fallback = !page && article.is_none();
    let (content, title) = match article {
        Some(a) => (
            a.content.to_string(),
            if a.title.is_empty() { title } else { a.title },
        ),
        None => (input, title),
    };
    let doc = Document::from(content.as_str());
    doc.select(
        "script,style,form,input,button,iframe,video,audio,object,embed,svg,math,template,noscript",
    )
    .remove();
    let body = render(doc.body().unwrap_or(doc.root()), source, 0)?;
    media.retain(|m| body.contains(&format!("({})", m.marker.as_deref().unwrap())));
    Ok(ConvertedHtml {
        title: if title.is_empty() {
            "网页收藏".into()
        } else {
            truncate_utf16(&title, 240)
        },
        body: tidy(&body),
        fallback,
        media,
    })
}
fn pick_srcset(raw: &str) -> Option<String> {
    if raw.trim().starts_with("data:") {
        return raw.split_whitespace().next().map(str::to_owned);
    }
    let mut all = Vec::new();
    for part in raw.split(',') {
        let mut p = part.split_whitespace();
        if let Some(url) = p.next() {
            let d = p.next().unwrap_or("1x");
            let width = d
                .strip_suffix('w')
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(0.);
            let score = if width > 0. {
                width
            } else {
                d.strip_suffix('x')
                    .and_then(|v| v.parse::<f64>().ok())
                    .unwrap_or(0.001)
                    * 1000.
            };
            all.push((url, width, score));
        }
    }
    all.iter()
        .filter(|(_, w, _)| *w <= 4096.)
        .max_by(|a, b| a.2.total_cmp(&b.2))
        .or_else(|| all.iter().max_by(|a, b| a.2.total_cmp(&b.2)))
        .map(|(s, _, _)| s.to_string())
}
fn attachment(raw: &str) -> bool {
    [
        "pdf", "zip", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "epub", "csv", "txt",
    ]
    .contains(
        &raw.split(['?', '#'])
            .next()
            .unwrap_or("")
            .rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
    )
}
fn video_card(raw: &str, base: &str) -> Option<serde_json::Value> {
    let u = Url::parse(base).ok()?.join(raw).ok()?;
    if u.scheme() != "https" || !u.username().is_empty() || u.password().is_some() {
        return None;
    }
    let host = u.host_str()?;
    let path = u.path();
    let (provider, id) = if [
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "youtu.be",
    ]
    .contains(&host)
    {
        let id = if host == "youtu.be" {
            path.trim_start_matches('/').to_owned()
        } else if ["/embed/", "/shorts/", "/v/"]
            .iter()
            .any(|p| path.starts_with(p))
        {
            path.split('/').nth(2)?.to_owned()
        } else {
            u.query_pairs().find(|(k, _)| k == "v")?.1.into_owned()
        };
        if id.len() != 11
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        {
            return None;
        }
        ("youtube", id)
    } else if ["vimeo.com", "www.vimeo.com", "player.vimeo.com"].contains(&host) {
        let id = path
            .trim_start_matches('/')
            .strip_prefix("video/")
            .unwrap_or(path.trim_start_matches('/'))
            .split('/')
            .next()?;
        if !(6..=12).contains(&id.len()) || !id.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        ("vimeo", id.to_owned())
    } else if ["bilibili.com", "www.bilibili.com", "m.bilibili.com"].contains(&host) {
        let id = path.strip_prefix("/video/")?.split('/').next()?;
        if id.len() != 12 || !id.starts_with("BV") || !id.bytes().all(|b| b.is_ascii_alphanumeric())
        {
            return None;
        }
        ("bilibili", id.to_owned())
    } else {
        return None;
    };
    Some(
        serde_json::json!({"provider":provider,"videoId":id,"url":if provider=="youtube"{format!("https://www.youtube.com/watch?v={id}")}else{u.to_string()}}),
    )
}
fn tidy(s: &str) -> String {
    static BLANK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());
    BLANK.replace_all(s.trim(), "\n\n").into_owned()
}
fn escape(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if "\\*_[]`".contains(c) {
            out.push('\\');
        }
        match c {
            '<' => out.push_str("&lt;"),
            _ => out.push(c),
        }
    }
    static LEADING: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^(?:-|\+ |=+|#{1,6} |~~~|>)").unwrap());
    static NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d+)\. ").unwrap());
    if LEADING.is_match(&out) {
        out.insert(0, '\\');
    }
    NUMBER.replace(&out, "$1\\. ").into_owned()
}
fn render(node: NodeRef<'_>, base: &str, depth: usize) -> ImportResult<String> {
    check(depth <= 256, "HTML 结构超过预算")?;
    if node.is_text() {
        static SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\t\r\n ]+").unwrap());
        return Ok(escape(&SPACE.replace_all(&node.text(), " ")));
    }
    let tag = node.node_name().unwrap_or_default();
    if [
        "head", "script", "style", "svg", "math", "template", "noscript",
    ]
    .contains(&tag.as_ref())
    {
        return Ok(String::new());
    }
    if tag.as_ref() == "pre" {
        let text = node.text().to_string();
        let language = node
            .children_it(false)
            .find(|c| c.node_name().is_some_and(|s| s.as_ref() == "code"))
            .and_then(|c| c.attr("class"))
            .and_then(|s| {
                s.split_whitespace()
                    .find_map(|c| c.strip_prefix("language-"))
                    .map(str::to_owned)
            })
            .unwrap_or_default();
        let language: String = language
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || "_+-".contains(*c))
            .collect();
        let fence = if text.contains("```") {
            "~".repeat(
                3.max(
                    text.split('\n')
                        .map(|l| l.chars().take_while(|c| *c == '~').count() + 1)
                        .max()
                        .unwrap_or(3),
                ),
            )
        } else {
            "```".into()
        };
        return Ok(format!(
            "\n\n{fence}{language}\n{}\n{fence}\n\n",
            text.trim_end_matches('\n')
        ));
    }
    if tag.as_ref() == "table" {
        let mut rows = Vec::new();
        for tr in node
            .descendants_it()
            .filter(|n| n.node_name().is_some_and(|s| s.as_ref() == "tr"))
        {
            if tr
                .ancestors_it(None)
                .find(|n| n.node_name().is_some_and(|s| s.as_ref() == "table"))
                .is_none_or(|t| t.id != node.id)
            {
                continue;
            }
            let mut row = Vec::new();
            for cell in tr.children_it(false).filter(|n| {
                n.node_name()
                    .is_some_and(|s| ["td", "th"].contains(&s.as_ref()))
            }) {
                row.push(
                    tidy(&render_children(cell, base, depth + 1)?)
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                        .replace('|', "\\|"),
                );
            }
            rows.push(row);
        }
        let width = rows.iter().map(Vec::len).max().unwrap_or(0);
        if width == 0 {
            return Ok(String::new());
        }
        let mut out = String::from("\n\n");
        for (i, row) in rows.iter().enumerate() {
            out += &format!(
                "| {} |\n",
                (0..width)
                    .map(|j| row.get(j).map(String::as_str).unwrap_or(""))
                    .collect::<Vec<_>>()
                    .join(" | ")
            );
            if i == 0 {
                out += &format!("| {} |\n", vec!["---"; width].join(" | "));
            }
        }
        out.push('\n');
        return Ok(out);
    }
    let content = render_children(node, base, depth + 1)?;
    let t = content.trim();
    Ok(match tag.as_ref() {
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => format!(
            "\n\n{} {t}\n\n",
            "#".repeat(tag.as_bytes()[1] as usize - b'0' as usize)
        ),
        "p" | "div" | "section" | "article" | "header" | "footer" => {
            if t.is_empty() {
                String::new()
            } else {
                format!("\n\n{t}\n\n")
            }
        }
        "br" => "  \n".into(),
        "hr" => "\n\n* * *\n\n".into(),
        "strong" | "b" => format!(
            "**{}**",
            if content.contains("\n\n") {
                content.trim_start()
            } else {
                t
            }
        ),
        "em" | "i" => format!("_{t}_"),
        "code" => {
            let raw = node.text().replace('\n', " ").trim().to_owned();
            let mut longest = 0;
            let mut run = 0;
            for c in raw.chars() {
                if c == '`' {
                    run += 1;
                    longest = longest.max(run);
                } else {
                    run = 0;
                }
            }
            let fence = "`".repeat(longest + 1);
            let pad = if raw.starts_with('`') || raw.ends_with('`') {
                " "
            } else {
                ""
            };
            format!("{fence}{pad}{raw}{pad}{fence}")
        }
        "blockquote" => format!(
            "\n\n{}\n\n",
            tidy(t)
                .lines()
                .map(|l| format!("> {l}"))
                .collect::<Vec<_>>()
                .join("\n")
        ),
        "ul" | "ol" => format!("\n\n{}\n\n", content.trim().replace("\n\n", "\n")),
        "li" => {
            let prefix = if node
                .parent()
                .is_some_and(|p| p.node_name().is_some_and(|s| s.as_ref() == "ol"))
            {
                let index = node
                    .parent()
                    .unwrap()
                    .children_it(false)
                    .filter(|n| n.node_name().is_some_and(|s| s.as_ref() == "li"))
                    .position(|n| n.id == node.id)
                    .unwrap_or(0);
                let start = node
                    .parent()
                    .unwrap()
                    .attr("start")
                    .and_then(|s| s.parse::<i64>().ok())
                    .unwrap_or(1);
                format!("{}.  ", start.saturating_add(index as i64))
            } else {
                "-   ".into()
            };
            format!(
                "\n{prefix}{}\n",
                tidy(t).replace("\n\n", "\n").replace('\n', "\n    ")
            )
        }
        "a" => {
            let raw = node.attr("href").unwrap_or_default();
            let url = Url::parse(base)
                .and_then(|b| b.join(&raw))
                .ok()
                .filter(|u| ["https", "http", "mailto"].contains(&u.scheme()));
            match url {
                Some(u) => format!(
                    "[{content}]({})",
                    u.as_str().replace('(', "%28").replace(')', "%29")
                ),
                None => content,
            }
        }
        _ => content,
    })
}
fn render_children(node: NodeRef<'_>, base: &str, depth: usize) -> ImportResult<String> {
    node.children_it(false)
        .map(|c| render(c, base, depth))
        .collect::<ImportResult<Vec<_>>>()
        .map(|v| v.join(""))
}
