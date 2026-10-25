import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { readChatGPT } from "../apps/browser-extension/src/chatgpt-page.js";
import { zipSync } from "fflate";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import {
  sha256,
  manifestBytes,
  captureDigest,
  captureManifestSchema,
} from "../.build/packages/capture/format.js";
import { writeCapture } from "../.build/packages/capture/archive.js";
import {
  rewriteLinks,
  copyMarkdown,
  readableCitations,
} from "../.build/packages/capture/markdown.js";
import { conversationMarkdown } from "../.build/packages/capture/chatgpt.js";
import { convertComponents } from "../.build/packages/capture/chatgpt-components.js";
import { flow } from "./fixtures/chatgpt-components.mjs";

test("capture import preserves inline cards alongside localized media", async (t) => {
  const f = await fixture(t),
    c = await capture(),
    card = convertComponents(flow).body;
  c.body += "\n\n" + card;
  const bytes = new TextEncoder().encode(c.body);
  c.manifest.body = {
    path: "content.md",
    size: bytes.length,
    sha256: await sha256(bytes),
  };
  c.files["content.md"] = bytes;
  c.files["manifest.json"] = manifestBytes(c.manifest);
  const p = await preview(f, c);
  const created = await f.s.run("commitImportPreview", {
    notebookId: f.notebookId,
    previewId: p.preview.previewId,
  });
  const note = await f.s.run("getNote", {
    notebookId: f.notebookId,
    id: created.id,
  });
  assert.ok(note.body.includes(card.trim()));
  assert.match(note.body, /anynote-resource:[a-f0-9-]{36}/);
});

test("ChatGPT adapter excludes internal steps without dropping real unsupported media", async () => {
  const node = (parent, content, extra = {}) => ({
    parent,
    message: { author: { role: "assistant" }, content, ...extra },
  });
  const data = {
    title: "Fixture",
    current_node: "answer",
    mapping: {
      empty: node(null, { content_type: "text", parts: [""] }),
      thoughts: node("empty", { content_type: "thoughts", thoughts: [] }),
      recap: node("thoughts", {
        content_type: "reasoning_recap",
        content: "summary",
      }),
      tool: node(
        "recap",
        { content_type: "code", text: "search" },
        { recipient: "browser", channel: "commentary" },
      ),
      image: node("tool", {
        content_type: "multimodal_text",
        parts: [
          {
            content_type: "image_asset_pointer",
            asset_pointer: "private-file-pointer",
          },
        ],
      }),
      answer: node("image", {
        content_type: "text",
        parts: ['Answer<Cite refs={["turn1search0"]}/>'],
      }),
    },
  };
  const result = await runInNewContext(`(${readChatGPT.toString()})()`, {
    location: {
      origin: "https://chatgpt.com",
      pathname: "/c/fixture",
      href: "https://chatgpt.com/c/fixture",
    },
    document: { querySelectorAll: () => [] },
    fetch: async (path) =>
      new Response(
        JSON.stringify(
          path === "/api/auth/session" ? { accessToken: "secret" } : data,
        ),
      ),
    Blob,
    AbortController,
    setTimeout,
    clearTimeout,
  });
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.ok(!JSON.stringify(result).includes("private-file-pointer"));
  for (const id of ["thoughts", "recap", "tool"])
    assert.equal(result.nodes.find((n) => n.id === id).message, null);
  const converted = conversationMarkdown(result);
  assert.deepEqual(converted.messageIds, ["image", "answer"]);
  assert.equal(converted.missing.length, 1);
  assert.match(
    converted.missing[0].reason,
    /multimodal_text \/ image_asset_pointer/,
  );
  assert.ok(converted.body.includes("引用来源见原对话"));
  assert.ok(!converted.body.includes("<Cite"));
});

test("ChatGPT citation placeholders preserve literal code and ordinary Markdown", () => {
  const cite = '<Cite refs={["turn1search0","turn1search1"]}/>';
  const prose = `Text${cite}\n\n| A | B |\n|---|---|\n| 1 | 2 |`;
  const code = `\n\n\`${cite}\`\n\n\`\`\`jsx\n${cite}\n\`\`\``;
  assert.equal(
    readableCitations(prose + code),
    prose.replace(cite, "（引用来源见原对话）") + code,
  );
  assert.equal(
    readableCitations("Text\uE200cite\uE202turn0search0\uE201"),
    "Text（引用来源见原对话）",
  );
});

