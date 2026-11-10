//! Fixed business operations; manifests are used only by the offline state converter.
use anynote_core::{
    backend::{ErrorCode, ServiceError, ServiceResult},
    builtin::*,
};
use anynote_storage::notebook::*;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

pub fn storage_error(error: ReadError) -> ServiceError {
    ServiceError::new(match error.kind() {
        ReadErrorKind::Conflict => ErrorCode::Conflict,
        ReadErrorKind::NotFound => ErrorCode::NotFound,
        ReadErrorKind::InvalidInput => ErrorCode::InvalidRequest,
        ReadErrorKind::Cancelled => ErrorCode::Cancelled,
        _ => ErrorCode::Storage,
    })
}
async fn wait<T: Send + 'static>(ticket: WriteTicket<T>) -> ServiceResult<T> {
    tokio::task::spawn_blocking(move || ticket.wait())
        .await
        .map_err(|_| ServiceError::new(ErrorCode::Storage))?
        .map_err(storage_error)
}
fn invalid() -> ServiceError {
    ServiceError::new(ErrorCode::InvalidRequest)
}

pub async fn execute(
    queue: &WriteQueue,
    request: ReadingRequest,
    cancel: &CancellationToken,
) -> ServiceResult<Note> {
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&request).map_err(|_| invalid())?)
    );
    let initial = request.clone();
    let hash = fingerprint.clone();
    let receipt = wait(
        queue
            .submit(move |catalog| {
                catalog
                    .notebook(&initial.base().id().notebook().to_string())?
                    .read()
                    .builtin_receipt(&initial.operation().to_string(), &hash)
            })
            .map_err(storage_error)?,
    )
    .await?;
    if let Some(note) = receipt {
        return Ok(note);
    }
    let external = match request.command() {
        ReadingCommand::PublicText { url } => Some(public_text(url, cancel).await?),
        ReadingCommand::Related | ReadingCommand::AsyncRelated => {
            let book = request.base().id().notebook().to_string();
            let asynchronous = matches!(request.command(), ReadingCommand::AsyncRelated);
            let response = wait(
                queue
                    .submit(move |catalog| {
                        let mut query =
                            SearchRequest::new(uuid::Uuid::new_v4().to_string(), "阅读记录".into());
                        query.notebook_ids = Some(vec![book.clone()]);
                        query.limit = 5;
                        catalog.notebook(&book)?.read().search(&query)
                    })
                    .map_err(storage_error)?,
            )
            .await?;
            let mut text = format!(
                "\n\n## {}相关阅读索引\n\n",
                if asynchronous { "异步" } else { "" }
            );
            if response.results.is_empty() {
                text.push_str("未找到相关阅读记录。");
            }
            for (ix, hit) in response.results.iter().enumerate() {
                if ix > 0 {
                    text.push('\n');
                }
                text.push_str(&format!(
                    "- {}：{}",
                    hit.node.title,
                    hit.snippet.replace('\n', " ")
                ));
            }
            if response.truncated {
                text.push_str("\n更多结果已省略。");
            }
            text.push('\n');
            Some(text)
        }
        _ => None,
    };
    if cancel.is_cancelled() {
        return Err(ServiceError::new(ErrorCode::Cancelled));
    }
    wait(
        queue
            .submit(move |catalog| {
                let book = catalog.notebook(&request.base().id().notebook().to_string())?;
                let note = book.read().note(&request.base().id().note().to_string())?;
                let mut state = None;
                let mut body = note.body.clone();
                match request.command() {
                    ReadingCommand::CreateRecord => {
                        body = "# 阅读记录\n\n## 关键观点\n\n## 我的思考\n".into()
                    }
                    ReadingCommand::AppendTemplate => {
                        body.push_str("\n\n## 阅读摘记\n\n- [ ] 记录核心观点\n- [ ] 写下一个问题\n")
                    }
                    ReadingCommand::Count => body.push_str(&format!(
                        "\n\n## 阅读统计\n\n正文字符数：{}\n",
                        note.body.encode_utf16().count()
                    )),
                    ReadingCommand::Related | ReadingCommand::AsyncRelated => {
                        body.push_str(external.as_deref().unwrap_or_default())
                    }
                    ReadingCommand::PublicText { .. } => body.push_str(&format!(
                        "\n\n## 公开资料摘要\n\n{}\n",
                        external.as_deref().unwrap_or_default()
                    )),
                    ReadingCommand::AppendGoal => {
                        book.read()
                            .ensure_builtin_migrated("notebook.preferences")?;
                        let (_, prefs) = book.read().builtin_preferences()?;
                        if prefs.enabled {
                            body.push_str(&format!(
                                "\n\n## {}\n\n目标：{} 篇。\n",
                                prefs.heading, prefs.goal
                            ));
                        }
                    }
                    ReadingCommand::RecordSession => {
                        book.read().ensure_builtin_migrated("reading.session")?;
                        let row = book.read().builtin_value("reading.session")?;
                        let (revision, mut value) = row
                            .map_or((0, serde_json::json!({"visits":0,"lastTitle":""})), |r| {
                                (r.revision(), r.value().clone())
                            });
                        // Unknown fields survive each counter update, including migrated v2 state.
                        let visits = value["visits"]
                            .as_u64()
                            .filter(|n| *n < 9_007_199_254_740_991)
                            .ok_or_else(|| ReadError::invalid_input("整理次数无效或已耗尽"))?
                            + 1;
                        value["visits"] = visits.into();
                        value["lastTitle"] = note.node.title.clone().into();
                        body.push_str(&format!(
                            "\n\n## 整理记录\n\n本 Notebook 第 {visits} 次整理。\n"
                        ));
                        state = Some((revision, value));
                    }
                }
                book.commit_reading(&request, &fingerprint, &body, state)
            })
            .map_err(storage_error)?,
    )
    .await
}

pub async fn public_text(url: &str, cancel: &CancellationToken) -> ServiceResult<String> {
    if url.len() > 4000 {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    let download = crate::network::download(url, 128 * 1024, 10_000, cancel, &mut bytes)
        .await
        .map_err(|error| {
            ServiceError::new(if error.cancelled {
                ErrorCode::Cancelled
            } else {
                ErrorCode::InvalidRequest
            })
        })?;
    let mime = download.content_type.split(';').next().unwrap_or("").trim();
    if !matches!(mime, "text/plain" | "text/markdown" | "application/json") {
        return Err(invalid());
    }
    String::from_utf8(bytes).map_err(|_| invalid())
}

/// A checksum-verified conversion must be explicitly supplied; legacy IDs alone never select code.
pub fn migrate_state(
    book: &mut WritableNotebook,
    entry: &str,
    row: &crate::config_migration::plugins::LegacyState,
) -> ServiceResult<()> {
    let converted = crate::config_migration::plugins::convert_state(entry, row)
        .map_err(|_| invalid())?
        .converted
        .ok_or_else(invalid)?;
    let (key, value) = if converted.key == "anynote.reading.session" {
        ("reading.session", converted.values)
    } else {
        let (_, mut prefs) = book.read().builtin_preferences().map_err(storage_error)?;
        prefs.heading = converted.values["heading"]
            .as_str()
            .ok_or_else(invalid)?
            .into();
        prefs.goal = converted.values["goal"].as_u64().ok_or_else(invalid)? as u32;
        prefs.enabled = converted.values["enabled"].as_bool().ok_or_else(invalid)?;
        (
            "notebook.preferences",
            serde_json::to_value(prefs).map_err(|_| invalid())?,
        )
    };
    book.import_builtin_state(key, &value)
        .map_err(storage_error)
}
