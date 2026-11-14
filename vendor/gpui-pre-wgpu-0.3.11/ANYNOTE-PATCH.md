# AnyNote variable font weight patch

Source: crates.io `gpui-pre-wgpu` 0.3.11, Zed snapshot recorded in `Cargo.toml`.
The upstream source and Apache license are retained. Local changes are in
`src/cosmic_text_system.rs` and the explicit `font_variations` integration test.

The upstream rasterizer omitted variation coordinates. Noto Sans CJK SC has a
default weight of 100, so a Regular 400 request was drawn with Thin outlines.
Fallback resolution also discarded `LayoutGlyph::font_weight`. The patch retains
weight in loaded fonts and fallback identity, instantiates requested weights for
variable primary fonts, and uses the same normalized coordinates for metrics and
rasterization. FontId distinguishes weight instances in the existing glyph cache.
Static face selection, antialiasing, colors, application font sizes and window
scaling policy are unchanged.

Run from the repository root:

```sh
cargo test --locked --offline -p gpui-pre-wgpu --test font_variations
```

Tests use embedded subsets, without consulting installed fonts. They compare
production glyph bytes with Swash rendering at an explicit weight, exercise
Regular/Bold/Thin switches and cache reuse, and check variable advance widths.
Set `ANYNOTE_FONT_PROBE_DIR` to an existing absolute directory under root `tmp/`
to retain PGM glyph images. These are raster regression checks, not GTK/native
screen comparison or cross-platform acceptance.

## Fixture provenance

`tests/fonts/NotoSansCJK-SC-subset.ttf` comes from Fedora's
`google-noto-sans-cjk-vf-fonts` `/usr/share/fonts/google-noto-sans-cjk-vf-fonts/NotoSansCJK-VF.ttc`,
face 2 (Noto Sans CJK SC). `NotoSans-subset.ttf` comes from
`/usr/share/fonts/google-noto-vf/NotoSans[wght].ttf`. Both are SIL OFL fonts;
copyright records are preserved in the font name tables and `tests/fonts/OFL.txt`
contains the license. These subsets are test-only and are not application fonts.

Generated with fontTools 4.62.1, `TTFont`, `subset.Subsetter().populate(text=...)`,
`subsetter.subset(font)`, and `font.save(...)`, retaining variable axes:

- CJK: `mA工作区编辑插入显示书橱我的搜索所有笔记本返回阅读中文测试`
- Latin: `mA`

When upgrading GPUI, re-run this regression against upstream before removing the
patch. Upstream unit tests refer to fonts outside the published crate; this
repository's explicit integration target is self-contained.
