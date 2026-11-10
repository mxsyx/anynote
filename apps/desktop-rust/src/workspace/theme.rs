use gpui_kit::{App, component::Theme, rgb};

pub(super) fn paper(cx: &mut App) {
    Theme::update(cx, |theme| {
        if theme.mode.is_dark() {
            theme.background = rgb(0x282622).into();
            theme.foreground = rgb(0xe8e3d9).into();
            theme.sidebar = rgb(0x211f1c).into();
            theme.sidebar_foreground = theme.foreground;
        } else {
            theme.background = rgb(0xfaf7ef).into();
            theme.foreground = rgb(0x38342e).into();
            theme.sidebar = rgb(0xf0eadf).into();
            theme.sidebar_foreground = theme.foreground;
        }
    });
}
