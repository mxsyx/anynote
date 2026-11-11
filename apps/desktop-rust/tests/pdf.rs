#![cfg(feature = "media")]
use anynote_desktop::pdf::{PdfError, Zoom, engine};
use std::{
    io::{Cursor, Read, Seek, SeekFrom},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/pdf")
            .join(name),
    )
    .unwrap()
}
#[test]
fn rotated_crop_mixed_text_and_raster_share_native_geometry() {
    let doc = engine::open(Cursor::new(fixture("geometry.pdf")), None).unwrap();
    assert_eq!(doc.page_count().unwrap(), 8);
    for page in 0..8 {
        let rendered = engine::render(&doc, page, 960, true, || false).unwrap();
        let geo = rendered.geometry();
        assert_eq!(geo.crop_box(), [40., 30., 360., 270.]);
        assert_eq!(geo.rotation(), (page % 4) * 90);
        assert_eq!(
            geo.size(),
            if page % 2 == 0 {
                [320., 240.]
            } else {
                [240., 320.]
            }
        );
        assert!(
            rendered
                .text()
                .contains(&format!("Anynote page {}", page + 1))
        );
        assert!(rendered.text().contains("中文测试"), "{}", rendered.text());
        assert!(rendered.text().contains("Mixed fonts 123"));
        for point in [[40., 30.], [360., 270.], [100., 150.], [85., 70.]] {
            let inverse = geo.to_page(geo.to_normalized(point));
            for axis in 0..2 {
                assert!((point[axis] - inverse[axis]).abs() < 0.001);
            }
        }
        let red = geo.to_normalized([85., 70.]);
        let pixels = rendered.pixels();
        let pixel = pixels.get_pixel(
            (red[0] * pixels.width() as f64) as u32,
            (red[1] * pixels.height() as f64) as u32,
        );
        assert!(
            pixel[0] > 240 && pixel[1] < 20 && pixel[2] < 20,
            "page {page}: {pixel:?}"
        );
        let first = rendered.glyphs().iter().find(|g| g.text() == "A").unwrap();
        let quad = geo.normalized_quad(first.bounds().unwrap());
        let left = quad.iter().map(|p| p[0]).fold(f64::INFINITY, f64::min);
        let right = quad.iter().map(|p| p[0]).fold(f64::NEG_INFINITY, f64::max);
        let top = quad.iter().map(|p| p[1]).fold(f64::INFINITY, f64::min);
        let bottom = quad.iter().map(|p| p[1]).fold(f64::NEG_INFINITY, f64::max);
        let black = ((top * pixels.height() as f64) as u32
            ..=(bottom * pixels.height() as f64) as u32)
            .any(|y| {
                ((left * pixels.width() as f64) as u32..=(right * pixels.width() as f64) as u32)
                    .any(|x| pixels.get_pixel(x, y)[0] < 100)
            });
        assert!(black, "glyph bounds miss native pixels on page {page}");
        assert_eq!(
            rendered.glyphs().last().unwrap().utf16_range().end,
            rendered.text().encode_utf16().count()
        );
        assert!(rendered.glyphs().iter().any(|g| g.angle().abs() > 1.));
        if page == 0 {
            let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm25");
            std::fs::create_dir_all(&dir).unwrap();
            pixels.save(dir.join("geometry.png")).unwrap();
        }
        let small = engine::render(&doc, page, 160, false, || false).unwrap();
        assert!(small.glyphs().is_empty());
        assert_eq!(
            geo.to_normalized([100., 150.]),
            small.geometry().to_normalized([100., 150.])
        );
    }
}
#[test]
fn password_invalid_range_and_cancellation_are_explicit() {
    assert!(matches!(
        engine::open(Cursor::new(fixture("encrypted.pdf")), None),
        Err(PdfError::Password)
    ));
    assert!(matches!(
        engine::open(Cursor::new(fixture("encrypted.pdf")), Some("wrong")),
        Err(PdfError::Password)
    ));
    let doc = engine::open(Cursor::new(fixture("encrypted.pdf")), Some("rm25-test")).unwrap();
    assert!(
        engine::render(&doc, 0, 640, true, || false)
            .unwrap()
            .text()
            .contains("Anynote")
    );
    assert!(matches!(
        engine::render(&doc, 0, 640, true, || true),
        Err(PdfError::Cancelled)
    ));
    assert!(matches!(
        engine::render(&doc, 500, 640, true, || false),
        Err(PdfError::Invalid)
    ));
    assert!(matches!(
        engine::render(&doc, 0, 50_000, true, || false),
        Err(PdfError::Budget)
    ));
    assert!(engine::open(Cursor::new(b"invalid PDF".to_vec()), None).is_err());
}
#[test]
fn frozen_real_pdf_and_fit_modes() {
    let bytes = std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/rust-migration/corpus/media/three-pages.pdf"),
    )
    .unwrap();
    let doc = engine::open(Cursor::new(bytes), None).unwrap();
    assert_eq!(doc.page_count().unwrap(), 3);
    assert!(
        !engine::render(&doc, 2, 640, true, || false)
            .unwrap()
            .text()
            .is_empty()
    );
    let real = engine::open(Cursor::new(fixture("w3c-dummy.pdf")), None).unwrap();
    let rendered = engine::render(&real, 0, 960, true, || false).unwrap();
    assert_eq!(rendered.text().trim(), "Dummy PDF file");
    assert!(
        rendered
            .glyphs()
            .iter()
            .any(|glyph| glyph.bounds().is_some())
    );
    assert_eq!(Zoom::FitPage.scale([320., 640.], [800., 800.]), 1.25);
    assert_eq!(Zoom::FitWidth.scale([320., 640.], [800., 800.]), 2.5);
}
struct Counted {
    file: std::fs::File,
    bytes: Arc<AtomicUsize>,
}
impl Read for Counted {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.file.read(buf)?;
        self.bytes.fetch_add(n, Ordering::Relaxed);
        Ok(n)
    }
}
impl Seek for Counted {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.file.seek(pos)
    }
}
#[test]
fn hundred_megabyte_pdf_reads_ranges_without_loading_unreferenced_stream() {
    use std::io::Write;
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm25/large.pdf");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut file = std::fs::File::create(&path).unwrap();
    file.write_all(b"%PDF-1.7\n").unwrap();
    let mut offsets = vec![0];
    for object in [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Contents 4 0 R >>",
        "<< /Length 25 >>\nstream\n1 0 0 rg 20 20 40 40 re f\nendstream",
    ] {
        offsets.push(file.stream_position().unwrap());
        writeln!(file, "{} 0 obj\n{}\nendobj", offsets.len() - 1, object).unwrap();
    }
    offsets.push(file.stream_position().unwrap());
    writeln!(file, "5 0 obj\n<< /Length {} >>\nstream", 100 * 1024 * 1024).unwrap();
    file.seek(SeekFrom::Current(100 * 1024 * 1024)).unwrap();
    writeln!(file, "\nendstream\nendobj").unwrap();
    let xref = file.stream_position().unwrap();
    writeln!(file, "xref\n0 6\n0000000000 65535 f ").unwrap();
    for offset in offsets.iter().skip(1) {
        writeln!(file, "{offset:010} 00000 n ").unwrap();
    }
    writeln!(
        file,
        "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF"
    )
    .unwrap();
    drop(file);
    let bytes = Arc::new(AtomicUsize::new(0));
    let reader = Counted {
        file: std::fs::File::open(&path).unwrap(),
        bytes: bytes.clone(),
    };
    let doc = engine::open(reader, None).unwrap();
    let image = engine::render(&doc, 0, 640, true, || false).unwrap();
    assert_eq!(image.pixels().width(), 640);
    let normalized = image.geometry().to_normalized([40., 40.]);
    let pixel = image.pixels().get_pixel(
        (normalized[0] * 640.) as u32,
        (normalized[1] * image.pixels().height() as f64) as u32,
    );
    assert!(pixel[0] > 240 && pixel[1] < 20 && pixel[2] < 20);
    assert!(
        bytes.load(Ordering::Relaxed) < 1024 * 1024,
        "read {} bytes",
        bytes.load(Ordering::Relaxed)
    );
}

