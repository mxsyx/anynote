use gpui_kit::{App, component::Theme, px, rgb};

pub(super) fn paper(cx: &mut App) {
    Theme::update(cx, |theme| {
        if theme.mode.is_dark() {
            theme.background = rgb(0x131315).into();
            theme.foreground = rgb(0xf4f4f6).into();
            theme.sidebar = rgb(0x131315).into();
            theme.sidebar_foreground = theme.foreground;
            theme.border = rgb(0x2b2b30).into();
            theme.muted = rgb(0x18181b).into();
            theme.muted_foreground = rgb(0x9e9ea8).into();
            theme.accent = rgb(0x201f21).into();
            theme.accent_foreground = rgb(0xc0c1ff).into();
            theme.popover = rgb(0x24242a).into();
            theme.secondary = theme.muted;
            theme.secondary_foreground = theme.foreground;
            theme.primary = rgb(0xc0c1ff).into();
            theme.primary_hover = rgb(0xa7a9ff).into();
            theme.primary_foreground = rgb(0x1000a9).into();
        } else {
            theme.background = rgb(0xffffff).into();
            theme.foreground = rgb(0x161922).into();
            theme.sidebar = rgb(0xf7f8fa).into();
            theme.sidebar_foreground = theme.foreground;
            theme.border = rgb(0xe4e5e9).into();
            theme.muted = rgb(0xf5f5f7).into();
            theme.muted_foreground = rgb(0x6b7280).into();
            theme.accent = rgb(0xeeefff).into();
            theme.accent_foreground = rgb(0x5145cd).into();
            theme.popover = theme.background;
            theme.secondary = theme.muted;
            theme.secondary_foreground = theme.foreground;
            theme.primary = rgb(0x4f46e5).into();
            theme.primary_hover = rgb(0x4338ca).into();
            theme.primary_foreground = rgb(0xffffff).into();
        }
        theme.secondary_active = theme.accent;
        theme.secondary_hover = theme.muted;
        theme.primary_active = theme.primary_hover;
        theme.ring = theme.primary;
        theme.popover_foreground = theme.foreground;
        theme.group_box = theme.muted;
        theme.group_box_foreground = theme.foreground;
        theme.title_bar = theme.background;
        theme.title_bar_border = theme.border;
        theme.input = theme.border;
        theme.colors.list = theme.sidebar;
        theme.list_hover = theme.muted;
        theme.list_active = theme.accent;
        theme.list_active_border = theme.border;
        theme.sidebar_accent = theme.accent;
        theme.sidebar_accent_foreground = theme.accent_foreground;
        theme.radius = px(6.);
        theme.radius_lg = px(8.);
    });
}
