//! Byte sniffing, bounded static previews and lossless PNG versions. No UI or file I/O.
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, RgbaImage};
use std::{
    io::Cursor,
    sync::{
        Arc, LazyLock, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

pub const MAX_BYTES: usize = 50 * 1024 * 1024;
pub const MAX_PIXELS: u64 = 40_000_000;
pub const MAX_EDGE: u32 = 16_384;
pub const EDIT_PIXELS: u64 = 24_000_000;
// Serial decoding keeps several visible image blocks from multiplying the peak raster budget.
static DECODER: Mutex<()> = Mutex::new(());
static SVG_FONTS: LazyLock<Arc<resvg::usvg::fontdb::Database>> = LazyLock::new(|| {
    let mut fonts = resvg::usvg::fontdb::Database::new();
    fonts.load_font_data(crate::release::FONT.to_vec());
    fonts.load_system_fonts();
    if fonts
        .query(&resvg::usvg::fontdb::Query {
            families: &[resvg::usvg::fontdb::Family::SansSerif],
            ..Default::default()
        })
        .is_none()
    {
        fonts.set_sans_serif_family("Noto Sans");
    }
    Arc::new(fonts)
});

pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug)]
pub struct Metadata {
    pub width: u32,
    pub height: u32,
    pub mime: String,
    pub exif: Vec<(String, String)>,
}
pub struct Preview {
    pub pixels: RgbaImage,
    pub metadata: Metadata,
}
fn check(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err("图片操作已取消".into())
    } else {
        Ok(())
    }
}
fn dimensions(width: u32, height: u32) -> Result<()> {
    if width == 0
        || height == 0
        || width > MAX_EDGE
        || height > MAX_EDGE
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        Err("图片超过 16384 像素边长或 40MP 上限".into())
    } else {
        Ok(())
    }
}
fn sniff(bytes: &[u8]) -> Result<Option<ImageFormat>> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err("图片为空或超过 50 MiB 上限".into());
    }
    if let Ok(format) = image::guess_format(bytes)
        && matches!(
            format,
            ImageFormat::Png
                | ImageFormat::Jpeg
                | ImageFormat::WebP
                | ImageFormat::Gif
                | ImageFormat::Bmp
                | ImageFormat::Ico
                | ImageFormat::Tiff
        )
    {
        return Ok(Some(format));
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]);
    if head.contains("<svg") {
        Ok(None)
    } else {
        Err("不支持的图片格式".into())
    }
}
fn svg(bytes: &[u8]) -> Result<resvg::usvg::Tree> {
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("SVG 超过 4 MiB 预览上限".into());
    }
    let source = std::str::from_utf8(bytes).map_err(|_| "SVG 编码无效")?;
    // DTD and entities are unnecessary for a static preview and can amplify parser work.
    if source.contains("<!DOCTYPE") || source.contains("<!ENTITY") {
        return Err("SVG 不支持 DTD 或实体声明".into());
    }
    let options = resvg::usvg::Options {
        fontdb: SVG_FONTS.clone(),
        image_href_resolver: resvg::usvg::ImageHrefResolver {
            resolve_data: Box::new(|_, _, _| None),
            resolve_string: Box::new(|_, _| None),
        },
        ..Default::default()
    };
    // usvg has no scripting engine; neither file, URL nor data-image resolution is enabled.
    resvg::usvg::Tree::from_data(bytes, &options).map_err(|_| "SVG 无法解析".into())
}
fn decoder(bytes: &[u8], format: ImageFormat) -> Result<impl ImageDecoder + '_> {
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_EDGE);
    limits.max_image_height = Some(MAX_EDGE);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    reader.into_decoder().map_err(|_| "图片无法解码".into())
}
pub fn inspect(bytes: &[u8]) -> Result<Metadata> {
    match sniff(bytes)? {
        Some(format) => {
            let mut decoder = decoder(bytes, format)?;
            let (mut width, mut height) = decoder.dimensions();
            dimensions(width, height)?;
            if decoder.total_bytes() > 160 * 1024 * 1024 {
                return Err("图片解码缓冲区超过预算".into());
            }
            let orientation = decoder.orientation().map_err(|_| "图片方向信息无效")?;
            if matches!(
                orientation,
                image::metadata::Orientation::Rotate90
                    | image::metadata::Orientation::Rotate270
                    | image::metadata::Orientation::Rotate90FlipH
                    | image::metadata::Orientation::Rotate270FlipH
            ) {
                std::mem::swap(&mut width, &mut height);
            }
            let exif = decoder
                .exif_metadata()
                .ok()
                .flatten()
                .map(|b| exif(&b))
                .unwrap_or_default();
            Ok(Metadata {
                width,
                height,
                mime: format.to_mime_type().into(),
                exif,
            })
        }
        None => {
            let tree = svg(bytes)?;
            let s = tree.size().to_int_size();
            dimensions(s.width(), s.height())?;
            Ok(Metadata {
                width: s.width(),
                height: s.height(),
                mime: "image/svg+xml".into(),
                exif: vec![],
            })
        }
    }
}
pub fn preview_edge(width: u32, height: u32, requested: u32) -> u32 {
    let natural = width.max(height);
    [640, 1280, 2560, 4096]
        .into_iter()
        .find(|n| *n >= requested)
        .unwrap_or(4096)
        .min(natural)
}
fn decode(bytes: &[u8], edge: u32, cancel: &AtomicBool) -> Result<Preview> {
    check(cancel)?;
    let metadata = inspect(bytes)?;
    let scale = (edge as f64 / metadata.width.max(metadata.height) as f64).min(1.);
    let width = (metadata.width as f64 * scale).round().max(1.) as u32;
    let height = (metadata.height as f64 * scale).round().max(1.) as u32;
    let pixels = if let Some(format) = sniff(bytes)? {
        let mut decoder = decoder(bytes, format)?;
        let orientation = decoder.orientation().map_err(|_| "图片方向信息无效")?;
        let mut decoded = DynamicImage::from_decoder(decoder).map_err(|_| "图片数据损坏")?;
        check(cancel)?;
        decoded.apply_orientation(orientation);
        if decoded.width() != width || decoded.height() != height {
            decoded.thumbnail_exact(width, height).into_rgba8()
        } else {
            decoded.into_rgba8()
        }
    } else {
        let tree = svg(bytes)?;
        let mut pixmap = resvg::tiny_skia::Pixmap::new(width, height).ok_or("SVG 预览分配失败")?;
        resvg::render(
            &tree,
            resvg::tiny_skia::Transform::from_scale(
                width as f32 / tree.size().width(),
                height as f32 / tree.size().height(),
            ),
            &mut pixmap.as_mut(),
        );
        let mut pixels = pixmap.take();
        // tiny-skia returns premultiplied RGBA; image/GPUI accept straight alpha here.
        for p in pixels.as_chunks_mut::<4>().0 {
            if p[3] > 0 {
                for c in 0..3 {
                    p[c] = (u16::from(p[c]) * 255 / u16::from(p[3])).min(255) as u8;
                }
            }
        }
        RgbaImage::from_raw(width, height, pixels).ok_or("SVG 预览无效")?
    };
    check(cancel)?;
    Ok(Preview { pixels, metadata })
}
pub fn preview(bytes: &[u8], requested: u32, cancel: &AtomicBool) -> Result<Preview> {
    let _guard = DECODER.lock().map_err(|_| "图片解码器不可用")?;
    check(cancel)?;
    let metadata = inspect(bytes)?;
    decode(
        bytes,
        preview_edge(metadata.width, metadata.height, requested),
        cancel,
    )
}
pub fn rotate(bytes: &[u8], turns: u8, cancel: &AtomicBool) -> Result<Vec<u8>> {
    let _guard = DECODER.lock().map_err(|_| "图片解码器不可用")?;
    check(cancel)?;
    let metadata = inspect(bytes)?;
    if u64::from(metadata.width) * u64::from(metadata.height) > EDIT_PIXELS {
        return Err("超过 24MP 的图片暂不支持旋转另存".into());
    }
    let decoded = decode(bytes, MAX_EDGE, cancel)?;
    let pixels = match turns % 4 {
        1 => image::imageops::rotate90(&decoded.pixels),
        2 => image::imageops::rotate180(&decoded.pixels),
        3 => image::imageops::rotate270(&decoded.pixels),
        _ => decoded.pixels,
    };
    check(cancel)?;
    let mut output = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(pixels)
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|_| "图片编码失败")?;
    let bytes = output.into_inner();
    if bytes.len() > MAX_BYTES {
        return Err("旋转后的图片超过 50 MiB 上限".into());
    }
    check(cancel)?;
    Ok(bytes)
}

