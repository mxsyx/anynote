use regex::Regex;
use serde_json::Value;
use std::{collections::BTreeMap, ops::Range, sync::LazyLock};

static FENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^ {0,3}(`{3,}|~{3,})").unwrap());
static HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^:::anynote\{([^\n]*)\}\r?\n").unwrap());
static ATTRIBUTE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?-u:(\w+))="([^"\n]*)""#).unwrap());

/// A directive keeps its complete source externally; JSON is only a semantic projection.
#[derive(Clone, Debug, PartialEq)]
pub struct Directive {
    attrs: BTreeMap<String, String>,
    data: Option<Value>,
    payload_span: Range<usize>,
}
impl Directive {
    pub fn attrs(&self) -> &BTreeMap<String, String> {
        &self.attrs
    }
    /// `None` means invalid JSON or an unsupported projection (depth > serde budget,
    /// or unpaired UTF-16 surrogates). Its raw payload must remain source-only.
    /// JSON null remains `Some(Value::Null)`.
    pub fn data(&self) -> Option<&Value> {
        self.data.as_ref()
    }
    pub fn payload_span(&self) -> Range<usize> {
        self.payload_span.clone()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Segment {
    span: Range<usize>,
    directive: Option<Directive>,
}
impl Segment {
    pub fn span(&self) -> Range<usize> {
        self.span.clone()
    }
    pub fn directive(&self) -> Option<&Directive> {
        self.directive.as_ref()
    }
}

pub fn fenced_code_ranges(source: &str) -> Vec<Range<usize>> {
    let mut fences = Vec::new();
    let mut fence: Option<(u8, usize, usize)> = None;
    let mut offset = 0;
    for line in source.split_inclusive('\n') {
        if let Some(caps) = FENCE.captures(line) {
            let marker = caps.get(1).unwrap();
            let ch = marker.as_str().as_bytes()[0];
            match fence {
                None => fence = Some((ch, marker.len(), offset)),
                Some((open, len, begin))
                    if open == ch
                        && marker.len() >= len
                        && line[marker.end()..].trim_matches(js_whitespace).is_empty() =>
                {
                    fences.push(begin..offset + line.len());
                    fence = None;
                }
                _ => {}
            }
        }
        offset += line.len();
    }
    if let Some((_, _, begin)) = fence {
        fences.push(begin..source.len());
    }
    fences
}

/// Match the TS fence-aware directive contract, including malformed JSON and attributes.
pub fn parse_blocks(source: &str) -> Vec<Segment> {
    let fences = fenced_code_ranges(source);
    // JS multiline anchors include CR and Unicode line separators, unlike Rust regex anchors.
    let line_starts: Vec<_> = std::iter::once(0)
        .chain(source.char_indices().filter_map(|(ix, ch)| {
            matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}').then_some(ix + ch.len_utf8())
        }))
        .collect();
    let closings: Vec<_> = line_starts
        .iter()
        .filter_map(|&start| {
            let rest = source[start..].strip_prefix(":::")?;
            let trimmed = rest.trim_start_matches([' ', '\t']);
            let end = start + 3 + rest.len() - trimmed.len();
            if trimmed.starts_with("\r\n") {
                Some((start, end + 2))
            } else if trimmed.starts_with('\n') {
                Some((start, end + 1))
            } else if trimmed.is_empty() || trimmed.starts_with(['\r', '\u{2028}', '\u{2029}']) {
                Some((start, end))
            } else {
                None
            }
        })
        .collect();
    let mut result = Vec::new();
    let mut start = 0;
    let mut consumed = 0;
    let mut fence_ix = 0;
    for begin in line_starts {
        if begin < consumed || !source[begin..].starts_with(":::anynote{") {
            continue;
        }
        let Some(caps) = HEADER.captures(&source[begin..]) else {
            continue;
        };
        let payload_start = begin + caps.get(0).unwrap().end();
        let close_ix = closings.partition_point(|&(at, _)| at < payload_start);
        let Some(&(payload_end, end)) = closings.get(close_ix) else {
            continue;
        };
        let found = begin..end;
        consumed = end;
        while fence_ix < fences.len() && fences[fence_ix].end <= found.start {
            fence_ix += 1;
        }
        if fences
            .get(fence_ix)
            .is_some_and(|span| span.contains(&found.start))
        {
            continue;
        }
        if found.start > start {
            result.push(Segment {
                span: start..found.start,
                directive: None,
            });
        }
        let payload = payload_start..payload_end;
        let attrs = ATTRIBUTE
            .captures_iter(&caps[1])
            .map(|attr| (attr[1].to_owned(), attr[2].to_owned()))
            .collect();
        result.push(Segment {
            span: found.clone(),
            directive: Some(Directive {
                attrs,
                data: serde_json::from_str(&source[payload.clone()]).ok(),
                payload_span: payload,
            }),
        });
        start = found.end;
    }
    if start < source.len() || result.is_empty() {
        result.push(Segment {
            span: start..source.len(),
            directive: None,
        });
    }
    result
}

fn js_whitespace(ch: char) -> bool {
    matches!(ch, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
