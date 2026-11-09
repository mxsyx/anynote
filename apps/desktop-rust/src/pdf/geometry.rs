use std::ops::Range;

#[derive(Clone, Debug, PartialEq)]
pub enum PdfError {
    Unavailable,
    Password,
    Invalid,
    Resource,
    Cancelled,
    Budget,
    PageNumber,
}
impl std::fmt::Display for PdfError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Unavailable => "PDF 阅读组件不可用，请检查安装后重试",
            Self::Password => "此 PDF 需要正确的密码",
            Self::Invalid => "无法读取此 PDF 文件",
            Self::Resource => "PDF 资源不可用，请重新打开笔记",
            Self::Cancelled => "已取消读取 PDF",
            Self::Budget => "此 PDF 页面超过阅读预算",
            Self::PageNumber => "请输入当前 PDF 范围内的页码",
        })
    }
}
impl std::error::Error for PdfError {}

#[derive(Clone, Debug)]
pub struct PageGeometry {
    size: [f32; 2],
    crop: [f32; 4],
    rotation: u16,
    // Native DeviceToPage samples give the exact inverse of the raster transform.
    origin: [f64; 2],
    x_axis: [f64; 2],
    y_axis: [f64; 2],
}
impl PageGeometry {
    #[cfg(feature = "media")]
    pub(crate) fn new(
        size: [f32; 2],
        crop: [f32; 4],
        rotation: u16,
        points: [[f64; 2]; 3],
    ) -> Self {
        let [origin, right, bottom] = points;
        Self {
            size,
            crop,
            rotation,
            origin,
            x_axis: [right[0] - origin[0], right[1] - origin[1]],
            y_axis: [bottom[0] - origin[0], bottom[1] - origin[1]],
        }
    }
    pub fn size(&self) -> [f32; 2] {
        self.size
    }
    pub fn crop_box(&self) -> [f32; 4] {
        self.crop
    }
    pub fn rotation(&self) -> u16 {
        self.rotation
    }
    pub fn to_page(&self, normalized: [f64; 2]) -> [f64; 2] {
        std::array::from_fn(|i| {
            self.origin[i] + self.x_axis[i] * normalized[0] + self.y_axis[i] * normalized[1]
        })
    }
    pub fn to_normalized(&self, point: [f64; 2]) -> [f64; 2] {
        let p = [point[0] - self.origin[0], point[1] - self.origin[1]];
        let determinant = self.x_axis[0] * self.y_axis[1] - self.x_axis[1] * self.y_axis[0];
        [
            (p[0] * self.y_axis[1] - p[1] * self.y_axis[0]) / determinant,
            (self.x_axis[0] * p[1] - self.x_axis[1] * p[0]) / determinant,
        ]
    }
    pub fn normalized_quad(&self, bounds: [f32; 4]) -> [[f64; 2]; 4] {
        let [left, bottom, right, top] = bounds.map(f64::from);
        [[left, top], [right, top], [right, bottom], [left, bottom]].map(|p| self.to_normalized(p))
    }
}
#[derive(Clone, Debug)]
pub struct Glyph {
    pub(crate) index: usize,
    pub(crate) text: String,
    pub(crate) utf16: Range<usize>,
    pub(crate) bounds: Option<[f32; 4]>,
    pub(crate) angle: f32,
}
impl Glyph {
    pub fn index(&self) -> usize {
        self.index
    }
    pub fn text(&self) -> &str {
        &self.text
    }
    pub fn utf16_range(&self) -> Range<usize> {
        self.utf16.clone()
    }
    pub fn bounds(&self) -> Option<[f32; 4]> {
        self.bounds
    }
    pub fn angle(&self) -> f32 {
        self.angle
    }
}
#[derive(Debug)]
pub struct PageRaster {
    pub(crate) page: u16,
    pub(crate) geometry: PageGeometry,
    pub(crate) pixels: image::RgbaImage,
    pub(crate) glyphs: Vec<Glyph>,
    pub(crate) text: String,
}
impl PageRaster {
    pub fn page(&self) -> u16 {
        self.page
    }
    pub fn geometry(&self) -> &PageGeometry {
        &self.geometry
    }
    pub fn pixels(&self) -> &image::RgbaImage {
        &self.pixels
    }
    pub fn glyphs(&self) -> &[Glyph] {
        &self.glyphs
    }
    pub fn text(&self) -> &str {
        &self.text
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Zoom {
    FitPage,
    FitWidth,
    Scale(f32),
}
impl Zoom {
    pub fn scale(self, page: [f32; 2], viewport: [f32; 2]) -> f32 {
        let width = viewport[0].max(1.) / page[0].max(1.);
        let height = viewport[1].max(1.) / page[1].max(1.);
        match self {
            Self::FitPage => width.min(height),
            Self::FitWidth => width,
            Self::Scale(s) => s,
        }
        .clamp(0.1, 8.)
    }
}