async function capture() {
  const bytes = new TextEncoder().encode("opaque attachment\n"),
    hash = await sha256(bytes),
    path = `assets/${hash}.bin`;
  const body = `# Captured\n\n[attachment](${path})\n\n\`[not a resource](assets/example.bin)\`\n`;
  const content = new TextEncoder().encode(body);
  const manifest = {
    format: "anynote.capture",
    version: 1,
    captureId: randomUUID(),
    title: "Captured",
    source: {
      kind: "selection",
      url: "https://example.com/article",
      capturedAt: new Date().toISOString(),
    },
    body: {
      path: "content.md",
      sha256: await sha256(content),
      size: content.length,
    },
    assets: [
      {
        path,
        sha256: hash,
        size: bytes.length,
        mime: "application/octet-stream",
        name: "attachment.bin",
      },
    ],
    missing: [],
    complete: true,
  };
  const files = {
    "manifest.json": manifestBytes(manifest),
    "content.md": content,
    [path]: bytes,
  };
  return { manifest, body, files, bytes, path };
}
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "anynote-capture-")),
    s = new Storage(root);
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const notebook = await s.run("createNotebook", { title: "Capture" });
  return { s, root, notebookId: notebook.id };
}
async function preview(f, c, files = c.files) {
  const file = join(f.root, `${randomUUID()}.anyclip`);
  writeFileSync(file, zipSync(files));
  return f.s.run("prepareCaptureFile", {
    notebookId: f.notebookId,
    path: file,
  });
}

test("capture export/import preserves bytes, remaps links and commits once across restart", async (t) => {
  const f = await fixture(t),
    c = await capture(),
    chunks = [];
  await writeCapture(
    c,
    async function* (path) {
      assert.equal(path, c.path);
      yield c.bytes;
    },
    async (bytes) => chunks.push(Buffer.from(bytes)),
  );
  const file = join(f.root, "export.anyclip");
  writeFileSync(file, Buffer.concat(chunks));
  const result = await f.s.run("prepareCaptureFile", {
    notebookId: f.notebookId,
    path: file,
  });
  assert.equal(result.preview.resources, 1);
  const first = await f.s.run("commitImportPreview", {
    notebookId: f.notebookId,
    previewId: result.preview.previewId,
  });
  const note = await f.s.run("getNote", {
    notebookId: f.notebookId,
    id: first.id,
  });
  assert.match(note.body, /anynote-resource:[a-f0-9-]{36}/);
  assert.ok(note.body.includes("`[not a resource](assets/example.bin)`"));
  f.s.close();
  f.s = new Storage(f.root);
  t.onTestFinished(() => f.s.close());
  const again = await preview(f, c);
  const second = await f.s.run("commitImportPreview", {
    notebookId: f.notebookId,
    previewId: again.preview.previewId,
  });
  assert.equal(second.id, first.id);
  assert.equal(
    (await f.s.run("listNodes", { notebookId: f.notebookId })).length,
    1,
  );
});

test("capture rejects changed content under the same receipt", async (t) => {
  const f = await fixture(t),
    c = await capture();
  const p = await preview(f, c);
  await f.s.run("commitImportPreview", {
    notebookId: f.notebookId,
    previewId: p.preview.previewId,
  });
  c.manifest.title = "Changed";
  c.files["manifest.json"] = manifestBytes(c.manifest);
  const changed = await preview(f, c);
  await assert.rejects(
    f.s.run("commitImportPreview", {
      notebookId: f.notebookId,
      previewId: changed.preview.previewId,
    }),
    /内容不同/,
  );
});