#[test]
fn native_selection_and_search_follow_rotated_glyphs() {
    use anynote_desktop::pdf::selection;
    let doc = engine::open(Cursor::new(fixture("geometry.pdf")), None).unwrap();
    for page in 0..8 {
        let raster = engine::render(&doc, page, 960, true, || false).unwrap();
        let hits = selection::find(raster.text(), "Anynote", page);
        assert_eq!(hits.len(), 1);
        let range = selection::utf16_selection(&raster, hits[0].range()).unwrap();
        let draft = selection::select(&raster, range, "comment".into());
        assert_eq!(draft.quote(), "Anynote");
        assert!(draft.is_valid());
        for glyph in raster.glyphs().iter().filter(|g| g.text() == "A") {
            let q = raster.geometry().normalized_quad(glyph.bounds().unwrap());
            let p = [
                q.iter().map(|p| p[0]).sum::<f64>() / 4.,
                q.iter().map(|p| p[1]).sum::<f64>() / 4.,
            ];
            assert_eq!(selection::hit(&raster, p), Some(glyph.index()));
        }
        let (text, partial) = engine::extract(&doc, page, 4_500_000, || false).unwrap();
        assert_eq!(text, raster.text());
        assert!(!partial);
        let (prefix, partial) = engine::extract(&doc, page, 3, || false).unwrap();
        assert!(partial);
        assert_eq!(prefix.encode_utf16().count(), 3);
    }
    assert!(matches!(
        engine::extract(&doc, 0, 100, || true),
        Err(PdfError::Cancelled)
    ));
}
