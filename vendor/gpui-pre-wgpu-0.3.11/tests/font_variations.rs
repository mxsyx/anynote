use gpui::{FontRun, FontWeight, PlatformTextSystem, RenderGlyphParams, font, point, px};
use gpui_wgpu::CosmicTextSystem;
use std::borrow::Cow;
use swash::{
    FontRef,
    scale::{Render, ScaleContext, Source},
    zeno::Format,
};

const CJK: &[u8] = include_bytes!("fonts/NotoSansCJK-SC-subset.ttf");
const STATIC: &[u8] =
    include_bytes!("../../../apps/desktop-rust/assets/fonts/NotoSans-Regular.ttf");
const LATIN: &[u8] = include_bytes!("fonts/NotoSans-subset.ttf");

fn system() -> CosmicTextSystem {
    let system = CosmicTextSystem::new_without_system_fonts("Noto Sans");
    system
        .add_fonts(vec![Cow::Borrowed(LATIN), Cow::Borrowed(CJK)])
        .unwrap();
    system
}

fn raster(system: &CosmicTextSystem, family: &str, weight: f32, scale: f32) -> Vec<u8> {
    raster_char(system, family, weight, scale, '工')
}

fn raster_char(
    system: &CosmicTextSystem,
    family: &str,
    weight: f32,
    scale: f32,
    ch: char,
) -> Vec<u8> {
    let mut requested = font(family);
    requested.weight = FontWeight(weight);
    let font_id = system.font_id(&requested).unwrap();
    let line = system.layout_line(
        &ch.to_string(),
        px(16.),
        &[FontRun {
            len: ch.len_utf8(),
            font_id,
        }],
    );
    let run = &line.runs[0];
    let params = RenderGlyphParams {
        font_id: run.font_id,
        glyph_id: run.glyphs[0].id,
        font_size: px(16.),
        subpixel_variant: point(0, 0),
        scale_factor: scale,
        is_emoji: false,
        subpixel_rendering: false,
        dilation: 0,
    };
    let bounds = system.glyph_raster_bounds(&params).unwrap();
    let (size, bytes) = system.rasterize_glyph(&params, bounds).unwrap();
    if let Ok(directory) = std::env::var("ANYNOTE_FONT_PROBE_DIR") {
        let path =
            std::path::Path::new(&directory).join(format!("{family}-{weight}-{scale}-{ch}.pgm"));
        let mut pgm = format!("P5\n{} {}\n255\n", size.width.0, size.height.0).into_bytes();
        pgm.extend(bytes.iter().map(|b| 255 - b));
        std::fs::write(path, pgm).unwrap();
    }
    bytes
}

fn reference(weight: f32, scale: f32) -> Vec<u8> {
    reference_char(CJK, '工', weight, scale)
}

fn reference_char(bytes: &[u8], ch: char, weight: f32, scale: f32) -> Vec<u8> {
    let face = FontRef::from_index(bytes, 0).unwrap();
    let mut context = ScaleContext::new();
    let mut scaler = context
        .builder(face)
        .size(16. * scale)
        .hint(true)
        .normalized_coords(face.variations().normalized_coords([("wght", weight)]))
        .build();
    Render::new(&[Source::Outline])
        .format(Format::Alpha)
        .render(&mut scaler, face.charmap().map(ch))
        .unwrap()
        .data
}

#[test]
fn variable_cjk_fallback_uses_requested_weight_at_each_scale() {
    let system = system();
    for scale in [1., 1.6666666, 2.] {
        for weight in [400., 700., 400.] {
            let actual = raster(&system, "Noto Sans", weight, scale);
            assert!(
                actual == reference(weight, scale),
                "fallback weight={weight}, scale={scale}"
            );
        }
    }
}

#[test]
fn variable_primary_font_uses_requested_weight_and_separate_cache_entries() {
    let system = system();
    for weight in [400., 700., 100., 400.] {
        assert!(
            raster(&system, "Noto Sans CJK SC", weight, 2.) == reference(weight, 2.),
            "primary weight={weight}"
        );
    }
}

#[test]
fn static_latin_and_variable_fallback_do_not_share_variation_state() {
    let system = CosmicTextSystem::new_without_system_fonts("Noto Sans");
    system
        .add_fonts(vec![Cow::Borrowed(STATIC), Cow::Borrowed(CJK)])
        .unwrap();
    for _ in 0..2 {
        assert!(raster(&system, "Noto Sans CJK SC", 700., 2.) == reference(700., 2.));
        assert!(
            raster_char(&system, "Noto Sans", 400., 2., 'm')
                == reference_char(STATIC, 'm', 400., 2.)
        );
        assert!(raster(&system, "Noto Sans", 400., 2.) == reference(400., 2.));
    }
}

#[test]
fn variable_font_metrics_and_rasterization_use_the_same_weight() {
    let system = system();
    let face = FontRef::from_index(LATIN, 0).unwrap();
    for weight in [400., 700., 400.] {
        let mut requested = font("Noto Sans");
        requested.weight = FontWeight(weight);
        let id = system.font_id(&requested).unwrap();
        let glyph = system.glyph_for_char(id, 'm').unwrap();
        let coords: Vec<i16> = face
            .variations()
            .normalized_coords([("wght", weight)])
            .collect();
        let expected = face.glyph_metrics(&coords).advance_width(glyph.0 as u16);
        assert_eq!(system.advance(id, glyph).unwrap().width, expected);
        assert_eq!(
            system.typographic_bounds(id, glyph).unwrap().size.width,
            expected
        );
        assert!(
            raster_char(&system, "Noto Sans", weight, 2., 'm')
                == reference_char(LATIN, 'm', weight, 2.)
        );
    }
}
