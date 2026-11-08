use std::{collections::BTreeSet, fmt, sync::Arc};

use serde_json::{Map, Value};

use super::{Geometry, Point};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoardError(pub(crate) String);
impl fmt::Display for BoardError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for BoardError {}
impl From<serde_json::Error> for BoardError {
    fn from(error: serde_json::Error) -> Self {
        Self(error.to_string())
    }
}
pub(crate) fn invalid(message: impl Into<String>) -> BoardError {
    BoardError(message.into())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ElementKind {
    Rectangle,
    Diamond,
    Ellipse,
    Text,
    Line,
    Arrow,
    Freedraw,
    Image,
    Frame,
    MagicFrame,
    Iframe,
    Embeddable,
    Unknown,
}
impl ElementKind {
    fn from_name(name: &str) -> Self {
        match name {
            "rectangle" => Self::Rectangle,
            "diamond" => Self::Diamond,
            "ellipse" => Self::Ellipse,
            "text" => Self::Text,
            "line" => Self::Line,
            "arrow" => Self::Arrow,
            "freedraw" => Self::Freedraw,
            "image" => Self::Image,
            "frame" => Self::Frame,
            "magicframe" => Self::MagicFrame,
            "iframe" => Self::Iframe,
            "embeddable" => Self::Embeddable,
            _ => Self::Unknown,
        }
    }
}

/// A lossless JSON record with typed readers; the record is the only authority.
#[derive(Clone, Debug, PartialEq)]
pub struct Element {
    pub(crate) fields: Map<String, Value>,
}
impl Element {
    pub fn from_json(value: Value) -> Result<Self, BoardError> {
        let Value::Object(fields) = value else {
            return Err(invalid("element must be an object"));
        };
        let element = Self { fields };
        if element.id().is_empty() || element.type_name().is_empty() {
            return Err(invalid("element requires nonempty id and type"));
        }
        if element.kind() != ElementKind::Unknown {
            element.geometry()?;
        }
        Ok(element)
    }
    pub fn id(&self) -> &str {
        self.fields.get("id").and_then(Value::as_str).unwrap_or("")
    }
    pub fn type_name(&self) -> &str {
        self.fields
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
    }
    pub fn kind(&self) -> ElementKind {
        ElementKind::from_name(self.type_name())
    }
    pub fn field(&self, name: &str) -> Option<&Value> {
        self.fields.get(name)
    }
    pub fn to_json(&self) -> Value {
        Value::Object(self.fields.clone())
    }
    pub fn is_deleted(&self) -> bool {
        self.field("isDeleted")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }
    pub fn is_locked(&self) -> bool {
        self.field("locked")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }
    pub fn geometry(&self) -> Result<Geometry, BoardError> {
        Geometry::from_element(self)
    }
    /// Paths may have negative local points: their rotation center is the
    /// point extents' center, not `(width / 2, height / 2)` relative to the origin.
    pub fn world_points(&self) -> Result<Vec<Point>, BoardError> {
        if !matches!(
            self.kind(),
            ElementKind::Line | ElementKind::Arrow | ElementKind::Freedraw
        ) {
            return Err(invalid("element is not a path"));
        }
        let points: Vec<Point> = serde_json::from_value(
            self.field("points")
                .cloned()
                .ok_or_else(|| invalid("missing points"))?,
        )?;
        if points.is_empty() {
            return Err(invalid("empty path"));
        }
        for point in &points {
            point.validate()?;
        }
        let g = self.geometry()?;
        let min_x = points.iter().map(|p| p.x()).fold(f64::INFINITY, f64::min);
        let max_x = points
            .iter()
            .map(|p| p.x())
            .fold(f64::NEG_INFINITY, f64::max);
        let min_y = points.iter().map(|p| p.y()).fold(f64::INFINITY, f64::min);
        let max_y = points
            .iter()
            .map(|p| p.y())
            .fold(f64::NEG_INFINITY, f64::max);
        let center = Point::new(g.x() + (min_x + max_x) / 2.0, g.y() + (min_y + max_y) / 2.0);
        let world: Vec<_> = points
            .into_iter()
            .map(|p| Point::new(g.x() + p.x(), g.y() + p.y()).rotate(center, g.angle()))
            .collect();
        for point in &world {
            point.validate()?;
        }
        Ok(world)
    }
    pub(crate) fn reference(&self, name: &str) -> Option<&str> {
        self.field(name).and_then(Value::as_str)
    }
    pub(crate) fn group_ids(&self) -> Vec<&str> {
        self.field("groupIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect()
    }
}

/// Files and untouched elements are shared across history snapshots.
#[derive(Clone, Debug, PartialEq)]
pub struct Scene {
    pub(crate) elements: Vec<Arc<Element>>,
    pub(crate) fields: Arc<Map<String, Value>>,
    pub(crate) original: Option<Arc<str>>,
}
impl Scene {
    pub fn parse(source: &str) -> Result<Self, BoardError> {
        let mut scene = Self::from_json(serde_json::from_str(source)?)?;
        scene.original = Some(Arc::from(source));
        Ok(scene)
    }
    pub fn from_json(value: Value) -> Result<Self, BoardError> {
        let Value::Object(mut fields) = value else {
            return Err(invalid("scene must be an object"));
        };
        let values = fields
            .remove("elements")
            .ok_or_else(|| invalid("missing elements"))?;
        let Value::Array(values) = values else {
            return Err(invalid("elements must be an array"));
        };
        for name in ["files", "appState"] {
            if fields.get(name).is_some_and(|value| !value.is_object()) {
                return Err(invalid(format!("{name} must be an object")));
            }
        }
        let mut ids = BTreeSet::new();
        let mut elements = Vec::with_capacity(values.len());
        for value in values {
            let element = Element::from_json(value)?;
            if !ids.insert(element.id().to_owned()) {
                return Err(invalid("duplicate element id"));
            }
            elements.push(Arc::new(element));
        }
        Ok(Self {
            elements,
            fields: Arc::new(fields),
            original: None,
        })
    }
    pub fn elements(&self) -> impl ExactSizeIterator<Item = &Element> {
        self.elements.iter().map(AsRef::as_ref)
    }
    pub fn element(&self, id: &str) -> Option<&Element> {
        self.elements().find(|element| element.id() == id)
    }
    pub fn field(&self, name: &str) -> Option<&Value> {
        self.fields.get(name)
    }
    pub fn to_json(&self) -> Value {
        let mut fields = self.fields.as_ref().clone();
        fields.insert(
            "elements".into(),
            Value::Array(self.elements().map(Element::to_json).collect()),
        );
        Value::Object(fields)
    }
    pub fn serialize(&self) -> Result<String, BoardError> {
        match &self.original {
            Some(source) => Ok(source.to_string()),
            None => Ok(serde_json::to_string(&self.to_json())?),
        }
    }
    pub(crate) fn edit(&mut self, id: &str) -> Result<&mut Element, BoardError> {
        let element = self
            .elements
            .iter_mut()
            .find(|element| element.id() == id)
            .ok_or_else(|| invalid(format!("missing element: {id}")))?;
        self.original = None;
        Ok(Arc::make_mut(element))
    }
}
