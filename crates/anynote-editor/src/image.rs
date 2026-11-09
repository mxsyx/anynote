//! Standalone local images share the document transaction and opaque-source contract.
use crate::{
    model::{BlockId, Document},
    source::SourceError,
    transaction::{EditKind, Patch, Transaction},
};
use anynote_core::protocol::markdown::parse_blocks;
use markdown::mdast::Node;
use serde_json::{Value, json};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImageBlock {
    pub resource: String,
    pub alt: String,
    pub title: Option<String>,
    pub width: Option<u32>,
}

fn identity(value: &str) -> bool {
    value.len() == 36 && value.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
}

pub fn parse(source: &str) -> Option<ImageBlock> {
    let blocks = parse_blocks(source);
    if blocks.len() != 1 {
        return None;
    }
    if let Some(d) = blocks[0].directive() {
        if d.attrs().get("type")?.as_str() != "core.image"
            || d.attrs().get("version")?.as_str() != "1"
            || d.attrs().get("id")?.is_empty()
        {
            return None;
        }
        let data = d.data()?.as_object()?;
        let resource = data.get("resourceId")?.as_str()?;
        if !identity(resource) {
            return None;
        }
        let width = match data.get("width") {
            None => None,
            Some(v) => Some(
                u32::try_from(v.as_u64()?)
                    .ok()
                    .filter(|n| (32..=4096).contains(n))?,
            ),
        };
        let string = |key| match data.get(key) {
            None => Some(None),
            Some(v) => v.as_str().map(|v| Some(v.to_owned())),
        };
        return Some(ImageBlock {
            resource: resource.into(),
            alt: string("alt")?.unwrap_or_default(),
            title: string("title")?,
            width,
        });
    }
    let Node::Root(root) = markdown::to_mdast(source, &markdown::ParseOptions::default()).ok()?
    else {
        return None;
    };
    let [Node::Paragraph(p)] = root.children.as_slice() else {
        return None;
    };
    let [Node::Image(image)] = p.children.as_slice() else {
        return None;
    };
    let resource = image.url.strip_prefix("anynote-resource:")?;
    identity(resource).then(|| ImageBlock {
        resource: resource.into(),
        alt: image.alt.clone(),
        title: image.title.clone(),
        width: None,
    })
}

pub fn markdown(resource: &str, alt: &str) -> Option<String> {
    identity(resource).then(|| {
        let alt = alt
            .replace('\\', "\\\\")
            .replace('[', "\\[")
            .replace(']', "\\]")
            .replace(['\r', '\n'], " ");
        format!("![{alt}](anynote-resource:{resource})")
    })
}

pub fn resize(
    document: &Document,
    id: BlockId,
    width: Option<u32>,
    millis: u64,
) -> Result<Transaction, SourceError> {
    if width.is_some_and(|n| !(32..=4096).contains(&n)) {
        return Err(SourceError::InvalidRange);
    }
    let block = document.block(id).ok_or(SourceError::Stale)?;
    let source = &document.source()[block.span()];
    let image = parse(source).ok_or(SourceError::InvalidDirective)?;
    let parts = parse_blocks(source);
    let patch = if let Some(d) = parts[0].directive() {
        let mut data = d
            .data()
            .and_then(Value::as_object)
            .ok_or(SourceError::InvalidDirective)?
            .clone();
        if let Some(width) = width {
            data.insert("width".into(), json!(width));
        } else {
            data.remove("width");
        }
        let span = d.payload_span();
        let old = &source[span.clone()];
        let trailing = &old[old.trim_end_matches([' ', '\t', '\r', '\n']).len()..];
        Patch::new(
            block.span().start + span.start..block.span().start + span.end,
            old,
            serde_json::to_string(&data).unwrap() + trailing,
        )
    } else if let Some(width) = width {
        let mut data = json!({"resourceId":image.resource,"alt":image.alt,"width":width});
        if let Some(title) = image.title {
            data["title"] = json!(title);
        }
        let nl = if document.source().contains("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let replacement = format!(
            ":::anynote{{type=\"core.image\" version=\"1\" id=\"{}\"}}{nl}{data}{nl}:::",
            image.resource
        );
        Patch::new(block.span(), source, replacement)
    } else {
        Patch::new(block.span(), source, source)
    };
    Ok(Transaction::new(
        document.generation(),
        vec![patch],
        EditKind::Format,
        millis,
    ))
}
