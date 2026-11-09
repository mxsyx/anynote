//! Native, inert projection of explicitly marked capture HTML. The source is never rewritten.
use dom_query::{Document, NodeRef};

#[derive(Clone, Debug)]
pub struct CardNode {
    tag: String,
    text: String,
    row: bool,
    centered: bool,
    styles: Vec<CardStyle>,
    children: Vec<CardNode>,
}
impl CardNode {
    pub fn tag(&self) -> &str {
        &self.tag
    }
    pub fn text(&self) -> &str {
        &self.text
    }
    pub fn is_row(&self) -> bool {
        self.row
    }
    pub fn is_centered(&self) -> bool {
        self.centered
    }
    pub fn children(&self) -> &[Self] {
        &self.children
    }
    pub fn styles(&self) -> &[CardStyle] {
        &self.styles
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CardLength {
    Pixels(f32),
    Rem(f32),
    Em(f32),
    Fraction(f32),
    Auto,
}
#[derive(Clone, Debug, PartialEq)]
pub enum CardStyle {
    Color(&'static str, u32),
    Lengths(&'static str, Vec<CardLength>),
    Border(f32, u32),
    Keyword(&'static str, String),
    Weight(f32),
    LineHeight(f32),
}
fn length(raw: &str) -> Option<CardLength> {
    if raw == "auto" {
        return Some(CardLength::Auto);
    }
    if raw == "0" {
        return Some(CardLength::Pixels(0.));
    }
    for (suffix, max) in [("px", 1200.), ("rem", 32.), ("em", 32.), ("%", 100.)] {
        if let Some(n) = raw
            .strip_suffix(suffix)
            .and_then(|n| n.parse::<f32>().ok())
            .filter(|n| n.is_finite() && (0.0..=max).contains(n))
        {
            return Some(match suffix {
                "px" => CardLength::Pixels(n),
                "rem" => CardLength::Rem(n),
                "em" => CardLength::Em(n),
                _ => CardLength::Fraction(n / 100.),
            });
        }
    }
    None
}
fn color(raw: &str) -> Option<u32> {
    let raw = match raw {
        "surface-primary" | "white" => "#ffffff",
        "surface-secondary" => "#f5f6f8",
        "surface-tertiary" => "#eef0f3",
        "primary" => "#20242c",
        "secondary" => "#667085",
        "black" => "#000000",
        "transparent" => return Some(0),
        _ => raw,
    };
    if let Some(hex) = raw.strip_prefix('#') {
        if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let hex = match hex.len() {
            3 | 4 => hex.chars().flat_map(|c| [c, c]).collect::<String>(),
            6 | 8 => hex.into(),
            _ => return None,
        };
        let n = u32::from_str_radix(&hex, 16).ok()?;
        return Some(if hex.len() == 6 { n << 8 | 255 } else { n });
    }
    let (values, alpha) = if let Some(v) = raw.strip_prefix("rgba(") {
        (v, true)
    } else {
        (raw.strip_prefix("rgb(")?, false)
    };
    let values = values
        .strip_suffix(')')?
        .split(',')
        .map(str::trim)
        .collect::<Vec<_>>();
    if values.len() != if alpha { 4 } else { 3 } {
        return None;
    }
    let mut rgba = 0u32;
    for v in &values[..3] {
        rgba = rgba << 8 | v.parse::<u8>().ok()? as u32;
    }
    let opacity = if alpha {
        values[3]
            .parse::<f32>()
            .ok()
            .filter(|v| (0.0..=1.0).contains(v))?
    } else {
        1.
    };
    Some(rgba << 8 | (opacity * 255.).round() as u32)
}
fn style(key: &str, value: &str) -> Option<CardStyle> {
    let property = match key {
        "color" => "color",
        "background" | "background-color" => "background",
        "border-color" => "border-color",
        "padding" => "padding",
        "margin" => "margin",
        "gap" => "gap",
        "border-radius" => "border-radius",
        "font-size" => "font-size",
        "width" => "width",
        "max-width" => "max-width",
        "min-width" => "min-width",
        "flex-wrap" => "flex-wrap",
        "align-items" => "align-items",
        "justify-content" => "justify-content",
        "text-align" => "text-align",
        _ => "",
    };
    if matches!(property, "color" | "background" | "border-color") {
        return color(value).map(|c| CardStyle::Color(property, c));
    }
    if matches!(
        property,
        "padding"
            | "margin"
            | "gap"
            | "border-radius"
            | "font-size"
            | "width"
            | "max-width"
            | "min-width"
    ) {
        let values = value
            .split_whitespace()
            .map(length)
            .collect::<Option<Vec<_>>>()?;
        let max = match property {
            "padding" | "margin" | "border-radius" => 4,
            "gap" => 2,
            _ => 1,
        };
        return (!values.is_empty() && values.len() <= max)
            .then_some(CardStyle::Lengths(property, values));
    }
    let valid = match property {
        "flex-wrap" => matches!(value, "wrap" | "nowrap"),
        "align-items" | "justify-content" => matches!(
            value,
            "center" | "flex-start" | "flex-end" | "stretch" | "space-between"
        ),
        "text-align" => matches!(value, "left" | "center" | "right"),
        _ => false,
    };
    if valid {
        return Some(CardStyle::Keyword(property, value.into()));
    }
    match key {
        "font-weight" => {
            let n = match value {
                "normal" => 400.,
                "bold" => 700.,
                _ => value.parse().ok()?,
            };
            ((100.0..=900.0).contains(&n) && n % 100. == 0.).then_some(CardStyle::Weight(n))
        }
        "line-height" => value
            .parse::<f32>()
            .ok()
            .filter(|n| (1.0..=2.0).contains(n))
            .map(CardStyle::LineHeight),
        "border" if value == "0" => Some(CardStyle::Border(0., 0)),
        "border" => {
            let parts = value.split_whitespace().collect::<Vec<_>>();
            if parts.len() != 3 || parts[1] != "solid" {
                return None;
            }
            let CardLength::Pixels(n) = length(parts[0])? else {
                return None;
            };
            (n <= 4.).then_some(CardStyle::Border(n, color(parts[2])?))
        }
        _ => None,
    }
}
pub fn parse(source: &str) -> Option<CardNode> {
    if source.len() > 256 * 1024 || !source.trim_start().starts_with("<div") {
        return None;
    }
    let document = Document::fragment(source);
    let container = document.select("html");
    let mut roots = container
        .nodes()
        .first()?
        .children_it(false)
        .filter(|node| !node.is_text() || !node.text().trim().is_empty());
    let root = roots.next()?;
    if roots.next().is_some()
        || root.node_name()?.as_ref() != "div"
        || root.attr("data-anynote-card")?.as_ref() != "1"
    {
        return None;
    }
    let mut count = 0;
    project(root, 0, &mut count)
}
fn project(node: NodeRef<'_>, depth: usize, count: &mut usize) -> Option<CardNode> {
    *count += 1;
    if depth > 32 || *count > 2000 {
        return None;
    }
    if node.is_text() {
        return Some(CardNode {
            tag: "text".into(),
            text: node.text().to_string(),
            row: false,
            centered: false,
            styles: vec![],
            children: vec![],
        });
    }
    let tag = node.node_name()?.to_string();
    if !matches!(
        tag.as_str(),
        "div"
            | "span"
            | "p"
            | "strong"
            | "em"
            | "b"
            | "i"
            | "s"
            | "code"
            | "pre"
            | "br"
            | "ul"
            | "ol"
            | "li"
            | "blockquote"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
    ) {
        return None;
    }
    let style = node.attr("style").unwrap_or_default();
    let mut row = matches!(
        tag.as_str(),
        "p" | "span"
            | "strong"
            | "em"
            | "b"
            | "i"
            | "s"
            | "code"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
    );
    let mut centered = false;
    let mut styles = Vec::new();
    // Only native layout hints are interpreted. URLs, CSS and event attributes never execute.
    for declaration in style
        .get(..style.floor_char_boundary(4000.min(style.len())))?
        .split(';')
        .take(100)
    {
        if let Some((key, value)) = declaration.split_once(':') {
            match (key.trim(), value.trim()) {
                ("flex-direction", "row") => row = true,
                ("flex-direction", "column") => row = false,
                ("text-align", "center") | ("align-items", "center") => centered = true,
                _ => (),
            }
            if let Some(safe) = self::style(&key.trim().to_ascii_lowercase(), value.trim()) {
                styles.push(safe);
            }
        }
    }
    let children = node
        .children_it(false)
        .map(|child| project(child, depth + 1, count))
        .collect::<Option<Vec<_>>>()?;
    Some(CardNode {
        tag,
        text: String::new(),
        row,
        centered,
        styles,
        children,
    })
}
