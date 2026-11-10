//! Explicit metadata refresh uses the existing pinned-address downloader.
use anynote_core::{backend::*, video::*};
use tokio_util::sync::CancellationToken;

pub fn parse_metadata(card: &VideoCard, body: &str) -> (Option<String>, Option<String>) {
    let (title, thumbnail) = if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        let value = if card.provider() == Provider::Bilibili {
            &value["data"]
        } else {
            &value
        };
        (
            value["title"].as_str().map(str::to_owned),
            value[if card.provider() == Provider::Bilibili {
                "pic"
            } else {
                "thumbnail_url"
            }]
            .as_str()
            .map(str::to_owned),
        )
    } else {
        let doc = dom_query::Document::from(body);
        let meta = |selector| doc.select(selector).attr("content").map(|s| s.to_string());
        let title = meta("meta[property='og:title'],meta[name='twitter:title']").or_else(|| {
            let text = doc.select("title").text().to_string();
            (!text.is_empty()).then_some(text)
        });
        (
            title,
            meta("meta[property='og:image'],meta[name='twitter:image']"),
        )
    };
    (
        title.map(|s| crate::importer::truncate_utf16(s.trim(), 240)),
        thumbnail.and_then(|u| card.thumbnail_url(&u)),
    )
}
pub async fn fetch(card: &VideoCard, cancel: &CancellationToken) -> ServiceResult<Metadata> {
    let url = card
        .metadata_url()
        .ok_or_else(|| ServiceError::new(ErrorCode::InvalidRequest))?;
    let mut bytes = Vec::new();
    crate::network::download(&url, 1024 * 1024, 6_000, cancel, &mut bytes)
        .await
        .map_err(|error| {
            ServiceError::new(if error.cancelled {
                ErrorCode::Cancelled
            } else {
                ErrorCode::InvalidRequest
            })
        })?;
    let (title, image) = parse_metadata(card, &String::from_utf8_lossy(&bytes));
    let mut thumbnail = None;
    if let Some(url) = image {
        bytes.clear();
        if crate::network::download(&url, 4 * 1024 * 1024, 6_000, cancel, &mut bytes)
            .await
            .is_ok()
            && matches!(
                image::guess_format(&bytes),
                Ok(image::ImageFormat::Png
                    | image::ImageFormat::Jpeg
                    | image::ImageFormat::Gif
                    | image::ImageFormat::WebP)
            )
        {
            thumbnail = Some(bytes);
        }
    }
    if cancel.is_cancelled() {
        return Err(ServiceError::new(ErrorCode::Cancelled));
    }
    Ok(Metadata::new(title, thumbnail))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_limits_and_cdn_validation() {
        let card = VideoCard::parse("https://youtu.be/abcdefghijk").unwrap();
        let (title, image) = parse_metadata(
            &card,
            r#"{"title":"Hello","thumbnail_url":"https://evil.test/a.png"}"#,
        );
        assert_eq!(title.as_deref(), Some("Hello"));
        assert!(image.is_none());
        let card = VideoCard::parse("https://example.com/v").unwrap();
        assert_eq!(
            parse_metadata(&card, "<meta content='A &amp; B' property='og:title'>")
                .0
                .as_deref(),
            Some("A & B")
        );
        let (title, _) = parse_metadata(&card, &format!("<title>{}</title>", "字".repeat(300)));
        assert_eq!(title.unwrap().chars().count(), 240);
    }
}
