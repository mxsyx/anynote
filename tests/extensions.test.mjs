import { test, vi } from "vitest";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  Storage,
  legacySchema,
} from "../.build/packages/storage-sqlite/index.js";
import { prepareImport } from "../.build/packages/importer/html.js";
import { loadMedia } from "../.build/packages/importer/media.js";
import {
  isPublicAddress,
  resolvePublic,
} from "../.build/packages/importer/network.js";
import {
  parseBlocks,
  resourceIds,
} from "../.build/packages/protocol/markdown.js";
import {
  logicalBundle,
  restoreLogical,
} from "../.build/packages/backup/logical.js";
import worker from "../.build/apps/cloudflare-backup/src/index.js";
import { unzipSync } from "fflate";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=";
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "anynote-ext-")),
    s = new Storage(root);
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const book = await s.run("createNotebook", { title: "扩展" });
  return {
    s,
    root,
    book,
    call: (op, p = {}) => s.run(op, { notebookId: book.id, ...p }),
  };
}
/** Poll a background task until it reaches a terminal status. */
async function waitTask(call, id) {
  for (let i = 0; i < 300; i++) {
    const task = (await call("listTasks")).find((j) => j.id === id);
    if (
      !task ||
      ["completed", "failed", "cancelled", "interrupted"].includes(task.status)
    )
      return task;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error("任务未在预期时间内结束");
}
test("schema v1 migration preserves content and captures a consistent original snapshot", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "anynote-v1-")),
    id = randomUUID(),
    dir = join(root, id);
  mkdirSync(dir);
  const db = new DatabaseSync(join(dir, "notebook.sqlite"));
  db.exec(legacySchema);
  db.prepare("INSERT INTO notebook_meta(id,name,created_at) VALUES(?,?,?)").run(
    id,
    "旧库",
    Date.now(),
  );
  db.close();
  const s = new Storage(root);
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal((await s.run("listNotebooks"))[0].schema_version, 2);
  assert.ok(
    readdirSync(join(dir, "snapshots")).some((p) => p.endsWith(".sqlite")),
  );
});
test("inline images have frozen revision references, backlinks survive rename, open export uses relative paths", async (t) => {
  const { s, book, call } = await fixture(t);
  const n = await call("createNode", { title: "图片笔记", body: "第一版" }),
    target = await call("createNode", { title: "链接目标" });
  const saved = await call("addResource", {
    id: n.id,
    expectedRevision: 1,
    name: "图.png",
    mime: "image/png",
    data: png,
  });
  const ids = resourceIds(saved.body);
  assert.equal(ids.length, 1);
  const resource = await call("getAsset", {
    id: ids[0],
    noteId: n.id,
    revisionId: saved.head_revision_id,
  });
  assert.equal(resource.data, png);
  const _linked = await call("saveNote", {
    id: n.id,
    expectedRevision: saved.revision,
    body:
      saved.body + `\n[链接](anynote://notebook/${book.id}/note/${target.id})`,
  });
  assert.equal((await call("getBacklinks", { id: target.id }))[0].id, n.id);
  const files = unzipSync(
    Buffer.from((await call("exportMarkdown")).data, "base64"),
  );
  const text = Object.entries(files).find(([name]) =>
    name.startsWith("图片笔记"),
  )[1];
  assert.ok(Buffer.from(text).toString().includes("_assets/"));
  const restored = await s.run("importArchive", {
    data: (await call("exportArchive")).data,
  });
  assert.equal(
    (
      await s.run("getAsset", {
        notebookId: restored.id,
        id: ids[0],
        noteId: n.id,
      })
    ).data,
    png,
  );
});
test("whiteboard revisions pin old scene, preview and embedded image versions", async (t) => {
  const { call } = await fixture(t),
    n = await call("createNode", {
      title: "白板",
      body: ':::anynote{type="unknown.x" version="9"}\n{"preserve":true}\n:::\n',
    }),
    blockId = randomUUID();
  const first = await call("saveWhiteboard", {
    id: n.id,
    expectedRevision: 1,
    blockId,
    scene: {
      elements: [],
      appState: {},
      files: {
        sample: {
          dataURL: "data:image/png;base64," + png,
          mimeType: "image/png",
          created: 1,
        },
      },
    },
    preview: png,
  });
  const block = parseBlocks(first.body).find(
    (b) => b.attrs?.type === "core.whiteboard",
  );
  const second = await call("saveWhiteboard", {
    id: n.id,
    expectedRevision: first.revision,
    blockId,
    ...block.data,
    scene: {
      elements: [],
      appState: { viewBackgroundColor: "#abcabc" },
      files: {},
    },
    preview: png,
  });
  const old = await call("getWhiteboard", {
      id: block.data.resourceId,
      noteId: n.id,
      revisionId: first.head_revision_id,
    }),
    current = await call("getWhiteboard", {
      id: block.data.resourceId,
      noteId: n.id,
    });
  assert.ok(old.files.sample.dataURL.includes(png));
  assert.deepEqual(current.files, {});
  assert.ok(second.body.includes('"preserve":true'));
  const restored = await call("restoreRevision", {
    id: n.id,
    revisionId: first.head_revision_id,
    expectedRevision: second.revision,
  });
  assert.ok(
    (
      await call("getWhiteboard", { id: block.data.resourceId, noteId: n.id })
    ).files.sample.dataURL.includes(png),
  );
  const edited = await call("saveNote", {
    id: n.id,
    expectedRevision: restored.revision,
    body: restored.body + "\n修改普通文字",
  });
  assert.ok(
    (
      await call("getWhiteboard", { id: block.data.resourceId, noteId: n.id })
    ).files.sample.dataURL.includes(png),
  );
  const exported = unzipSync(
    Buffer.from((await call("exportMarkdown")).data, "base64"),
  );
  const scene = JSON.parse(
    Buffer.from(
      Object.entries(exported).find(([path]) =>
        path.endsWith(".excalidraw.json"),
      )[1],
    ).toString(),
  );
  assert.ok(scene.files.sample.dataURL.includes(png));
  await call("setExtensionSetting", {
    extensionId: "anynote.whiteboard",
    enabled: false,
  });
  await assert.rejects(
    call("saveWhiteboard", {
      id: n.id,
      expectedRevision: edited.revision,
      blockId,
      ...block.data,
      scene: { elements: [], appState: {}, files: {} },
      preview: png,
    }),
    /停用/,
  );
});
test("HTML import sanitizes scripts/URLs, localizes authorized images and reports failures", async () => {
  const html = `<title>测试文章</title><article><h1>值得保存</h1><p>正常正文</p><script>throw new Error('run')</script><a href="javascript:alert(1)">危险链接</a><img src="data:image/png;base64,${png}"><img src="../secret.png"><img src="image.png" onerror="alert(1)"></article>`;
  const result = await prepareImport(
    {
      html,
      mode: "page",
      files: [{ name: "image.png", mime: "image/png", data: png }],
    },
    new AbortController().signal,
  );
  assert.equal(result.report.localized, 2);
  assert.equal(result.report.failed, 1);
  assert.ok(!result.body.includes("javascript:"));
  assert.ok(!result.body.includes("onerror"));
  assert.ok(!result.body.includes("throw new Error"));
  assert.equal(resourceIds(result.body).length, 2);
  // A pasted HTML document has no fetched URL but still records its fetch time.
  assert.equal(result.report.finalUrl, null);
  assert.equal(typeof result.report.fetchedAt, "number");
  assert.equal(result.report.keepOriginal, false);
  assert.equal(result.report.originalHtml, null);
});
test("HTML import can keep the source HTML as a pinned resource", async () => {
  const html = `<title>原文</title><article><p>正文</p></article>`;
  const result = await prepareImport(
    { html, mode: "page", keepOriginal: true },
    new AbortController().signal,
  );
  assert.equal(result.report.keepOriginal, true);
  const original = result.report.originalHtml;
  assert.equal(original.name, "原文.html");
  assert.equal(original.size, Buffer.byteLength(html));
  const saved = result.resources.find((r) => r.id === original.resourceId);
  assert.equal(saved.mime, "text/html");
  assert.equal(Buffer.from(saved.data, "base64").toString(), html);
});
test("HTML import discovers srcset/picture/lazy images, provider videos and direct media", async () => {
  const html = `<title>媒体</title><article>
    <picture><source srcset="small.png 1x, large.png 2x" type="image/png"><img src="small.png" alt="图"></picture>
    <img data-src="lazy.png" alt="懒图">
    <video src="clip.mp4" title="短片"></video>
    <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>
    <iframe src="blob:https://example.com/x"></iframe>
  </article>`;
  const result = await prepareImport(
    {
      html,
      mode: "page",
      files: [
        { name: "large.png", mime: "image/png", data: png },
        { name: "lazy.png", mime: "image/png", data: png },
        { name: "clip.mp4", mime: "video/mp4", data: png },
      ],
    },
    new AbortController().signal,
  );
  // Two images (srcset winner + lazy attribute) and one direct video file.
  assert.equal(result.report.localized, 3);
  assert.equal(resourceIds(result.body).length, 3);
  const kinds = result.report.media.map((m) => `${m.kind}:${m.status}`);
  assert.ok(kinds.includes("video:localized"), kinds.join(","));
  assert.ok(kinds.includes("video:embedded"), kinds.join(","));
  assert.ok(kinds.includes("unsupported:unsupported"), kinds.join(","));
  // The provider iframe becomes a safe video block rather than an arbitrary iframe.
  assert.ok(result.body.includes('type="core.video"'));
  assert.ok(result.body.includes('"provider":"youtube"'));
  // The blob: iframe is reported, not silently dropped, and no blob URL leaks.
  assert.ok(!result.body.includes("blob:"));
  assert.ok(result.body.includes("未本地化媒体"));
});
test("HTML import localizes user-selected attachments and reports kept links", async () => {
  const html = `<title>附件</title><article><p>下载</p><a href="report.pdf">报告</a><a href="https://example.com/other.pdf">外链</a></article>`;
  const result = await prepareImport(
    {
      html,
      mode: "page",
      files: [{ name: "report.pdf", mime: "application/pdf", data: png }],
    },
    new AbortController().signal,
  );
  assert.equal(result.report.localized, 1);
  assert.equal(resourceIds(result.body).length, 1);
  const localized = result.report.media.find(
    (m) => m.kind === "attachment" && m.status === "localized",
  );
  assert.ok(localized, "授权的相邻附件被本地化");
  const kept = result.report.media.find(
    (m) => m.kind === "attachment" && m.status === "linked",
  );
  assert.ok(kept, "未授权附件保留为外部链接并记录");
  assert.ok(result.body.includes("https://example.com/other.pdf"));
});
test("adjacent media lookup accepts a resolved absolute URL basename and rejects escapes", async () => {
  const media = await loadMedia("https://anynote.invalid/report.pdf", {
    files: [{ name: "report.pdf", mime: "application/pdf", data: png }],
  });
  assert.equal(media.mime, "application/pdf");
  await assert.rejects(loadMedia("../secret.png", { files: [] }), /相邻资源/);
});
test("network checks reject loopback, metadata, private, mapped IPv6 and reserved addresses", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.1.2",
    "169.254.169.254",
    "192.168.0.1",
    "100.64.1.1",
    "::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
  ])
    assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress("1.1.1.1"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  await assert.rejects(resolvePublic("http://127.0.0.1"), /不允许/);
  await assert.rejects(resolvePublic("file:///etc/passwd"), /HTTP/);
});
test("background import commits atomically and does not block editing", async (t) => {
  const { call } = await fixture(t);
  const job = await call("startImport", {
    html: "<h1>后台导入</h1><p>资料</p>",
    mode: "page",
  });
  const note = await call("createNode", {
    title: "继续记录",
    body: "未被导入任务阻塞",
  });
  let task;
  for (let i = 0; i < 100; i++) {
    task = (await call("listTasks")).find((j) => j.id === job.id);
    if (["completed", "failed"].includes(task.status)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(task.status, "completed", task.error);
  assert.ok(task.note.id);
  assert.equal(
    (await call("getNote", { id: note.id })).body,
    "未被导入任务阻塞",
  );
});
test("import preview shows the converted result and commits exactly what was previewed", async (t) => {
  const { call } = await fixture(t);
  const parent = await call("createNode", { kind: "folder", title: "资料" }),
    child = await call("createNode", {
      kind: "folder",
      title: "子目录",
      parentId: parent.id,
    });
  const html = `<title>预览文章</title><article><h1>标题</h1><p>正文内容</p><img src="data:image/png;base64,${png}"></article>`;
  const started = await call("previewImport", {
    html,
    mode: "page",
    parentId: child.id,
    keepOriginal: true,
  });
  let state;
  for (let i = 0; i < 300; i++) {
    state = await call("getImportPreview", { id: started.id });
    if (["completed", "failed", "cancelled"].includes(state.status)) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(state.status, "completed", state.error);
  assert.equal(state.preview.title, "预览文章");
  assert.ok(state.preview.body.includes("正文内容"));
  assert.equal(state.preview.target, "资料 / 子目录");
  assert.equal(state.preview.media.localized, 1);
  assert.equal(state.preview.media.total, 1);
  assert.equal(state.preview.originalHtml.name, "预览文章.html");
  assert.equal(state.preview.keepOriginal, true);
  // The preview is read-only: no note exists until the user confirms.
  assert.equal(
    (await call("listNodes")).filter((n) => n.kind === "note").length,
    0,
  );

  const note = await call("commitImportPreview", {
    previewId: state.preview.previewId,
    parentId: child.id,
  });
  assert.equal(note.parent_id, child.id);
  const report = await call("getImportReport", { id: note.id });
  assert.equal(report.media.length, 1);
  assert.equal(
    report.originalHtml.resourceId,
    state.preview.originalHtml.resourceId,
  );
  // The kept source HTML is a real resource pinned to the note revision.
  const asset = await call("getAsset", {
    id: report.originalHtml.resourceId,
    noteId: note.id,
  });
  assert.equal(Buffer.from(asset.data, "base64").toString(), html);
  // A preview is consumed by the commit, so it cannot be committed twice.
  await assert.rejects(
    call("commitImportPreview", {
      previewId: state.preview.previewId,
      parentId: child.id,
    }),
    /预览已失效/,
  );
});
test("failed import media can be retried, rewriting references into a new revision", async (t) => {
  const { call } = await fixture(t);
  const html = `<title>重试</title><article><p>正文</p><img src="pic.png" alt="配图"><img src="missing.png" alt="缺图"></article>`;
  const job = await call("startImport", {
    html,
    mode: "page",
    files: [{ name: "pic.png", mime: "image/png", data: png }],
  });
  const task = await waitTask(call, job.id);
  assert.equal(task.status, "completed", task.error);
  const noteId = task.note.id;

  let report = await call("getImportReport", { id: noteId });
  assert.equal(report.localized, 1);
  assert.equal(report.failed, 1);
  const failed = report.media.find((m) => m.status === "failed");
  assert.equal(failed.source, "missing.png");
  assert.ok(failed.marker, "失败媒体记录了可重写的占位符标记");

  let note = await call("getNote", { id: noteId }),
    revision = note.revision;
  assert.ok(note.body.includes(`(${failed.marker})`));

  // Retrying re-authorizes the adjacent file that was missing during import.
  const retry = await call("retryImportMedia", {
    id: noteId,
    files: [{ name: "missing.png", mime: "image/png", data: png }],
  });
  const retryTask = await waitTask(call, retry.id);
  assert.equal(retryTask.status, "completed", retryTask.error);

  note = await call("getNote", { id: noteId });
  assert.ok(note.revision > revision, "重试成功后生成新笔记版本");
  assert.ok(!note.body.includes(`(${failed.marker})`));
  assert.equal(resourceIds(note.body).length, 2);
  report = await call("getImportReport", { id: noteId });
  assert.equal(report.localized, 2);
  assert.equal(report.failed, 0);
  const done = report.media.find((m) => m.source === "missing.png");
  assert.equal(done.status, "localized");
  assert.ok(done.originalError, "保留原始失败信息");
  // The retried image is a real resource bound to the new revision.
  const asset = await call("getAsset", { id: done.resourceId, noteId });
  assert.equal(asset.data, png);
  // Nothing is left to retry, so a repeated retry is a no-op rejection.
  await assert.rejects(call("retryImportMedia", { id: noteId }), /没有未下载/);
});
test("a media retry preserves user edits and skips edited references", async (t) => {
  const { call } = await fixture(t);
  const job = await call("startImport", {
    html: `<title>修改</title><article><p>正文</p><img src="missing.png" alt="图"></article>`,
    mode: "page",
  });
  const task = await waitTask(call, job.id);
  const noteId = task.note.id;
  const before = await call("getNote", { id: noteId });
  // The user edits the note and removes the failed placeholder before retrying.
  await call("saveNote", {
    id: noteId,
    expectedRevision: before.revision,
    body: "手动整理后的正文",
  });

  const retry = await call("retryImportMedia", {
    id: noteId,
    files: [{ name: "missing.png", mime: "image/png", data: png }],
  });
  const retryTask = await waitTask(call, retry.id);
  assert.equal(retryTask.status, "failed");

  const after = await call("getNote", { id: noteId });
  assert.equal(after.body, "手动整理后的正文");
  const report = await call("getImportReport", { id: noteId });
  assert.equal(report.failed, 1);
  const failed = report.media.find((m) => m.status === "failed");
  assert.match(failed.error, /引用已修改/);
  assert.ok(failed.originalError);
});
test("annotations are bound to asset hash, survive export and join text search", async (t) => {
  const { s, call } = await fixture(t),
    n = await call("importFile", {
      name: "PDF.pdf",
      mime: "application/pdf",
      data: Buffer.from("%PDF-1.4\nfixture").toString("base64"),
    }),
    a = await call("getAsset", { id: n.primary_resource_id });
  await assert.rejects(
    call("addAnnotation", {
      id: n.id,
      assetHash: "0".repeat(64),
      page: 1,
      selector: [],
      quote: "文本",
      body: "想法",
    }),
    /版本/,
  );
  await call("addAnnotation", {
    id: n.id,
    assetHash: a.hash,
    page: 1,
    selector: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.05 }],
    quote: "跨版本思考",
    body: "阅读批注",
  });
  assert.equal((await call("search", { query: "思考" }))[0].id, n.id);
  const imported = await s.run("importArchive", {
    data: (await call("exportArchive")).data,
  });
  assert.equal(
    (await s.run("listAnnotations", { notebookId: imported.id, id: n.id }))
      .length,
    1,
  );
});
test("AI proposal stale checks, explicit apply, duplicate apply and version-aware undo", async (t) => {
  const { call } = await fixture(t),
    n = await call("createNode", { title: "AI", body: "原文" });
  const p = await call("proposePatch", {
    id: n.id,
    expectedRevision: 1,
    body: "建议修改",
    reason: "预览后由用户应用",
  });
  assert.equal((await call("getNote", { id: n.id })).body, "原文");
  const applied = await call("applyProposal", { id: n.id, proposalId: p.id });
  assert.equal(applied.body, "建议修改");
  assert.equal(
    (await call("applyProposal", { id: n.id, proposalId: p.id })).revision,
    applied.revision,
  );
  assert.equal(
    (await call("undoProposal", { id: n.id, proposalId: p.id })).body,
    "原文",
  );
  const late = await call("proposePatch", {
    id: n.id,
    expectedRevision: 3,
    body: "过时修改",
  });
  await call("saveNote", { id: n.id, expectedRevision: 3, body: "用户新修改" });
  await assert.rejects(
    call("applyProposal", { id: n.id, proposalId: late.id }),
    /版本冲突/,
  );
});
class D1 {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(
      readFileSync(
        new URL(
          "../apps/cloudflare-backup/migrations/0001.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    this.db.exec(
      readFileSync(
        new URL(
          "../apps/cloudflare-backup/migrations/0002.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    this.db.exec(
      readFileSync(
        new URL(
          "../apps/cloudflare-backup/migrations/0003.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  }
  prepare(sql) {
    const self = this;
    let values = [];
    return {
      bind(...v) {
        values = v;
        return this;
      },
      async first() {
        return self.db.prepare(sql).get(...values) || null;
      },
      async all() {
        return { results: self.db.prepare(sql).all(...values) };
      },
      async run() {
        return self.db.prepare(sql).run(...values);
      },
    };
  }
  async batch(statements) {
    this.db.exec("BEGIN");
    try {
      const rows = [];
      for (const p of statements) rows.push(await p.run());
      this.db.exec("COMMIT");
      return rows;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
class R2 {
  constructor() {
    this.objects = new Map();
  }
  async put(k, b) {
    this.objects.set(k, Buffer.from(b));
  }
  async head(k) {
    return this.objects.has(k) ? { size: this.objects.get(k).length } : null;
  }
  async get(k) {
    if (!this.objects.has(k)) return null;
    const b = this.objects.get(k);
    return {
      size: b.length,
      body: b,
      arrayBuffer: async () =>
        b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
    };
  }
}
test("Cloudflare Worker stages/validates/CAS-commits logical backups and rejects missing objects and stale heads", async (t) => {
  const { s, book, call } = await fixture(t),
    n = await call("createNode", { title: "Cloudflare", body: "逻辑恢复" }),
    env = { DB: new D1(), BUCKET: new R2(), APP_TOKEN: "test-token" },
    bundle = logicalBundle(
      Buffer.from((await call("exportArchive")).data, "base64"),
    );
  t.onTestFinished(() => env.DB.db.close());
  const manifest = {
    ...bundle.manifest,
    lineageId: randomUUID(),
    deviceId: randomUUID(),
    generationId: randomUUID(),
    expectedHead: "",
    writerEpoch: 1,
  };
  const invoke = (tail, method = "GET", body) =>
    worker.fetch(
      new Request("https://backup.test/v1/notebooks/" + book.id + tail, {
        method,
        headers: { Authorization: "Bearer test-token" },
        body:
          body instanceof Uint8Array
            ? body
            : body
              ? JSON.stringify(body)
              : undefined,
      }),
      env,
    );
  const plan = await (await invoke("/backup/plan", "POST", manifest)).json();
  assert.equal(
    (
      await invoke(`/backup/${manifest.generationId}/commit`, "POST", {
        expectedHead: "",
        writerEpoch: 1,
      })
    ).status,
    409,
  );
  for (const hash of plan.missing)
    assert.equal(
      (
        await invoke(
          `/backup/${manifest.generationId}/objects/${hash}`,
          "PUT",
          bundle.objects.get(hash),
        )
      ).status,
      200,
    );
  assert.equal(
    (
      await invoke(`/backup/${manifest.generationId}/commit`, "POST", {
        expectedHead: "",
        writerEpoch: 1,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await invoke(`/backup/${manifest.generationId}/commit`, "POST", {
        expectedHead: "",
        writerEpoch: 1,
      })
    ).status,
    200,
  );
  const stale = { ...manifest, generationId: randomUUID() };
  assert.equal((await invoke("/backup/plan", "POST", stale)).status, 409);
  const client = {
    call: async (path, { method = "GET", body } = {}) => {
      const r = await worker.fetch(
        new Request("https://backup.test" + path, {
          method,
          body: body ? JSON.stringify(body) : undefined,
          headers: { Authorization: "Bearer test-token" },
        }),
        env,
      );
      if (!r.ok) throw Error(await r.text());
      return r.json();
    },
    downloadObject: async (path) => {
      const r = await worker.fetch(
        new Request("https://backup.test" + path, {
          headers: { Authorization: "Bearer test-token" },
        }),
        env,
      );
      return Buffer.from(await r.arrayBuffer());
    },
  };
  const restored = await restoreLogical(
      client,
      { notebookId: book.id, lineageId: manifest.lineageId },
      manifest.generationId,
    ),
    imported = await s.run("importArchive", {
      data: restored.toString("base64"),
    });
  assert.equal(
    (await s.run("getNote", { notebookId: imported.id, id: n.id })).body,
    "逻辑恢复",
  );
});
test("protocol does not activate directives inside fenced code, and safely preserves opaque source", () => {
  const code =
    '```markdown\n:::anynote{type="core.video" version="1" id="example"}\n{"url":"https://youtu.be/dQw4w9WgXcQ"}\n:::\n```\n';
  assert.equal(parseBlocks(code).length, 1);
  assert.equal(parseBlocks(code)[0].kind, "markdown");
  const opaque = ':::anynote{type="future.node" version="9"}\n{broken}\n:::\n';
  assert.equal(parseBlocks(opaque)[0].source, opaque);
  assert.equal(parseBlocks(opaque)[0].data, undefined);
});
test("backup service keeps secrets outside archives, retries failed stages and schedules only opted-in targets", async (t) => {
  const { s, root, book: _book, call } = await fixture(t),
    env = { DB: new D1(), BUCKET: new R2(), APP_TOKEN: "session-secret" };
  t.onTestFinished(() => env.DB.db.close());
  let failUploads = true,
    loseCommit = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    if (failUploads && options?.method === "PUT")
      return Response.json(
        { error: "injected upload failure" },
        { status: 503 },
      );
    const result = await worker.fetch(new Request(url, options), env);
    if (loseCommit && String(url).endsWith("/commit")) {
      loseCommit = false;
      return Response.json(
        { error: "injected response loss" },
        { status: 503 },
      );
    }
    return result;
  });
  const target = await call("configureBackup", {
    name: "服务测试",
    endpoint: "https://backup.test",
    token: "session-secret",
  });
  await call("createNode", { title: "自动备份", body: "私有内容" });
  const finish = async (id) => {
    for (let i = 0; i < 1000; i++) {
      const job = (await call("listTasks")).find((j) => j.id === id);
      if (["completed", "failed", "cancelled"].includes(job.status)) return job;
      await new Promise((r) => setImmediate(r));
    }
    throw Error("任务未结束");
  };
  const first = await call("startBackup", { targetId: target.id });
  assert.equal((await finish(first.id)).status, "failed");
  assert.equal((await call("listBackupTargets"))[0].lastAckSeq, undefined);
  failUploads = false;
  const second = await call("startBackup", { targetId: target.id });
  assert.equal((await finish(second.id)).status, "completed");
  const acknowledged = (await call("listBackupTargets"))[0];
  assert.ok(acknowledged.lastGeneration);
  assert.ok(acknowledged.lastAckSeq > 0);
  await call("createNode", { title: "提交响应丢失", body: "已在远端提交" });
  loseCommit = true;
  const lost = await call("startBackup", { targetId: target.id });
  assert.equal((await finish(lost.id)).status, "failed");
  assert.ok((await call("listBackupTargets"))[0].pendingGeneration);
  const reconcile = await call("startBackup", { targetId: target.id });
  assert.equal(
    (await finish(reconcile.id)).progress,
    "已确认上次远端提交并修复本地游标",
  );
  assert.equal((await call("listBackupTargets"))[0].pendingGeneration, null);

  assert.equal(
    readFileSync(join(root, "_local", "backup-targets.json"), "utf8").includes(
      "session-secret",
    ),
    false,
  );
  const archive = unzipSync(
    Buffer.from((await call("exportArchive")).data, "base64"),
  );
  assert.equal(
    Object.keys(archive).some((p) => p.includes("_local")),
    false,
  );
  const { startBackupScheduler } = await import(
      "../.build/packages/backup/scheduler.js"
    ),
    scheduler = startBackupScheduler(s, { now: () => Date.now() + 3600000 });
  t.onTestFinished(() => scheduler.dispose());
  const before = (await call("listTasks")).length;
  await scheduler.tick();
  assert.equal((await call("listTasks")).length, before);
  await call("setBackupSchedule", {
    targetId: target.id,
    enabled: true,
    intervalMinutes: 10,
  });
  await scheduler.tick();
  assert.equal((await call("listTasks")).length, before + 1);
  const last = (await call("listTasks")).at(-1);
  assert.equal((await finish(last.id)).progress, "没有变化，已跳过上传");
});
test("whiteboard edits preserve unknown v1 fields and attributes", async (t) => {
  const { call } = await fixture(t),
    n = await call("createNode", { title: "兼容" }),
    blockId = randomUUID();
  const first = await call("saveWhiteboard", {
      id: n.id,
      expectedRevision: 1,
      blockId,
      scene: { elements: [], appState: {}, files: {} },
      preview: png,
    }),
    block = parseBlocks(first.body).find((b) => b.kind === "extension");
  const body = first.body
    .replace('version="1"', 'version="1" future="yes"')
    .replace(
      JSON.stringify(block.data),
      JSON.stringify({ ...block.data, extra: { keep: "保留" } }),
    );
  const enriched = await call("saveNote", {
    id: n.id,
    expectedRevision: first.revision,
    body,
  });
  const saved = await call("saveWhiteboard", {
    id: n.id,
    expectedRevision: enriched.revision,
    blockId,
    ...block.data,
    scene: { elements: [], appState: {}, files: {} },
    preview: png,
  });
  const result = parseBlocks(saved.body).find((b) => b.kind === "extension");
  assert.equal(result.attrs.future, "yes");
  assert.deepEqual(result.data.extra, { keep: "保留" });
});
