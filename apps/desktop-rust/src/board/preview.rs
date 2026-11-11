use super::{
    assets::Assets,
    geometry::{bounds, is_path, number, outline},
};
use anynote_editor::board::{ElementKind, Point, Scene};
use resvg::tiny_skia::*;
use serde_json::Value;
use std::sync::atomic::AtomicBool;

fn color(value: Option<&Value>, fallback: &str, opacity: f32) -> Color {
    let value = value.and_then(Value::as_str).unwrap_or(fallback);
    let rgba = gpui_kit::Rgba::try_from(value).unwrap_or(gpui_kit::Rgba {
        r: 0.,
        g: 0.,
        b: 0.,
        a: 0.,
    });
    Color::from_rgba(rgba.r, rgba.g, rgba.b, rgba.a * opacity).unwrap_or(Color::TRANSPARENT)
}
fn path(points: &[Point]) -> Option<Path> {
    let first = points.first()?;
    let mut p = PathBuilder::new();
    p.move_to(first.x() as f32, first.y() as f32);
    for v in &points[1..] {
        p.line_to(v.x() as f32, v.y() as f32);
    }
    p.finish()
}
/// Bounded, light-background PNG using the native board's geometry, fonts and image transforms.
pub fn png(scene: &Scene) -> Result<Vec<u8>, String> {
    let assets = Assets::load(scene, &AtomicBool::new(false));
    if !assets.errors.is_empty() {
        return Err(assets.errors.join("；"));
    }
    let points: Vec<_> = scene
        .elements()
        .filter(|e| !e.is_deleted())
        .flat_map(outline)
        .collect();
    let b = bounds(&points).unwrap_or([0., 0., 320., 180.]);
    let width = (b[2] - b[0] + 32.).max(1.);
    let height = (b[3] - b[1] + 32.).max(1.);
    let scale = (1280. / width.max(height)).min(1.) as f32;
    let transform = Transform::from_row(
        scale,
        0.,
        0.,
        scale,
        ((16. - b[0]) as f32) * scale,
        ((16. - b[1]) as f32) * scale,
    );
    let mut target = Pixmap::new(
        (width as f32 * scale).ceil().max(1.) as u32,
        (height as f32 * scale).ceil().max(1.) as u32,
    )
    .ok_or("白板预览尺寸无效")?;
    let background = scene
        .field("appState")
        .and_then(|v| v.get("viewBackgroundColor"));
    target.fill(color(background, "#ffffff", 1.));
    for e in scene.elements().filter(|e| !e.is_deleted()) {
        let mask = super::geometry::frame_clip(scene, e).and_then(|b| {
            let rect = Rect::from_xywh(
                b[0] as f32,
                b[1] as f32,
                (b[2] - b[0]) as f32,
                (b[3] - b[1]) as f32,
            )?;
            let mut mask = Mask::new(target.width(), target.height())?;
            mask.fill_path(
                &PathBuilder::from_rect(rect),
                FillRule::Winding,
                true,
                transform,
            );
            Some(mask)
        });
        let opacity = (number(e, "opacity", 100.) / 100.).clamp(0., 1.) as f32;
        let mut paint = Paint::default();
        paint.set_color(color(e.field("strokeColor"), "#1e1e1e", opacity));
        let points = outline(e);
        if e.kind() == ElementKind::Image {
            let image = assets.images.get(e.id()).ok_or("白板图片预览缺失")?;
            let size = image.size(0);
            let (w, h) = (u32::from(size.width), u32::from(size.height));
            let mut bytes = image.as_bytes(0).ok_or("白板图片为空")?.to_vec();
            for pixel in bytes.as_chunks_mut::<4>().0 {
                pixel.swap(0, 2);
                for c in 0..3 {
                    pixel[c] = ((u16::from(pixel[c]) * u16::from(pixel[3]) + 127) / 255) as u8;
                }
            }
            let image = Pixmap::from_vec(bytes, IntSize::from_wh(w, h).ok_or("图片尺寸无效")?)
                .ok_or("图片像素无效")?;
            let b = bounds(&points).ok_or("图片边界无效")?;
            let image_transform = Transform::from_row(
                (b[2] - b[0]) as f32 / w as f32,
                0.,
                0.,
                (b[3] - b[1]) as f32 / h as f32,
                b[0] as f32,
                b[1] as f32,
            );
            target.draw_pixmap(
                0,
                0,
                image.as_ref(),
                &PixmapPaint::default(),
                transform.pre_concat(image_transform),
                mask.as_ref(),
            );
        } else if e.kind() == ElementKind::Text {
            let layout = assets.texts.get(e.id()).ok_or("白板字体不可用")?;
            let g = e.geometry().map_err(|e| e.to_string())?;
            let align = match e.field("textAlign").and_then(Value::as_str) {
                Some("center") => 0.5,
                Some("right") => 1.,
                _ => 0.,
            };
            let offset = (g.width() - layout.width) * align;
            let a = g.local_to_world(Point::new(offset, 0.));
            let x = g.local_to_world(Point::new(offset + 1., 0.));
            let y = g.local_to_world(Point::new(offset, 1.));
            let t = transform.pre_concat(Transform::from_row(
                (x.x() - a.x()) as f32,
                (x.y() - a.y()) as f32,
                (y.x() - a.x()) as f32,
                (y.y() - a.y()) as f32,
                a.x() as f32,
                a.y() as f32,
            ));
            for p in &layout.paths {
                target.fill_path(p, &paint, FillRule::Winding, t, mask.as_ref());
            }
        } else if let Some(p) = path(&points) {
            let width = number(e, "strokeWidth", 1.).clamp(0., 100.) as f32;
            let mut stroke = Stroke {
                width,
                ..Default::default()
            };
            stroke.dash = match e.field("strokeStyle").and_then(Value::as_str) {
                Some("dashed") => StrokeDash::new(vec![width * 5., width * 3.], 0.),
                Some("dotted") => StrokeDash::new(vec![width, width * 3.], 0.),
                _ => None,
            };
            if !is_path(e) {
                let mut fill = Paint::default();
                fill.set_color(color(e.field("backgroundColor"), "transparent", opacity));
                if e.field("fillStyle")
                    .and_then(Value::as_str)
                    .unwrap_or("solid")
                    == "solid"
                {
                    target.fill_path(&p, &fill, FillRule::Winding, transform, mask.as_ref());
                } else {
                    for cross in [false, true] {
                        if cross
                            && e.field("fillStyle").and_then(Value::as_str) != Some("cross-hatch")
                        {
                            continue;
                        }
                        super::geometry::hatch_lines(&points, cross, |pair| {
                            if let Some(p) = path(&pair) {
                                target.stroke_path(
                                    &p,
                                    &fill,
                                    &Stroke::default(),
                                    transform,
                                    mask.as_ref(),
                                );
                            }
                        });
                    }
                }
            }
            if width > 0. {
                for points in super::geometry::strokes(e) {
                    if let Some(p) = path(&points) {
                        target.stroke_path(&p, &paint, &stroke, transform, mask.as_ref());
                    }
                }
            }
            stroke.dash = None;
            for head in super::geometry::arrowheads(e, &points) {
                if let Some(p) = path(&head.points) {
                    if head.filled {
                        target.fill_path(&p, &paint, FillRule::Winding, transform, mask.as_ref());
                    } else {
                        target.stroke_path(&p, &paint, &stroke, transform, mask.as_ref());
                    }
                }
            }
        }
    }
    target.encode_png().map_err(|e| e.to_string())
}
