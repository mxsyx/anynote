//! Shipped block schemas. Unknown types or versions stay source-editable atoms.
use crate::{
    model::{BlockId, Document},
    source::SourceError,
    transaction::{EditKind, Patch, Transaction},
};
use anynote_core::protocol::rich::Content;
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Presentation {
    Callout,
    Details,
}
#[derive(Clone, Debug)]
pub struct Field {
    key: &'static str,
    label: &'static str,
    value: String,
}
impl Field {
    pub fn key(&self) -> &'static str {
        self.key
    }
    pub fn label(&self) -> &'static str {
        self.label
    }
    pub fn value(&self) -> &str {
        &self.value
    }
}
#[derive(Clone, Debug)]
pub struct BuiltinBlock {
    title: &'static str,
    presentation: Presentation,
    fields: Vec<Field>,
}
impl BuiltinBlock {
    pub fn title(&self) -> &'static str {
        self.title
    }
    pub fn presentation(&self) -> Presentation {
        self.presentation
    }
    pub fn fields(&self) -> &[Field] {
        &self.fields
    }
    pub fn read(document: &Document, id: BlockId) -> Option<Self> {
        let Content::Directive(d) = document.block(id)?.parsed().content() else {
            return None;
        };
        if d.attrs().get("version").map(String::as_str) != Some("1") {
            return None;
        }
        let (title, presentation, keys): (_, _, &[(&str, &str)]) =
            match d.attrs().get("type")?.as_str() {
                "garden.reading.card" => (
                    "阅读卡片",
                    Presentation::Callout,
                    &[("quote", "摘录"), ("thought", "思考")],
                ),
                "core.callout" => (
                    "提示块",
                    Presentation::Callout,
                    &[("title", "标题"), ("body", "内容")],
                ),
                "core.details" => (
                    "折叠块",
                    Presentation::Details,
                    &[("title", "标题"), ("body", "内容")],
                ),
                _ => return None,
            };
        let data = d.data()?.as_object()?;
        let mut fields = Vec::new();
        for &(key, label) in keys {
            let value = match data.get(key) {
                None => "",
                Some(Value::String(s)) => s,
                _ => return None,
            };
            fields.push(Field {
                key,
                label,
                value: value.into(),
            });
        }
        Some(Self {
            title,
            presentation,
            fields,
        })
    }
}

pub fn edit_fields(
    document: &Document,
    id: BlockId,
    generation: u64,
    values: &[(&str, String)],
    millis: u64,
) -> Result<Transaction, SourceError> {
    if document.generation() != generation {
        return Err(SourceError::Stale);
    }
    let block = BuiltinBlock::read(document, id).ok_or(SourceError::InvalidDirective)?;
    if values.iter().any(|(key, value)| {
        value.encode_utf16().count() > 2000 || !block.fields.iter().any(|f| f.key == *key)
    }) {
        return Err(SourceError::InvalidDirective);
    }
    let span = document.block(id).ok_or(SourceError::Stale)?.span();
    let original = &document.source()[span.clone()];
    // Reuse the lossless directive serializer; the returned transaction owns history.
    let mut local = Document::new(original.into());
    let local_id = local.blocks()[0].id();
    for (key, value) in values {
        local.set_directive_field(
            local.generation(),
            local_id,
            key,
            Value::String(value.clone()),
        )?;
    }
    Ok(Transaction::new(
        generation,
        vec![Patch::new(span, original, local.source())],
        EditKind::Format,
        millis,
    ))
}

pub fn insert(kind: &str, id: &str) -> Option<String> {
    let data = match kind {
        "garden.reading.card" => json!({"quote":"记录值得留下的文字","thought":"我的理解"}),
        "core.callout" | "core.details" => json!({"title":"标题","body":"内容"}),
        _ => return None,
    };
    if !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
        return None;
    }
    Some(format!(
        ":::anynote{{type=\"{kind}\" version=\"1\" id=\"{id}\"}}\n{data}\n:::\n"
    ))
}
