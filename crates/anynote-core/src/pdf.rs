//! PDF reading contracts. Coordinates are normalized against the native page transform.
use crate::{asset::AssetScope, document_session::DocumentId, image::ImageRect};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const MAX_INDEX_PAGES: usize = 500;
pub const MAX_INDEX_UTF16: usize = 4_500_000;
pub fn page_marker(page: u16) -> String {
    format!("\n[第 {} 页]\n", u32::from(page) + 1)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IndexState {
    Complete,
    Partial,
    Scanned,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IndexCoverage {
    total: u16,
    pages: u16,
    units: usize,
    state: IndexState,
}
impl IndexCoverage {
    pub fn state(&self) -> IndexState {
        self.state
    }
    pub fn pages(&self) -> u16 {
        self.pages
    }
    pub fn message(&self) -> String {
        match self.state {
            IndexState::Complete => format!("已索引 {} 页文本，可全文搜索", self.pages),
            IndexState::Partial => format!("部分索引：前 {} / {} 页", self.pages, self.total),
            IndexState::Scanned => "扫描文档 · OCR 未启用，正文未加入搜索".into(),
        }
    }
}
#[derive(Debug)]
pub struct IndexBuilder {
    total: u16,
    pages: Vec<String>,
    units: usize,
    truncated: bool,
}
impl IndexBuilder {
    pub fn new(total: u16) -> Option<Self> {
        (total > 0).then_some(Self {
            total,
            pages: vec![],
            units: 0,
            truncated: false,
        })
    }
    pub fn push(&mut self, page: u16, text: String, truncated: bool) -> bool {
        let units = text.encode_utf16().count() + page_marker(page).encode_utf16().count();
        if self.truncated
            || usize::from(page) != self.pages.len()
            || page >= self.total
            || self.pages.len() >= MAX_INDEX_PAGES
            || self.units + units > MAX_INDEX_UTF16
        {
            return false;
        }
        self.units += units;
        self.pages.push(text);
        self.truncated = truncated;
        true
    }
    pub fn finish(self) -> Option<(String, IndexCoverage)> {
        if self.pages.is_empty()
            || (!self.truncated && self.pages.len() < usize::from(self.total).min(MAX_INDEX_PAGES))
        {
            return None;
        }
        let partial = self.truncated || self.pages.len() < usize::from(self.total);
        let has_text = self
            .pages
            .iter()
            .any(|p| p.chars().any(|c| !c.is_whitespace()));
        let coverage = IndexCoverage {
            total: self.total,
            pages: self.pages.len() as u16,
            units: self.units,
            state: if !has_text {
                IndexState::Scanned
            } else if partial {
                IndexState::Partial
            } else {
                IndexState::Complete
            },
        };
        let body = self
            .pages
            .iter()
            .enumerate()
            .map(|(i, t)| format!("{}{t}", page_marker(i as u16)))
            .collect::<String>();
        Some((body, coverage))
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnnotationDraft {
    page: u16,
    rectangles: Vec<ImageRect>,
    quote: String,
    body: String,
}
impl AnnotationDraft {
    pub fn new(page: u16, rectangles: Vec<ImageRect>, quote: String, body: String) -> Self {
        Self {
            page,
            rectangles,
            quote,
            body,
        }
    }
    pub fn page(&self) -> u16 {
        self.page
    }
    pub fn rectangles(&self) -> &[ImageRect] {
        &self.rectangles
    }
    pub fn quote(&self) -> &str {
        &self.quote
    }
    pub fn body(&self) -> &str {
        &self.body
    }
    pub fn is_valid(&self) -> bool {
        self.page > 0
            && !self.rectangles.is_empty()
            && self.rectangles.len() <= 100
            && self.rectangles.iter().all(ImageRect::is_valid)
            && self.quote.encode_utf16().count() <= 10000
            && self.body.encode_utf16().count() <= 10000
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PdfAnnotation {
    id: Uuid,
    hash: String,
    draft: AnnotationDraft,
}
impl PdfAnnotation {
    pub fn new(id: Uuid, hash: String, draft: AnnotationDraft) -> Self {
        Self { id, hash, draft }
    }
    pub fn id(&self) -> Uuid {
        self.id
    }
    pub fn hash(&self) -> &str {
        &self.hash
    }
    pub fn draft(&self) -> &AnnotationDraft {
        &self.draft
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields, rename_all = "snake_case")]
pub enum PdfCommand {
    Load {
        scope: AssetScope,
        hash: String,
    },
    Annotate {
        scope: AssetScope,
        hash: String,
        draft: AnnotationDraft,
    },
    Delete {
        scope: AssetScope,
        hash: String,
        annotation: Uuid,
    },
    Reanchor {
        scope: AssetScope,
        hash: String,
    },
    ReadingNote {
        scope: AssetScope,
        hash: String,
        draft: AnnotationDraft,
        annotation: Option<Uuid>,
    },
    BeginIndex {
        scope: AssetScope,
        hash: String,
        total: u16,
    },
    IndexPage {
        task: Uuid,
        page: u16,
        text: String,
        truncated: bool,
    },
    FinishIndex {
        task: Uuid,
    },
    FailIndex {
        task: Uuid,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields, rename_all = "snake_case")]
pub enum PdfReply {
    Loaded {
        annotations: Vec<PdfAnnotation>,
        current: bool,
        coverage: Option<IndexCoverage>,
    },
    Annotation {
        id: Uuid,
    },
    Note {
        document: DocumentId,
    },
    IndexStarted {
        task: Uuid,
    },
    Indexed {
        coverage: IndexCoverage,
    },
    Ack,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PdfAnchor {
    Page(u16),
    Annotation(Uuid),
}
impl PdfAnchor {
    pub fn parse(value: &str) -> Option<Self> {
        let value = value.trim_start_matches('#');
        if let Some(page) = value.strip_prefix("pdf-page-") {
            return page.parse::<u16>().ok().filter(|p| *p > 0).map(Self::Page);
        }
        value
            .strip_prefix("pdf-annotation-")
            .and_then(|id| Uuid::parse_str(id).ok())
            .map(Self::Annotation)
    }
    pub fn fragment(&self) -> String {
        match self {
            Self::Page(p) => format!("pdf-page-{p}"),
            Self::Annotation(id) => format!("pdf-annotation-{id}"),
        }
    }
}
pub fn return_link(document: &DocumentId, anchor: &PdfAnchor) -> String {
    format!(
        "anynote://notebook/{}/note/{}#{}",
        document.notebook(),
        document.note(),
        anchor.fragment()
    )
}
pub fn reading_body(
    document: &DocumentId,
    draft: &AnnotationDraft,
    annotation: Option<Uuid>,
) -> String {
    let anchor = annotation.map_or(PdfAnchor::Page(draft.page), PdfAnchor::Annotation);
    let quote = draft
        .quote
        .replace("\r\n", "\n")
        .split('\n')
        .map(|line| format!("> {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "# 阅读笔记\n\n{}\n\n{quote}\n\n[返回 PDF 第 {} 页]({})\n",
        draft.body.trim(),
        draft.page,
        return_link(document, &anchor)
    )
}

pub fn search_ranges(text: &str, query: &str) -> Vec<std::ops::Range<usize>> {
    if query.is_empty() || query.len() > 4000 {
        return vec![];
    }
    let Ok(pattern) = regex::RegexBuilder::new(&regex::escape(query))
        .case_insensitive(true)
        .build()
    else {
        return vec![];
    };
    let mut previous = 0;
    let mut units = 0;
    pattern
        .find_iter(text)
        .take(1000)
        .map(|m| {
            units += text[previous..m.start()].encode_utf16().count();
            let start = units;
            units += m.as_str().encode_utf16().count();
            previous = m.end();
            start..units
        })
        .collect()
}

pub fn parse_return_link(value: &str) -> Option<(DocumentId, PdfAnchor)> {
    let value = value.strip_prefix("anynote://notebook/")?;
    let (book, rest) = value.split_once("/note/")?;
    let (note, anchor) = rest.split_once('#')?;
    Some((
        DocumentId::new(Uuid::parse_str(book).ok()?, Uuid::parse_str(note).ok()?),
        PdfAnchor::parse(anchor)?,
    ))
}
