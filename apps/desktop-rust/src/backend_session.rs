use crate::backend_client::BackendClient;
use gpui_kit::{App, Global};

pub struct BackendSession {
    client: BackendClient,
    quitting: bool,
    reconnecting: bool,
}
impl Global for BackendSession {}
impl BackendSession {
    pub fn install(client: BackendClient, cx: &mut App) {
        let fallback = client.clone();
        cx.on_app_quit(move |cx| {
            let client = cx
                .try_global::<Self>()
                .map(|s| s.client.clone())
                .unwrap_or_else(|| fallback.clone());
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
            reconnecting: false,
        });
    }
    pub fn begin_reconnect(cx: &mut App) -> bool {
        let session = cx.global_mut::<Self>();
        if session.reconnecting {
            return false;
        }
        session.reconnecting = true;
        true
    }
    pub fn end_reconnect(client: Option<BackendClient>, cx: &mut App) {
        let session = cx.global_mut::<Self>();
        session.reconnecting = false;
        if let Some(client) = client {
            session.client = client;
        }
    }
    pub fn is_quitting(&self) -> bool {
        self.quitting
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
    cx.global_mut::<BackendSession>().quitting = true;
    cx.spawn(async move |cx| {
        loop {
            let state = cx.update(crate::document_editor::flush_all);
            match state {
                crate::document_editor::FlushState::Ready => break,
                crate::document_editor::FlushState::Failed => {
                    cx.update(|cx| cx.global_mut::<BackendSession>().quitting = false);
                    return;
                }
                crate::document_editor::FlushState::Waiting => {
                    cx.background_executor()
                        .timer(std::time::Duration::from_millis(50))
                        .await
                }
            }
        }
        let client = cx.update(|cx| cx.global::<BackendSession>().client.clone());
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
