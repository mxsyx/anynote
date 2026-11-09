use super::{BoardError, Element, Geometry, Point, scene::invalid};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CropHandle {
    N,
    S,
    W,
    E,
    Nw,
    Ne,
    Sw,
    Se,
}

pub(super) fn crop_image(
    element: &mut Element,
    handle: CropHandle,
    natural_width: f64,
    natural_height: f64,
    pointer: Point,
    aspect_ratio: Option<f64>,
) -> Result<(), BoardError> {
    pointer.validate()?;
    if [natural_width, natural_height]
        .iter()
        .any(|v| !v.is_finite() || *v <= 0.0)
        || aspect_ratio.is_some_and(|v| !v.is_finite() || v <= 0.0)
    {
        return Err(invalid("invalid image dimensions or crop aspect ratio"));
    }
    let g = element.geometry()?;
    if g.width() <= 0.0 || g.height() <= 0.0 {
        return Err(invalid("cannot crop an empty image"));
    }
    let scale: [f64; 2] = serde_json::from_value(
        element
            .field("scale")
            .cloned()
            .ok_or_else(|| invalid("missing image scale"))?,
    )?;
    if scale.iter().any(|v| v.abs() != 1.0) {
        return Err(invalid("invalid image scale"));
    }
    let mut crop = element
        .field("crop")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or_else(|| {
            json!({"x":0.0,"y":0.0,"width":natural_width,"height":natural_height,
            "naturalWidth":natural_width,"naturalHeight":natural_height})
        });
    let number = |name: &str| {
        crop.get(name)
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
            .ok_or_else(|| invalid(format!("invalid crop {name}")))
    };
    let (cx, cy, cw, ch) = (
        number("x")?,
        number("y")?,
        number("width")?,
        number("height")?,
    );
    if number("naturalWidth")? != natural_width
        || number("naturalHeight")? != natural_height
        || cx < -1e-8
        || cy < -1e-8
        || cw <= 0.0
        || ch <= 0.0
        || cx + cw > natural_width + 1e-8
        || cy + ch > natural_height + 1e-8
    {
        return Err(invalid("crop lies outside the decoded image"));
    }
    let uncropped_width = g.width() / (cw / natural_width);
    let uncropped_height = g.height() / (ch / natural_height);
    let ratio_x = natural_width / uncropped_width;
    let ratio_y = natural_height / uncropped_height;
    let left = cx / ratio_x;
    let top = cy / ratio_y;
    let p = pointer.rotate(g.center(), -g.angle());
    let north = matches!(handle, CropHandle::N | CropHandle::Ne | CropHandle::Nw);
    let south = matches!(handle, CropHandle::S | CropHandle::Se | CropHandle::Sw);
    let west = matches!(handle, CropHandle::W | CropHandle::Nw | CropHandle::Sw);
    let east = matches!(handle, CropHandle::E | CropHandle::Ne | CropHandle::Se);
    let flipped_x = scale[0] == -1.0;
    let flipped_y = scale[1] == -1.0;
    let max_width = if west != flipped_x {
        g.width() + left
    } else {
        uncropped_width - left
    };
    let max_height = if north != flipped_y {
        g.height() + top
    } else {
        uncropped_height - top
    };
    let dx = p.x() - g.x() - if east { g.width() } else { 0.0 };
    let dy = p.y() - g.y() - if south { g.height() } else { 0.0 };
    // Excalidraw clamps to 10 scene units, then to the remaining source extent.
    let clamp = |value: f64, max: f64| value.max(10.0).min(max);
    let mut width = if west || east {
        clamp(g.width() + if west { -dx } else { dx }, max_width)
    } else {
        g.width()
    };
    let mut height = if north || south {
        clamp(g.height() + if north { -dy } else { dy }, max_height)
    } else {
        g.height()
    };
    if let Some(ratio) = aspect_ratio {
        match handle {
            CropHandle::N | CropHandle::S => {
                let max =
                    (left + g.width() / 2.0).min(uncropped_width - left - g.width() / 2.0) * 2.0;
                width = clamp(height * ratio, max);
                height = width / ratio;
            }
            CropHandle::W | CropHandle::E => {
                let max =
                    (top + g.height() / 2.0).min(uncropped_height - top - g.height() / 2.0) * 2.0;
                height = clamp(width / ratio, max);
                width = height * ratio;
            }
            _ => {
                let horizontal = match handle {
                    CropHandle::Ne => dx > -dy,
                    CropHandle::Nw => dx < dy,
                    CropHandle::Se => dx > dy,
                    CropHandle::Sw => -dx > dy,
                    _ => unreachable!(),
                };
                if horizontal {
                    height = clamp(width / ratio, max_height);
                    width = height * ratio;
                } else {
                    width = clamp(height * ratio, max_width);
                    height = width / ratio;
                }
            }
        }
    }
    let new_cw = width * ratio_x;
    let new_ch = height * ratio_y;
    let mut new_cx = cx;
    let mut new_cy = cy;
    if (west && !flipped_x) || (east && flipped_x) {
        new_cx += cw - new_cw;
    }
    if (north && !flipped_y) || (south && flipped_y) {
        new_cy += ch - new_ch;
    }
    if aspect_ratio.is_some() {
        if !west && !east {
            new_cx += (cw - new_cw) / 2.0;
        }
        if !north && !south {
            new_cy += (ch - new_ch) / 2.0;
        }
    }
    if [new_cx, new_cy, new_cw, new_ch]
        .iter()
        .any(|v| !v.is_finite())
        || new_cw <= 0.0
        || new_ch <= 0.0
        || new_cx < -1e-8
        || new_cy < -1e-8
        || new_cx + new_cw > natural_width + 1e-8
        || new_cy + new_ch > natural_height + 1e-8
    {
        return Err(invalid("crop result lies outside the decoded image"));
    }
    crop["x"] = json!(new_cx);
    crop["y"] = json!(new_cy);
    crop["width"] = json!(new_cw);
    crop["height"] = json!(new_ch);
    if (new_cw - natural_width).abs() < 1e-4 && (new_ch - natural_height).abs() < 1e-4 {
        crop = Value::Null;
    }
    let x = if west {
        g.x() + g.width() - width
    } else if aspect_ratio.is_some() && !east {
        g.center().x() - width / 2.0
    } else {
        g.x()
    };
    let y = if north {
        g.y() + g.height() - height
    } else if aspect_ratio.is_some() && !south {
        g.center().y() - height / 2.0
    } else {
        g.y()
    };
    let origin = Point(x, y);
    let center = Point(x + width / 2.0, y + height / 2.0);
    let origin = origin
        .rotate(g.center(), g.angle())
        .rotate(center.rotate(g.center(), g.angle()), -g.angle());
    Geometry::new(origin.x(), origin.y(), width, height, g.angle())?.write(element);
    element.fields.insert("crop".into(), crop);
    Ok(())
}
