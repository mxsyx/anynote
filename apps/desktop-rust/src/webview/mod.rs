//! One active system media view, owned and revoked before its GPUI parent closes.
pub mod policy;
use anynote_core::video::VideoCard;
use gpui_kit::*;
use gpui_webview::WebView;
use policy::{Binding, LOCAL_CSP, LocalSession};
use std::{
    borrow::Cow,
    cell::RefCell,
    rc::Rc,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

static ACTIVE: AtomicBool = AtomicBool::new(false);
struct Slot;
impl Slot {
    fn acquire() -> Result<Self, String> {
        ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
            .map(|_| Self)
            .map_err(|_| "请先关闭正在播放的视频".into())
    }
}
impl Drop for Slot {
    fn drop(&mut self) {
        ACTIVE.store(false, Ordering::Release);
    }
}

pub struct MediaHost {
    view: Option<Entity<WebView>>,
    local: Option<Rc<RefCell<LocalSession>>>,
    slot: Option<Slot>,
}
pub(crate) fn builder() -> wry::WebViewBuilder<'static> {
    wry::WebViewBuilder::new()
        .with_incognito(true)
        .with_devtools(false)
        .with_clipboard(false)
        .with_download_started_handler(|_, _| false)
        .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
        .with_drag_drop_handler(|_| true)
}
pub(crate) fn platform_check() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    if std::env::var("GPUI_DISABLE_DIRECT_COMPOSITION")
        .ok()
        .as_deref()
        != Some("1")
    {
        return Err(
            "系统查看器需要以 GPUI_DISABLE_DIRECT_COMPOSITION=1 启动；当前 Windows 后端尚未完成设备验证"
                .into(),
        );
    }
    Ok(())
}
impl MediaHost {
    pub fn external(card: &VideoCard, window: &mut Window, cx: &mut App) -> Result<Self, String> {
        platform_check()?;
        let slot = Slot::acquire()?;
        let embed = card.embed().ok_or("此链接不支持嵌入播放")?;
        let allowed = embed.clone();
        let html = player_html(&embed);
        let native = WebView::build(
            builder()
                .with_html(html)
                .with_navigation_handler(move |url| url == "about:blank" || url == allowed),
            window,
            cx,
        )
        .map_err(|e| format!("无法创建系统播放器：{e}"))?;
        // The external builder deliberately never installs IPC or a resource scheme.
        Ok(Self {
            view: Some(cx.new(|_| native)),
            local: None,
            slot: Some(slot),
        })
    }
    pub fn local(
        binding: Binding,
        window: &mut Window,
        cx: &mut App,
    ) -> Result<(Self, async_channel::Receiver<policy::Message>), String> {
        platform_check()?;
        let slot = Slot::acquire()?;
        let session = Rc::new(RefCell::new(LocalSession::new(binding)));
        let url = session.borrow().page_url();
        let allowed = url.clone();
        let initial_navigation = std::cell::Cell::new(true);
        let scheme = session.clone();
        let ipc = session.clone();
        let (sender, receiver) = async_channel::bounded(32);
        let native = WebView::build(
            builder()
                .with_custom_protocol("anynote-view".into(), move |_, request| {
                    local_response(&mut scheme.borrow_mut(), request)
                })
                .with_navigation_handler(move |url| {
                    url == allowed && initial_navigation.replace(false)
                })
                .with_ipc_handler(move |request| {
                    if let Ok(message) = ipc.borrow_mut().accept(
                        &request.uri().to_string(),
                        request.body(),
                        Instant::now(),
                    ) {
                        let _ = sender.try_send(message);
                    }
                })
                .with_url(url),
            window,
            cx,
        )
        .map_err(|e| format!("无法创建本地媒体视图：{e}"))?;
        Ok((
            Self {
                view: Some(cx.new(|_| native)),
                local: Some(session),
                slot: Some(slot),
            },
            receiver,
        ))
    }
    pub fn publish_resource(
        &self,
        scope: &anynote_core::asset::AssetScope,
        bytes: std::sync::Arc<[u8]>,
    ) -> Result<String, policy::Rejection> {
        self.local
            .as_ref()
            .ok_or(policy::Rejection::Closed)?
            .borrow_mut()
            .publish(scope, bytes)
    }
    pub fn view(&self) -> Option<Entity<WebView>> {
        self.view.clone()
    }
    pub fn set_visible(&self, visible: bool, cx: &mut App) -> Result<(), String> {
        self.view
            .as_ref()
            .ok_or("视图已关闭")?
            .update(cx, |view, _| view.set_visible(visible))
            .map_err(|e| e.to_string())
    }
    pub fn focus(&self, window: &mut Window, cx: &mut App) -> Result<(), String> {
        let view = self.view.as_ref().ok_or("视图已关闭")?;
        view.read(cx).focus_handle(cx).focus(window, cx);
        view.read(cx).raw().focus().map_err(|e| e.to_string())
    }
    pub fn close(&mut self, cx: &mut App) {
        if let Some(session) = &self.local {
            session.borrow_mut().close();
        }
        if let Some(view) = self.view.take() {
            view.update(cx, |v, _| {
                let _ = v.set_visible(false);
            });
        }
        self.local = None;
        self.slot = None;
    }
}
impl Drop for MediaHost {
    fn drop(&mut self) {
        if let Some(session) = &self.local {
            session.borrow_mut().close();
        }
        self.view = None;
    }
}
fn player_html(embed: &str) -> String {
    // Only validated templates reach this function. The iframe cannot open windows,
    // navigate its parent, submit forms, or request camera/microphone permissions.
    let embed = embed.replace('&', "&amp;");
    format!(
        r#"<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src {embed}; style-src 'nonce-player'; object-src 'none'; base-uri 'none'; form-action 'none'"><style nonce="player">html,body,iframe{{margin:0;width:100%;height:100%;border:0;overflow:hidden}}</style><iframe title="视频播放器" src="{embed}" sandbox="allow-scripts allow-same-origin allow-presentation" allow="fullscreen; encrypted-media" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>"#
    )
}
fn local_response(
    session: &mut LocalSession,
    request: wry::http::Request<Vec<u8>>,
) -> wry::http::Response<Cow<'static, [u8]>> {
    let response = wry::http::Response::builder()
        .header("Content-Security-Policy", LOCAL_CSP)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .header(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()",
        );
    if !session.is_active() {
        return response.status(403).body(Cow::Borrowed(&[][..])).unwrap();
    }
    if request.method() != "GET" {
        return response.status(405).body(Cow::Borrowed(&[][..])).unwrap();
    }
    let uri = request.uri().to_string();
    if uri == session.page_url() {
        return response.header("Content-Type", "text/html; charset=utf-8").body(Cow::Borrowed(b"<!doctype html><meta charset=utf-8><title>Anynote media</title><p>Local media bridge</p><script src=bridge.js></script>" as &[u8])).unwrap();
    }
    if uri == format!("{}/bridge.js", session.origin()) {
        let script = format!(
            "'use strict';const bootstrap={};const resources=bootstrap.resources;delete bootstrap.resources;const send=message=>window.ipc.postMessage(JSON.stringify({{...bootstrap,requestId:message.kind==='ready'?bootstrap.requestId:bootstrap.renderId,message}}));const renderId=bootstrap.renderId;delete bootstrap.renderId;send({{kind:'ready'}});Promise.all(resources.map(url=>fetch(url,{{headers:{{Range:'bytes=0-7'}}}}).then(async response=>{{if(response.status!==206||(await response.arrayBuffer()).byteLength!==8)throw Error('resource');}}))).then(()=>window.ipc.postMessage(JSON.stringify({{...bootstrap,requestId:renderId,message:{{kind:'rendered',payload:{{generation:0}}}}}}))).catch(()=>window.ipc.postMessage(JSON.stringify({{...bootstrap,requestId:renderId,message:{{kind:'failed',payload:{{code:'resource'}}}}}})));",
            session.bootstrap()
        );
        return response
            .header("Content-Type", "text/javascript")
            .body(Cow::Owned(script.into_bytes()))
            .unwrap();
    }
    let range = request.headers().get("Range").and_then(|h| h.to_str().ok());
    match session.resource(&uri, range, Instant::now()) {
        Ok((bytes, mime, span, total)) => {
            let mut response = response
                .status(if range.is_some() { 206 } else { 200 })
                .header("Content-Type", mime)
                .header("Accept-Ranges", "bytes");
            if range.is_some() {
                response = response.header(
                    "Content-Range",
                    format!("bytes {}-{}/{total}", span.start, span.end - 1),
                );
            }
            response.body(Cow::Owned(bytes)).unwrap()
        }
        Err(policy::Rejection::Range) => response.status(416).body(Cow::Borrowed(&[][..])).unwrap(),
        Err(_) => response.status(403).body(Cow::Borrowed(&[][..])).unwrap(),
    }
}
#[cfg(test)]
mod tests {
    use super::player_html;
    use anynote_core::video::VideoCard;
    #[test]
    fn external_policy_has_no_bridge_and_scopes_each_provider() {
        for url in [
            "https://youtu.be/abcdefghijk",
            "https://vimeo.com/12345678",
            "https://www.bilibili.com/video/BV1234567890",
        ] {
            let card = VideoCard::parse(url).unwrap();
            let html = player_html(&card.embed().unwrap());
            assert!(
                html.contains("sandbox=\"allow-scripts allow-same-origin allow-presentation\"")
            );
            assert!(!html.contains("window.ipc"));
            assert!(!html.contains("allow-popups"));
            assert!(!html.contains("frame-src *"));
        }
    }
}