test("capture rejects corruption, undeclared entries and unsafe paths before creating notes", async (t) => {
  const f = await fixture(t),
    c = await capture();
  await assert.rejects(
    preview(f, c, { ...c.files, [c.path]: new Uint8Array(c.bytes.length) }),
    /哈希/,
  );
  await assert.rejects(
    preview(f, c, { ...c.files, "extra.txt": new Uint8Array() }),
    /条目/,
  );
  await assert.rejects(
    preview(f, c, { ...c.files, "../escape": new Uint8Array() }),
    /relative path|路径|条目/,
  );
  assert.equal(
    (await f.s.run("listNodes", { notebookId: f.notebookId })).length,
    0,
  );
});

test("capture metadata is versioned, deterministic, bounded and excludes authenticated source URLs", async () => {
  const c = await capture();
  assert.equal(
    await captureDigest(c.manifest),
    await captureDigest(
      Object.fromEntries(Object.entries(c.manifest).reverse()),
    ),
  );
  assert.throws(() =>
    captureManifestSchema.parse({ ...c.manifest, version: 2 }),
  );
  assert.throws(() =>
    captureManifestSchema.parse({
      ...c.manifest,
      source: {
        ...c.manifest.source,
        url: "https://example.com/?token=private",
      },
    }),
  );
  assert.throws(() =>
    captureManifestSchema.parse({
      ...c.manifest,
      missing: [{ name: "missing", reason: "failed" }],
    }),
  );
});

test("Markdown reference destinations change without modifying code or prose", () => {
  const body =
    '![picture][pic]\n\n[pic]: assets/photo.png "Title"\n\n`[x](assets/photo.png)`\n\n```md\n[x](assets/photo.png)\n```';
  const changed = rewriteLinks(body, (url) =>
    url === "assets/photo.png" ? "anynote-resource:resource" : url,
  );
  assert.match(changed, /\[pic\]: <anynote-resource:resource>/);
  assert.ok(changed.includes("`[x](assets/photo.png)`"));
  assert.ok(changed.includes("```md\n[x](assets/photo.png)\n```"));
  const copied = copyMarkdown(
    "![private](https://example.com/a.png?sig=secret)\n![local](assets/a.png)\n[public](https://example.com/article)",
  );
  assert.ok(!copied.includes("secret"));
  assert.ok(!copied.includes("assets/a.png"));
  assert.ok(copied.includes("https://example.com/article"));
});

test("ChatGPT histories follow the selected branch and reject missing parents/cycles", () => {
  const data = {
    id: "conversation",
    title: "Conversation",
    currentNode: "b",
    incomplete: false,
    nodes: [
      {
        id: "b",
        parent: "root",
        message: { role: "assistant", text: "selected" },
      },
      {
        id: "other",
        parent: "root",
        message: { role: "assistant", text: "regenerated" },
      },
      { id: "root", parent: null, message: { role: "user", text: "question" } },
    ],
  };
  const result = conversationMarkdown(data);
  assert.ok(result.body.indexOf("question") < result.body.indexOf("selected"));
  assert.ok(!result.body.includes("regenerated"));
  assert.throws(
    () => conversationMarkdown({ ...data, nodes: data.nodes.slice(0, 2) }),
    /父节点/,
  );
  assert.throws(
    () =>
      conversationMarkdown({
        ...data,
        nodes: data.nodes.map((n) => ({ ...n, parent: "b" })),
      }),
    /循环/,
  );
});

test("nested image links retain both localized destinations without leaking signed URLs", () => {
  const body =
    "[![picture](assets/image.png)](https://example.com/?secret=token)";
  const copied = copyMarkdown(body);
  assert.ok(!copied.includes("secret"));
  assert.ok(!copied.includes("assets/image"));
  const localized = rewriteLinks(body, (url) =>
    url.startsWith("assets/") ? "anynote-resource:id" : url,
  );
  assert.match(localized, /!\[picture\]\(<anynote-resource:id>\)/);
});

test("shared table conversion preserves media and links inside cells", async () => {
  const { markdownConverter } = await import(
    "../.build/packages/importer/convert.js"
  );
  const body = markdownConverter("https://example.com/").turndown(
    '<table><tr><th>Name</th><th>Media</th></tr><tr><td><a href="/note">note</a></td><td><img alt="picture" src="anynote-capture:fixture"></td></tr></table>',
  );
  assert.ok(body.includes("[note](https://example.com/note)"));
  assert.ok(body.includes("![picture](anynote-capture:fixture)"));
});
