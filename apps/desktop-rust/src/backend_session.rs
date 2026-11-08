use crate::backend_client::BackendClient;
use gpui_kit::{App, Global};

pub struct BackendSession {
    client: BackendClient,
    quitting: bool,
}
impl Global for BackendSession {}
impl BackendSession {
    pub fn install(client: BackendClient, cx: &mut App) {
        let fallback = client.clone();
        cx.on_app_quit(move |cx| {
            let client = fallback.clone();
            let quitting = cx
                .try_global::<Self>()
                .is_some_and(|session| session.quitting);
            async move {
                if !quitting && client.is_connected() {
                    let _ = client.shutdown().await;
                }
            }
        })
        .detach();
        cx.set_global(Self {
            client,
            quitting: false,
        });
    }
    pub fn client(&self) -> &BackendClient {
        &self.client
    }
}
pub fn request_quit(cx: &mut App) {
    let Some(session) = cx.try_global::<BackendSession>() else {
        cx.quit();
        return;
    };
    if session.quitting {
        return;
    }
    let client = session.client.clone();
    cx.global_mut::<BackendSession>().quitting = true;
    cx.spawn(async move |cx| {
        let result = client.shutdown().await;
        cx.update(|cx| {
            if result
                .as_ref()
                .is_err_and(|error| error.code() == anynote_core::backend::ErrorCode::Busy)
            {
                cx.global_mut::<BackendSession>().quitting = false;
                return;
            }
            if result.is_err() {
                eprintln!("backend exit: unconfirmed; recover task history on restart");
            }
            cx.quit();
        });
    })
    .detach();
}
