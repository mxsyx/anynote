import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { fetchVideoMetadata } from "../.build/packages/storage-sqlite/video-meta.js";
import { parseBlocks } from "../.build/packages/protocol/markdown.js";
import {
  parseVideoMetadata,
  thumbnailURL,
  videoCard,
  videoEmbed,
  videoMetadataURL,
} from "../.build/packages/protocol/video.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=",
  "base64",
);

test("normalizes whitelisted providers and generic video links", () => {
  assert.deepEqual(videoCard("https://youtu.be/dQw4w9WgXcQ"), {
    provider: "youtube",
    videoId: "dQw4w9WgXcQ",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  });
  assert.equal(
    videoCard("https://www.youtube.com/shorts/dQw4w9WgXcQ").provider,
    "youtube",
  );
  assert.equal(
    videoCard("https://www.youtube.com/embed/dQw4w9WgXcQ").videoId,
    "dQw4w9WgXcQ",
  );
  assert.equal(videoCard("https://vimeo.com/123456789").provider, "vimeo");
  assert.equal(
    videoCard("https://player.vimeo.com/video/123456789").videoId,
    "123456789",
  );
  assert.equal(
    videoCard("https://www.bilibili.com/video/BV1xx411c7mD/").videoId,
    "BV1xx411c7mD",
  );
  assert.equal(
    videoCard("https://example.com/talks/local-first").provider,
    "link",
  );
  // A malformed provider URL degrades to a generic link instead of an embed.
  assert.equal(
    videoCard("https://www.youtube.com/watch?v=short").provider,
    "link",
  );
  // Only credential-free HTTPS is accepted.
  assert.equal(videoCard("http://youtu.be/dQw4w9WgXcQ"), null);
  assert.equal(videoCard("javascript:alert(1)"), null);
  assert.equal(videoCard("https://user:pass@youtu.be/dQw4w9WgXcQ"), null);
});

test("rebuilds embed URLs from a validated provider and rejects tampering", () => {
  assert.equal(
    videoEmbed(videoCard("https://youtu.be/dQw4w9WgXcQ")),
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
  );
  assert.equal(
    videoEmbed(videoCard("https://vimeo.com/123456789")),
    "https://player.vimeo.com/video/123456789",
  );
  assert.match(
    videoEmbed(videoCard("https://www.bilibili.com/video/BV1xx411c7mD")),
    /player\.bilibili\.com\/player\.html\?bvid=BV1xx411c7mD/,
  );
  assert.equal(videoEmbed(videoCard("https://example.com/talk")), null);
  // A block claiming YouTube with an injected ID must not produce an iframe.
  assert.equal(
    videoEmbed({ provider: "youtube", videoId: "../../evil", url: "" }),
    null,
  );
});

test("restricts metadata and thumbnail hosts per provider", () => {
  const youtube = videoCard("https://youtu.be/dQw4w9WgXcQ"),
    link = videoCard("https://example.com/talk");
  assert.match(videoMetadataURL(youtube), /youtube\.com\/oembed/);
  assert.equal(videoMetadataURL(link), "https://example.com/talk");
  assert.equal(
    thumbnailURL(youtube, "https://i.ytimg.com/vi/x/hq.jpg"),
    "https://i.ytimg.com/vi/x/hq.jpg",
  );
  // A provider card refuses a thumbnail outside its known CDN.
  assert.equal(thumbnailURL(youtube, "https://evil.example/x.jpg"), null);
  // A generic link may use any public HTTPS host, and HTTP is upgraded.
  assert.equal(
    thumbnailURL(link, "http://cdn.example.com/x.jpg"),
    "https://cdn.example.com/x.jpg",
  );
  assert.equal(thumbnailURL(link, "javascript:alert(1)"), null);
});

test("parses provider JSON and OpenGraph HTML metadata", () => {
  const youtube = videoCard("https://youtu.be/dQw4w9WgXcQ"),
    bilibili = videoCard("https://www.bilibili.com/video/BV1xx411c7mD"),
    link = videoCard("https://example.com/talk");
  assert.deepEqual(
    parseVideoMetadata(
      youtube,
      JSON.stringify({
        title: "示例",
        thumbnail_url: "https://i.ytimg.com/vi/x/hq.jpg",
      }),
      "application/json",
    ),
    { title: "示例", thumbnail: "https://i.ytimg.com/vi/x/hq.jpg" },
  );
  assert.deepEqual(
    parseVideoMetadata(
      bilibili,
      JSON.stringify({
        data: { title: "B站", pic: "http://i0.hdslb.com/x.jpg" },
      }),
      "application/json",
    ),
    { title: "B站", thumbnail: "http://i0.hdslb.com/x.jpg" },
  );
  const html =
    "<html><head><title>Fallback</title>" +
    '<meta property="og:title" content="OG &amp; Title">' +
    '<meta name="og:image" content="https://cdn.example.com/a.png"></head></html>';
  assert.deepEqual(parseVideoMetadata(link, html, "text/html"), {
    title: "OG & Title",
    thumbnail: "https://cdn.example.com/a.png",
  });
  assert.deepEqual(
    parseVideoMetadata(
      link,
      "<html><head><title>仅标题</title></head>",
      "text/html",
    ),
    { title: "仅标题", thumbnail: undefined },
  );
});

