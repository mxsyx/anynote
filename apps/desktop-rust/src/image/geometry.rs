use anynote_core::image::ImageRect;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Zoom {
    Fit,
    Actual,
    Scale(f32),
}
#[derive(Clone, Debug)]
pub struct Viewport {
    pub zoom: Zoom,
    pub turns: u8,
    pub pan: [f32; 2],
}
impl Default for Viewport {
    fn default() -> Self {
        Self {
            zoom: Zoom::Fit,
            turns: 0,
            pan: [0.; 2],
        }
    }
}
impl Viewport {
    pub fn size(&self, natural: [f32; 2]) -> [f32; 2] {
        if self.turns % 2 == 1 {
            [natural[1], natural[0]]
        } else {
            natural
        }
    }
    pub fn scale(&self, natural: [f32; 2], viewport: [f32; 2], dpi: f32) -> f32 {
        let [w, h] = self.size(natural);
        match self.zoom {
            Zoom::Fit => (viewport[0] / w)
                .min(viewport[1] / h)
                .min(1. / dpi)
                .max(0.001),
            Zoom::Actual => 1. / dpi,
            Zoom::Scale(scale) => scale.clamp(0.01, 16.),
        }
    }
    pub fn bounds(&self, natural: [f32; 2], viewport: [f32; 2], dpi: f32) -> [f32; 4] {
        let [w, h] = self.size(natural);
        let scale = self.scale(natural, viewport, dpi);
        let (w, h) = (w * scale, h * scale);
        [
            (viewport[0] - w) / 2. + self.pan[0],
            (viewport[1] - h) / 2. + self.pan[1],
            w,
            h,
        ]
    }
    pub fn zoom_by(&mut self, factor: f32, natural: [f32; 2], viewport: [f32; 2], dpi: f32) {
        let old = self.scale(natural, viewport, dpi);
        let new = (old * factor).clamp(0.01, 16.);
        self.pan = self.pan.map(|n| n * new / old);
        self.zoom = Zoom::Scale(new);
    }
    pub fn original_point(&self, point: [f32; 2], bounds: [f32; 4]) -> [f64; 2] {
        let x = f64::from(((point[0] - bounds[0]) / bounds[2]).clamp(0., 1.));
        let y = f64::from(((point[1] - bounds[1]) / bounds[3]).clamp(0., 1.));
        match self.turns % 4 {
            1 => [y, 1. - x],
            2 => [1. - x, 1. - y],
            3 => [1. - y, x],
            _ => [x, y],
        }
    }
    pub fn displayed_rect(&self, r: ImageRect) -> ImageRect {
        match self.turns % 4 {
            1 => ImageRect {
                x: 1. - r.y - r.height,
                y: r.x,
                width: r.height,
                height: r.width,
            },
            2 => ImageRect {
                x: 1. - r.x - r.width,
                y: 1. - r.y - r.height,
                ..r
            },
            3 => ImageRect {
                x: r.y,
                y: 1. - r.x - r.width,
                width: r.height,
                height: r.width,
            },
            _ => r,
        }
    }
}
pub fn rectangle(a: [f64; 2], b: [f64; 2]) -> Option<ImageRect> {
    let r = ImageRect {
        x: a[0].min(b[0]),
        y: a[1].min(b[1]),
        width: (a[0] - b[0]).abs(),
        height: (a[1] - b[1]).abs(),
    };
    r.is_valid().then_some(r)
}
