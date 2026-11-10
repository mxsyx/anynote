//! Video identities are data; playback URLs are always rebuilt from validated IDs.
use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Youtube,
    Vimeo,
    Bilibili,
    Link,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoCard {
    provider: Provider,
    url: String,
    #[serde(rename = "videoId", skip_serializing_if = "Option::is_none")]
    video_id: Option<String>,
}
impl VideoCard {
    pub fn parse(raw: &str) -> Option<Self> {
        let u = https_url(raw)?;
        let host = u.host_str()?;
        let path = u.path();
        let identity = match host {
            "youtube.com" | "www.youtube.com" | "m.youtube.com" => {
                let id = if ["/embed/", "/shorts/", "/v/"]
                    .iter()
                    .any(|p| path.starts_with(p))
                {
                    path.split('/').nth(2).map(str::to_owned)
                } else {
                    u.query_pairs()
                        .find(|(k, _)| k == "v")
                        .map(|(_, v)| v.into_owned())
                };
                id.map(|id| (Provider::Youtube, id))
            }
            "youtu.be" => Some((Provider::Youtube, path[1..].into())),
            "vimeo.com" | "www.vimeo.com" | "player.vimeo.com" => path
                .split('/')
                .find(|s| valid_id(Provider::Vimeo, s))
                .map(|s| (Provider::Vimeo, s.into())),
            "bilibili.com" | "www.bilibili.com" | "m.bilibili.com" => path
                .strip_prefix("/video/")
                .and_then(|p| p.split('/').next())
                .map(|s| (Provider::Bilibili, s.into())),
            _ => None,
        }
        .filter(|(p, id)| valid_id(*p, id));
        let (provider, video_id) = identity.map_or((Provider::Link, None), |(p, id)| (p, Some(id)));
        let url = if provider == Provider::Youtube {
            format!("https://www.youtube.com/watch?v={}", video_id.as_deref()?)
        } else {
            u.to_string()
        };
        Some(Self {
            provider,
            video_id,
            url,
        })
    }
    pub fn provider(&self) -> Provider {
        self.provider
    }
    pub fn url(&self) -> &str {
        &self.url
    }
    pub fn is_valid(&self) -> bool {
        https_url(&self.url).is_some()
            && (self.provider == Provider::Link
                || self
                    .video_id
                    .as_ref()
                    .is_some_and(|id| valid_id(self.provider, id)))
    }
    pub fn embed(&self) -> Option<String> {
        if !self.is_valid() {
            return None;
        }
        let id = self.video_id.as_deref()?;
        Some(match self.provider {
            Provider::Youtube => format!("https://www.youtube-nocookie.com/embed/{id}"),
            Provider::Vimeo => format!("https://player.vimeo.com/video/{id}"),
            Provider::Bilibili => {
                format!("https://player.bilibili.com/player.html?bvid={id}&autoplay=0")
            }
            Provider::Link => return None,
        })
    }
    pub fn metadata_url(&self) -> Option<String> {
        if !self.is_valid() {
            return None;
        }
        let mut u = match self.provider {
            Provider::Youtube => Url::parse("https://www.youtube.com/oembed?format=json").ok()?,
            Provider::Vimeo => Url::parse("https://vimeo.com/api/oembed.json").ok()?,
            Provider::Bilibili => {
                Url::parse("https://api.bilibili.com/x/web-interface/view").ok()?
            }
            Provider::Link => return Some(self.url.clone()),
        };
        if self.provider == Provider::Bilibili {
            u.query_pairs_mut()
                .append_pair("bvid", self.video_id.as_deref()?);
        } else {
            u.query_pairs_mut().append_pair("url", &self.url);
        }
        Some(u.into())
    }
    pub fn thumbnail_url(&self, raw: &str) -> Option<String> {
        let mut u = Url::parse(&self.url).ok()?.join(raw).ok()?;
        if u.scheme() == "http" {
            u.set_scheme("https").ok()?;
        }
        let u = https_url(u.as_str())?;
        let hosts: &[&str] = match self.provider {
            Provider::Youtube => &["ytimg.com", "youtube.com"],
            Provider::Vimeo => &["vimeocdn.com"],
            Provider::Bilibili => &["hdslb.com", "biliimg.com"],
            Provider::Link => &[],
        };
        let host = u.host_str()?;
        (hosts.is_empty()
            || hosts
                .iter()
                .any(|h| host == *h || host.ends_with(&format!(".{h}"))))
        .then(|| u.into())
    }
}
pub fn https_url(raw: &str) -> Option<Url> {
    if raw.len() > 8192 {
        return None;
    }
    let u = Url::parse(raw).ok()?;
    (u.scheme() == "https"
        && u.username().is_empty()
        && u.password().is_none()
        && u.host_str().is_some())
    .then_some(u)
}
fn valid_id(p: Provider, id: &str) -> bool {
    match p {
        Provider::Youtube => {
            id.len() == 11
                && id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        }
        Provider::Vimeo => (6..=12).contains(&id.len()) && id.bytes().all(|c| c.is_ascii_digit()),
        Provider::Bilibili => {
            id.len() == 12 && id.starts_with("BV") && id.bytes().all(|c| c.is_ascii_alphanumeric())
        }
        Provider::Link => false,
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Metadata {
    title: Option<String>,
    thumbnail: Option<Vec<u8>>,
}
impl Metadata {
    pub fn new(title: Option<String>, thumbnail: Option<Vec<u8>>) -> Self {
        Self { title, thumbnail }
    }
    pub fn title(&self) -> Option<&str> {
        self.title.as_deref()
    }
    pub fn thumbnail(&self) -> Option<&[u8]> {
        self.thumbnail.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn providers_and_untrusted_urls() {
        for (url, embed) in [
            (
                "https://youtu.be/abcdefghijk",
                "https://www.youtube-nocookie.com/embed/abcdefghijk",
            ),
            (
                "https://vimeo.com/12345678",
                "https://player.vimeo.com/video/12345678",
            ),
            (
                "https://www.bilibili.com/video/BV1234567890",
                "https://player.bilibili.com/player.html?bvid=BV1234567890&autoplay=0",
            ),
        ] {
            assert_eq!(
                VideoCard::parse(url).unwrap().embed().as_deref(),
                Some(embed)
            );
        }
        for url in [
            "http://youtu.be/abcdefghijk",
            "https://user:pass@youtube.com/",
            "file:///etc/passwd",
            "javascript:alert(1)",
        ] {
            assert!(VideoCard::parse(url).is_none());
        }
        for url in [
            "https://youtube.com.evil.test/watch?v=abcdefghijk",
            "https://youtu.be/bad",
        ] {
            assert_eq!(VideoCard::parse(url).unwrap().embed(), None);
        }
        let forged: VideoCard = serde_json::from_str(
            r#"{"provider":"youtube","videoId":"bad\"/>","url":"https://example.com"}"#,
        )
        .unwrap();
        assert!(forged.embed().is_none());
        let card = VideoCard::parse("https://youtu.be/abcdefghijk").unwrap();
        assert!(
            card.thumbnail_url("https://ytimg.com.evil.test/a")
                .is_none()
        );
        assert_eq!(
            card.thumbnail_url("http://i.ytimg.com/a").unwrap(),
            "https://i.ytimg.com/a"
        );
    }
}
