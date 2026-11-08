use super::{BoardError, Element, scene::invalid};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Point(pub(super) f64, pub(super) f64);
impl Point {
    pub const fn new(x: f64, y: f64) -> Self {
        Self(x, y)
    }
    pub fn x(self) -> f64 {
        self.0
    }
    pub fn y(self) -> f64 {
        self.1
    }
    pub(crate) fn validate(self) -> Result<(), BoardError> {
        if self.0.is_finite() && self.1.is_finite() {
            Ok(())
        } else {
            Err(invalid("nonfinite coordinate"))
        }
    }
    pub(crate) fn rotate(self, center: Self, angle: f64) -> Self {
        let (sin, cos) = angle.sin_cos();
        Self(
            center.0 + (self.0 - center.0) * cos - (self.1 - center.1) * sin,
            center.1 + (self.0 - center.0) * sin + (self.1 - center.1) * cos,
        )
    }
}

/// Excalidraw stores an unrotated box and rotates it around its center.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Geometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    angle: f64,
}
impl Geometry {
    pub fn new(x: f64, y: f64, width: f64, height: f64, angle: f64) -> Result<Self, BoardError> {
        if ![x, y, width, height, angle].iter().all(|v| v.is_finite())
            || width < 0.0
            || height < 0.0
        {
            return Err(invalid("invalid element geometry"));
        }
        Ok(Self {
            x,
            y,
            width,
            height,
            angle,
        })
    }
    pub(crate) fn validate(self) -> Result<(), BoardError> {
        Self::new(self.x, self.y, self.width, self.height, self.angle).map(|_| ())
    }
    pub(crate) fn from_element(element: &Element) -> Result<Self, BoardError> {
        let number = |name| {
            element
                .field(name)
                .and_then(Value::as_f64)
                .ok_or_else(|| invalid(format!("invalid geometry field: {name}")))
        };
        Self::new(
            number("x")?,
            number("y")?,
            number("width")?,
            number("height")?,
            number("angle")?,
        )
    }
    pub fn x(self) -> f64 {
        self.x
    }
    pub fn y(self) -> f64 {
        self.y
    }
    pub fn width(self) -> f64 {
        self.width
    }
    pub fn height(self) -> f64 {
        self.height
    }
    pub fn angle(self) -> f64 {
        self.angle
    }
    pub fn center(self) -> Point {
        Point(self.x + self.width / 2.0, self.y + self.height / 2.0)
    }
    pub fn local_to_world(self, point: Point) -> Point {
        Point(self.x + point.0, self.y + point.1).rotate(self.center(), self.angle)
    }
    pub fn world_to_local(self, point: Point) -> Point {
        let point = point.rotate(self.center(), -self.angle);
        Point(point.0 - self.x, point.1 - self.y)
    }
    pub fn corners(self) -> [Point; 4] {
        [
            Point(0.0, 0.0),
            Point(self.width, 0.0),
            Point(self.width, self.height),
            Point(0.0, self.height),
        ]
        .map(|point| self.local_to_world(point))
    }
    pub(crate) fn write(self, element: &mut Element) {
        for (key, value) in [
            ("x", self.x),
            ("y", self.y),
            ("width", self.width),
            ("height", self.height),
            ("angle", self.angle),
        ] {
            element.fields.insert(key.into(), json!(value));
        }
    }
    pub(crate) fn translated(self, delta: Point) -> Result<Self, BoardError> {
        Self::new(
            self.x + delta.0,
            self.y + delta.1,
            self.width,
            self.height,
            self.angle,
        )
    }
}
