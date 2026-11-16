use gpui_kit::base::text::editor_host::RenderContext;
use gpui_kit::{App, Hsla, Styled, component::ActiveTheme, div, rgb};

pub(super) fn canvas(cx: &App) -> Hsla {
    rgb(if cx.theme().is_dark() {
        0x0f0f11
    } else {
        0xf5f5f7
    })
    .into()
}

pub(super) fn callout_colors(cx: &App) -> (Hsla, Hsla, Hsla) {
    let (background, border, foreground) = if cx.theme().is_dark() {
        (0x12251e, 0x275840, 0x91ddb1)
    } else {
        (0xf0fdf4, 0xbbf7d0, 0x166534)
    };
    (
        rgb(background).into(),
        rgb(border).into(),
        rgb(foreground).into(),
    )
}

pub(super) fn text_context(cx: &App) -> RenderContext {
    let context = RenderContext::from_app(cx);
    let (foreground, code_background) = if cx.theme().is_dark() {
        (0xc7c4d7, 0x0b0b0d)
    } else {
        (0x374151, 0xf7f8fa)
    };
    let style = context
        .style()
        .clone()
        .with_foreground(rgb(foreground).into())
        .with_code_background(rgb(code_background).into())
        .with_code_block(
            div()
                .rounded_b(cx.theme().radius)
                .border_t_0()
                .style()
                .clone(),
        );
    context.with_style(style)
}