test("fetches metadata and caches only a validated thumbnail", async () => {
  const youtube = videoCard("https://youtu.be/dQw4w9WgXcQ"),
    calls = [],
    download = async (url) => {
      calls.push(url);
      if (url.includes("oembed"))
        return {
          data: Buffer.from(
            JSON.stringify({
              title: "本地缓存",
              thumbnail_url: "https://i.ytimg.com/vi/x/hq.jpg",
            }),
          ),
          mime: "application/json",
          contentType: "application/json; charset=utf-8",
          url,
        };
      if (url.startsWith("https://i.ytimg.com/"))
        return { data: png, mime: "image/png", contentType: "image/png", url };
      throw Error("unexpected download " + url);
    };
  const meta = await fetchVideoMetadata(youtube, { download });
  assert.equal(meta.title, "本地缓存");
  assert.equal(meta.thumbnail.mime, "image/png");
  assert.deepEqual(calls, [
    "https://www.youtube.com/oembed?format=json&url=" +
      encodeURIComponent("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    "https://i.ytimg.com/vi/x/hq.jpg",
  ]);
  // An off-allowlist thumbnail host is dropped without a second download.
  const blocked = await fetchVideoMetadata(youtube, {
    download: async (url) => ({
      data: Buffer.from(
        JSON.stringify({
          title: "只有标题",
          thumbnail_url: "https://evil.example/x.png",
        }),
      ),
      mime: "application/json",
      contentType: "application/json",
      url,
    }),
  });
  assert.deepEqual(blocked, { title: "只有标题" });
});

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "anynote-video-")),
    s = new Storage(root);
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const book = await s.run("createNotebook", { title: "视频库" });
  return { s, book };
}

test("inserts generic cards and gates metadata behind the remote-embed switch", async (t) => {
  const { s, book } = await fixture(t),
    note = await s.run("createNode", {
      notebookId: book.id,
      title: "笔记",
      body: "正文",
    }),
    call = (op, p) => s.run(op, { notebookId: book.id, ...p }),
    blocks = (body) => parseBlocks(body).filter((b) => b.kind === "extension");
  const saved = await call("insertVideo", {
    id: note.id,
    expectedRevision: note.revision,
    url: "https://youtu.be/dQw4w9WgXcQ",
  });
  const [block] = blocks(saved.body);
  assert.equal(block.attrs.type, "core.video");
  assert.equal(block.data.provider, "youtube");
  assert.equal(block.data.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  const generic = await call("insertVideo", {
    id: note.id,
    expectedRevision: saved.revision,
    url: "https://example.com/talks/local-first",
  });
  assert.equal(blocks(generic.body).at(-1).data.provider, "link");
  await assert.rejects(
    () =>
      call("insertVideo", {
        id: note.id,
        expectedRevision: generic.revision,
        url: "http://youtu.be/dQw4w9WgXcQ",
      }),
    /有效的 HTTPS/,
  );
  assert.equal(
    await call("getExtensionSettings", {
      extensionId: "anynote.video",
      key: "remoteEmbed",
    }),
    true,
  );
  // Disabling remote embeds blocks the fetch before any network access.
  await call("setExtensionSetting", {
    extensionId: "anynote.video",
    key: "remoteEmbed",
    enabled: false,
  });
  await assert.rejects(
    () =>
      call("fetchVideoMeta", {
        id: note.id,
        expectedRevision: generic.revision,
        blockId: block.attrs.id,
        url: block.data.url,
      }),
    /远程嵌入/,
  );
  // Re-enabling still enforces the block/url match, still without network.
  await call("setExtensionSetting", {
    extensionId: "anynote.video",
    key: "remoteEmbed",
    enabled: true,
  });
  await assert.rejects(
    () =>
      call("fetchVideoMeta", {
        id: note.id,
        expectedRevision: generic.revision,
        blockId: block.attrs.id,
        url: "https://youtu.be/aaaaaaaaaaa",
      }),
    /地址不匹配/,
  );
  // The extension toggle disables inserting new cards.
  await call("setExtensionSetting", {
    extensionId: "anynote.video",
    enabled: false,
  });
  await assert.rejects(
    () =>
      call("insertVideo", {
        id: note.id,
        expectedRevision: generic.revision,
        url: "https://youtu.be/dQw4w9WgXcQ",
      }),
    /视频扩展已停用/,
  );
});