/// Read only the bounded IFD0/Exif facts used by the reader, never GPS or MakerNote.
fn exif(bytes: &[u8]) -> Vec<(String, String)> {
    let bytes = bytes.strip_prefix(b"Exif\0\0").unwrap_or(bytes);
    let little = bytes.starts_with(b"II");
    if !little && !bytes.starts_with(b"MM") {
        return vec![];
    }
    let u16_at = |at: usize| -> Option<u16> {
        let b: [u8; 2] = bytes.get(at..at.checked_add(2)?)?.try_into().ok()?;
        Some(if little {
            u16::from_le_bytes(b)
        } else {
            u16::from_be_bytes(b)
        })
    };
    let u32_at = |at: usize| -> Option<u32> {
        let b: [u8; 4] = bytes.get(at..at.checked_add(4)?)?.try_into().ok()?;
        Some(if little {
            u32::from_le_bytes(b)
        } else {
            u32::from_be_bytes(b)
        })
    };
    if u16_at(2) != Some(42) {
        return vec![];
    }
    let mut dirs = vec![u32_at(4).unwrap_or(0) as usize];
    let mut output = vec![];
    for depth in 0..2 {
        let Some(&offset) = dirs.get(depth) else {
            break;
        };
        for ix in 0..u16_at(offset).unwrap_or(0).min(256) as usize {
            let at = offset + 2 + ix * 12;
            let Some(tag) = u16_at(at) else {
                break;
            };
            if tag == 0x8769 {
                dirs.push(u32_at(at + 8).unwrap_or(0) as usize);
                continue;
            }
            let name = match tag {
                0x010e => "ImageDescription",
                0x010f => "Make",
                0x0110 => "Model",
                0x0112 => "Orientation",
                0x0131 => "Software",
                0x0132 => "DateTime",
                0x829a => "ExposureTime",
                0x829d => "FNumber",
                0x8827 => "ISOSpeedRatings",
                0x9003 => "DateTimeOriginal",
                0x9004 => "DateTimeDigitized",
                0x920a => "FocalLength",
                0xa002 => "PixelXDimension",
                0xa003 => "PixelYDimension",
                0xa405 => "FocalLengthIn35mmFilm",
                _ => continue,
            };
            let kind = u16_at(at + 2).unwrap_or(0);
            let count = u32_at(at + 4).unwrap_or(0).min(512) as usize;
            let unit = match kind {
                1 | 2 => 1,
                3 => 2,
                4 => 4,
                5 => 8,
                _ => continue,
            };
            let start = if count * unit <= 4 {
                at + 8
            } else {
                u32_at(at + 8).unwrap_or(0) as usize
            };
            if bytes
                .get(start..start.saturating_add(count * unit))
                .is_none()
                || count == 0
            {
                continue;
            }
            let value = match kind {
                2 => String::from_utf8_lossy(&bytes[start..start + count])
                    .trim_end_matches('\0')
                    .to_string(),
                3 => u16_at(start).unwrap_or(0).to_string(),
                4 => u32_at(start).unwrap_or(0).to_string(),
                5 => format!(
                    "{}/{}",
                    u32_at(start).unwrap_or(0),
                    u32_at(start + 4).unwrap_or(0)
                ),
                _ => bytes[start].to_string(),
            };
            output.push((name.into(), value));
        }
    }
    output
}
