use super::{
    geometry::number,
    text::{self, TextLayout},
};
use anynote_editor::board::{ElementKind, Scene};
use base64::{Engine, engine::general_purpose::STANDARD};
use gpui_kit::RenderImage;
use image::RgbaImage;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Default)]
pub(super) struct Assets {
    pub texts: BTreeMap<String, TextLayout>,
    pub images: BTreeMap<String, Arc<RenderImage>>,
    pub natural_sizes: BTreeMap<String, [f64; 2]>,
    pub errors: Vec<String>,
}
pub(super) fn same_inputs(a: &Scene, b: &Scene) -> bool {
    let media = |scene: &Scene| {
        scene
            .elements()
            .filter(|e| {
                !e.is_deleted() && matches!(e.kind(), ElementKind::Text | ElementKind::Image)
            })
            .map(|e| e.id().to_owned())
            .collect::<std::collections::BTreeSet<_>>()
    };
    let ids = media(a);
    if ids != media(b) {
        return false;
    }
    ids.iter().all(|id| {
        let (a_element, b_element) = (a.element(id).unwrap(), b.element(id).unwrap());
        if a_element.kind() != b_element.kind() {
            return false;
        }
        let fields: &[&str] = if a_element.kind() == ElementKind::Text {
            &["text", "fontSize", "fontFamily", "lineHeight"]
        } else {
            &[
                "fileId", "width", "height", "angle", "crop", "scale", "opacity",
            ]
        };
        fields
            .iter()
            .all(|key| a_element.field(key) == b_element.field(key))
            && (a_element.kind() != ElementKind::Image || {
                let file = a_element
                    .field("fileId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                a.field("files").and_then(|f| f.get(file))
                    == b.field("files").and_then(|f| f.get(file))
            })
    })
}
impl Assets {
    pub fn load(scene: &Scene, cancel: &AtomicBool) -> Self {
        let mut result = Self::default();
        // Bound retained image memory across the scene, in addition to the shared decoder limits.
        let mut pixels = 0u64;
        for e in scene.elements().filter(|e| !e.is_deleted()) {
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            if e.kind() == ElementKind::Text {
                let value = e.field("text").and_then(Value::as_str).unwrap_or("");
                match text::layout(e, value) {
                    Ok(layout) => {
                        result.texts.insert(e.id().into(), layout);
                    }
                    Err(error) => result.errors.push(error),
                }
            }
            if e.kind() != ElementKind::Image {
                continue;
            }
            if pixels >= 16_000_000 {
                result.errors.push("白板图片预览超过 16MP 总预算".into());
                break;
            }
            let image = (|| -> Result<_, String> {
                let id = e
                    .field("fileId")
                    .and_then(Value::as_str)
                    .ok_or("图片没有文件 ID")?;
                let data = scene
                    .field("files")
                    .and_then(|f| f.get(id)?.get("dataURL")?.as_str())
                    .ok_or("图片资源尚未加载")?;
                let bytes = decode_data_url(data)?;
                let preview = crate::image::codec::preview(&bytes, 1280, cancel)?;
                result.natural_sizes.insert(
                    e.id().into(),
                    [
                        preview.metadata.width as f64,
                        preview.metadata.height as f64,
                    ],
                );
                let mut source = preview.pixels;
                if let Some(crop) = e.field("crop").filter(|c| !c.is_null()) {
                    let get = |key: &str| {
                        crop.get(key)
                            .and_then(Value::as_f64)
                            .filter(|n| n.is_finite())
                            .ok_or_else(|| "图片裁剪无效".to_string())
                    };
                    let natural_w = get("naturalWidth")?;
                    let natural_h = get("naturalHeight")?;
                    if natural_w <= 0. || natural_h <= 0. {
                        return Err("图片裁剪尺寸无效".into());
                    }
                    let sx = source.width() as f64 / natural_w;
                    let sy = source.height() as f64 / natural_h;
                    let (x, y, w, h) = (
                        get("x")? * sx,
                        get("y")? * sy,
                        get("width")? * sx,
                        get("height")? * sy,
                    );
                    if x < 0.
                        || y < 0.
                        || w <= 0.
                        || h <= 0.
                        || x + w > source.width() as f64
                        || y + h > source.height() as f64
                    {
                        return Err("图片裁剪越界".into());
                    }
                    source = image::imageops::crop_imm(
                        &source,
                        x as u32,
                        y as u32,
                        (w.round() as u32).max(1).min(source.width() - x as u32),
                        (h.round() as u32).max(1).min(source.height() - y as u32),
                    )
                    .to_image();
                }
                if e.field("scale").and_then(|v| v.get(0)?.as_f64()) == Some(-1.) {
                    source = image::imageops::flip_horizontal(&source);
                }
                if e.field("scale").and_then(|v| v.get(1)?.as_f64()) == Some(-1.) {
                    source = image::imageops::flip_vertical(&source);
                }
                let g = e.geometry().map_err(|e| e.to_string())?;
                let w = g.width().max(1.);
                let h = g.height().max(1.);
                let (sin, cos) = g.angle().sin_cos();
                let bw = w * cos.abs() + h * sin.abs();
                let bh = w * sin.abs() + h * cos.abs();
                let scale = (1280. / bw.max(bh)).min(1.);
                let (ow, oh) = (
                    (bw * scale).ceil().max(1.) as u32,
                    (bh * scale).ceil().max(1.) as u32,
                );
                pixels += u64::from(ow) * u64::from(oh);
                if pixels > 16_000_000 {
                    return Err("白板图片预览超过 16MP 总预算".into());
                }
                let mut target = RgbaImage::new(ow, oh);
                let opacity = number(e, "opacity", 100.).clamp(0., 100.) / 100.;
                for (x, y, p) in target.enumerate_pixels_mut() {
                    if x == 0 && cancel.load(Ordering::Relaxed) {
                        return Err("图片加载已取消".into());
                    }
                    let dx = (x as f64 + 0.5) / scale - bw / 2.;
                    let dy = (y as f64 + 0.5) / scale - bh / 2.;
                    let u = (dx * cos + dy * sin + w / 2.) / w;
                    let v = (-dx * sin + dy * cos + h / 2.) / h;
                    if (0. ..1.).contains(&u) && (0. ..1.).contains(&v) {
                        *p = *source.get_pixel(
                            (u * source.width() as f64) as u32,
                            (v * source.height() as f64) as u32,
                        );
                        p[3] = (p[3] as f64 * opacity).round() as u8;
                        p.0.swap(0, 2);
                    }
                }
                Ok(Arc::new(RenderImage::new(vec![image::Frame::new(target)])))
            })();
            match image {
                Ok(image) => {
                    result.images.insert(e.id().into(), image);
                }
                Err(error) => result.errors.push(format!("{}：{error}", e.id())),
            }
        }
        result
    }
}
pub(super) fn decode_data_url(data: &str) -> Result<Vec<u8>, String> {
    if data.len() > 72 * 1024 * 1024 {
        return Err("图片数据超过上限".into());
    }
    let (prefix, encoded) = data.split_once(',').ok_or("图片数据格式无效")?;
    if !prefix.starts_with("data:image/") || !prefix.ends_with(";base64") {
        return Err("仅支持内嵌 base64 图片".into());
    }
    STANDARD
        .decode(encoded)
        .map_err(|_| "图片 base64 无效".into())
}
