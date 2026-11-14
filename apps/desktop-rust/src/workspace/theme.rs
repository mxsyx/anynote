use gpui_kit::{App, component::Theme, rgb};

pub(super) fn paper(cx: &mut App) {
    Theme::update(cx, |theme| {
        if theme.mode.is_dark() {
            theme.background = rgb(0x1c1d1f).into();
            theme.foreground = rgb(0xe7e8ea).into();
            theme.sidebar = rgb(0x242527).into();
            theme.sidebar_foreground = theme.foreground;
            theme.border = rgb(0x343538).into();
            theme.muted = rgb(0x28292c).into();
            theme.muted_foreground = rgb(0xa3a5aa).into();
            theme.secondary = theme.muted;
            theme.secondary_foreground = theme.foreground;
        } else {
            theme.background = rgb(0xffffff).into();
            theme.foreground = rgb(0x25262a).into();
            theme.sidebar = rgb(0xf4f4f5).into();
            theme.sidebar_foreground = theme.foreground;
            theme.border = rgb(0xe7e7e9).into();
            theme.muted = rgb(0xf4f4f5).into();
            theme.muted_foreground = rgb(0x707278).into();
            theme.secondary = theme.muted;
            theme.secondary_foreground = theme.foreground;
        }
    });
}
