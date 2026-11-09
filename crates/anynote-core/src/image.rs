//! Private desktop image operations. A scope pins every read to a note revision.
use crate::document_session::DocumentId;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageScope {
    pub document: DocumentId,
    pub revision: Uuid,
    pub resource: Uuid,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageRect {
    #[serde(deserialize_with = "coordinate")]
    pub x: f64,
    #[serde(deserialize_with = "coordinate")]
    pub y: f64,
    #[serde(deserialize_with = "coordinate")]
    pub width: f64,
    #[serde(deserialize_with = "coordinate")]
    pub height: f64,
}
// Tagged protocol enums buffer numbers; arbitrary_precision represents them as
// Number maps. Decode via Number so the document's lossless JSON mode remains enabled.
fn coordinate<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<f64, D::Error> {
    let number = serde_json::Number::deserialize(deserializer)?;
    number
        .as_f64()
        .filter(|v| v.is_finite())
        .ok_or_else(|| serde::de::Error::custom("invalid image coordinate"))
}
impl ImageRect {
    pub fn is_valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .into_iter()
            .all(|v| v.is_finite() && (0.0..=1.0).contains(&v))
            && self.width > 0.
            && self.height > 0.
            && self.x + self.width <= 1.0000001
            && self.y + self.height <= 1.0000001
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageAnnotation {
    pub id: Uuid,
    pub hash: String,
    pub rectangles: Vec<ImageRect>,
    pub body: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageRevision {
    pub revision: Uuid,
    pub hash: String,
    pub created_at: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields, rename_all = "snake_case")]
pub enum ImageCommand {
    BeginRead {
        scope: ImageScope,
        token: Uuid,
    },
    Read {
        token: Uuid,
        offset: u64,
        length: u32,
    },
    EndRead {
        token: Uuid,
    },
    Upload {
        document: DocumentId,
        resource: Uuid,
        name: String,
        offset: u64,
        bytes: Vec<u8>,
        complete: bool,
    },
    Release {
        document: DocumentId,
        resources: Vec<Uuid>,
    },
    Info {
        scope: ImageScope,
    },
    Annotations {
        scope: ImageScope,
    },
    Annotate {
        scope: ImageScope,
        hash: String,
        rectangle: ImageRect,
        body: String,
    },
    DeleteAnnotation {
        scope: ImageScope,
        annotation: Uuid,
    },
    Revisions {
        scope: ImageScope,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields, rename_all = "snake_case")]
pub enum ImageReply {
    Chunk {
        bytes: Vec<u8>,
    },
    Uploaded {
        resource: Uuid,
    },
    Info {
        hash: String,
        length: u64,
        mime: String,
    },
    Annotations {
        annotations: Vec<ImageAnnotation>,
    },
    Revisions {
        revisions: Vec<ImageRevision>,
    },
    Ack,
}
