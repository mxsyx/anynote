use anynote_core::image::ImageRect;
use anynote_desktop::image::{
    codec,
    geometry::{Viewport, Zoom, rectangle},
};
use image::{DynamicImage, ImageEncoder, ImageFormat, RgbaImage};
use std::{io::Cursor, sync::atomic::AtomicBool};
fn bytes(format: ImageFormat) -> Vec<u8> {
    let pixels = RgbaImage::from_fn(8, 4, |x, y| {
        image::Rgba([(x * 31) as u8, (y * 63) as u8, 127, 255])
    });
    let mut buffer = Cursor::new(vec![]);
    DynamicImage::ImageRgba8(pixels)
        .write_to(&mut buffer, format)
        .unwrap();
    buffer.into_inner()
}
#[test]
fn current_formats_static_previews_and_lossless_rotation_preserve_original() {
    let cancel = AtomicBool::new(false);
    for format in [
        ImageFormat::Png,
        ImageFormat::Jpeg,
        ImageFormat::WebP,
        ImageFormat::Gif,
        ImageFormat::Bmp,
        ImageFormat::Ico,
        ImageFormat::Tiff,
    ] {
        let bytes = bytes(format);
        let original = bytes.clone();
        let preview = codec::preview(&bytes, 640, &cancel).unwrap();
        assert_eq!((preview.metadata.width, preview.metadata.height), (8, 4));
        let rotated = codec::rotate(&bytes, 1, &cancel).unwrap();
        let decoded = codec::preview(&rotated, 640, &cancel).unwrap();
        assert_eq!(decoded.pixels.dimensions(), (4, 8));
        assert_eq!(decoded.pixels, image::imageops::rotate90(&preview.pixels));
        assert_eq!(bytes, original);
    }
}
#[test]
fn exif_orientation_is_applied_once_and_camera_fact_is_retained() {
    let exif = vec![
        b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
    ];
    let pixels = RgbaImage::from_pixel(8, 4, image::Rgba([1, 2, 3, 255]));
    let mut bytes = vec![];
    let mut encoder = image::codecs::png::PngEncoder::new(&mut bytes);
    encoder.set_exif_metadata(exif).unwrap();
    encoder
        .write_image(&pixels, 8, 4, image::ExtendedColorType::Rgba8)
        .unwrap();
    let cancel = AtomicBool::new(false);
    let p = codec::preview(&bytes, 640, &cancel).unwrap();
    assert_eq!((p.metadata.width, p.metadata.height), (4, 8));
    assert_eq!(p.pixels.dimensions(), (4, 8));
    assert!(
        p.metadata
            .exif
            .iter()
            .any(|(k, v)| k == "Orientation" && v == "6")
    );
    assert_eq!(
        codec::preview(&codec::rotate(&bytes, 1, &cancel).unwrap(), 640, &cancel)
            .unwrap()
            .pixels
            .dimensions(),
        (8, 4)
    );
}
#[test]
fn svg_external_images_scripts_and_entities_have_no_preview_authority() {
    let svg=br##"<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><script>throw 1</script><foreignObject width="80" height="40"><body>bad</body></foreignObject><image href="file:///etc/passwd" width="80" height="40"/><image href="https://example.com/x" width="80" height="40"/><rect width="8" height="4" fill="#ff0000"/></svg>"##;
    let p = codec::preview(svg, 640, &AtomicBool::new(false)).unwrap();
    assert_eq!(p.pixels.get_pixel(0, 0).0, [255, 0, 0, 255]);
    assert_eq!(p.pixels.get_pixel(79, 39).0, [0, 0, 0, 0]);
    assert!(codec::inspect(br#"<!DOCTYPE svg [<!ENTITY x "abc">]><svg/>"#).is_err());
}
#[test]
fn decode_cancel_budgets_and_preview_tiers_are_enforced() {
    let input = bytes(ImageFormat::Png);
    assert!(codec::preview(&input, 640, &AtomicBool::new(true)).is_err());
    assert!(codec::rotate(&input, 1, &AtomicBool::new(true)).is_err());
    assert!(codec::inspect(b"not an image").is_err());
    assert!(
        codec::inspect(b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20000\" height=\"2\"/>")
            .is_err()
    );
    assert_eq!(codec::preview_edge(8000, 5000, 700), 1280);
    assert_eq!(codec::preview_edge(8000, 5000, 8000), 4096);
    assert_eq!(codec::preview_edge(400, 200, 700), 400);
}
#[test]
fn selection_and_history_rectangles_round_trip_all_rotations_zoom_pan_and_dpi() {
    let original = ImageRect {
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.4,
    };
    for turns in 0..4 {
        for dpi in [1., 1.5, 2.] {
            let v = Viewport {
                zoom: Zoom::Scale(2.5),
                turns,
                pan: [-123., 45.],
            };
            let b = v.bounds([600., 400.], [800., 500.], dpi);
            let r = v.displayed_rect(original);
            let a = v.original_point([b[0] + r.x as f32 * b[2], b[1] + r.y as f32 * b[3]], b);
            let z = v.original_point(
                [
                    b[0] + (r.x + r.width) as f32 * b[2],
                    b[1] + (r.y + r.height) as f32 * b[3],
                ],
                b,
            );
            let round = rectangle(a, z).unwrap();
            for (a, b) in [
                (round.x, original.x),
                (round.y, original.y),
                (round.width, original.width),
                (round.height, original.height),
            ] {
                assert!((a - b).abs() < 1e-6);
            }
        }
    }
    assert!(rectangle([0., 0.], [0., 0.]).is_none());
    assert!(
        !ImageRect {
            x: 0.9,
            y: 0.,
            width: 0.5,
            height: 0.5
        }
        .is_valid()
    );
    assert_eq!(
        Viewport {
            zoom: Zoom::Actual,
            ..Default::default()
        }
        .scale([100., 100.], [500., 500.], 2.),
        0.5
    );
}
