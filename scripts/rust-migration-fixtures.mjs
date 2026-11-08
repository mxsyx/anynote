import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Storage } from "../.build/packages/backend/index.js";
import { schema } from "../.build/packages/storage-sqlite/schema.js";
import { revisionSQL } from "../.build/packages/storage-sqlite/backup-revision.js";
import { parseBlocks } from "../.build/packages/protocol/markdown.js";
import {
  manifestBytes,
  captureDigest,
} from "../.build/packages/capture/format.js";
import { writeCapture } from "../.build/packages/capture/archive.js";
import { snapshotBundle } from "../.build/packages/backup/cloud-archive.js";
import { browseSnapshot } from "../.build/packages/backup/browse-snapshot.js";
import { captureLocalNotebook } from "../.build/packages/backup/local-capture.js";
import {
  LocalBackupService,
  initializeTarget,
} from "../.build/packages/backup-local/index.js";
import { writeArchive } from "../.build/packages/storage-sqlite/archive-stream.js";
import { unzipSync, zipSync } from "fflate";
import { multiPagePdf } from "./acceptance/pdf-fixture.mjs";

export const baselineCommit = "60a8c4b614b8831d2a16366a79d595942e7b87a1";
export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const json = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
};
export function filesUnder(root) {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? filesUnder(join(root, entry.name))
        : [join(root, entry.name)],
    )
    .sort();
}

// Rebuilding intentionally creates new UUIDs/timestamps. Frozen files are never
// updated by tests; their hashes and old-reader results are the comparison oracle.
async function generate(out) {
  mkdirSync("tmp", { recursive: true });
  const root = mkdtempSync(resolve("tmp/rm01-generate-"));
  const s = new Storage(join(root, "source"));
  const observations = [];
  const record = async (op, input = {}) => {
    try {
      const result = await s.run(op, input);
      observations.push({ op, input, outcome: "resolved", result });
      return result;
    } catch (error) {
      observations.push({
        op,
        input,
        outcome: "rejected",
        error: { name: error.name, message: error.message, code: error.code },
      });
      throw error;
    }
  };
  const put = (name, bytes) => {
    mkdirSync(dirname(join(out, name)), { recursive: true });
    writeFileSync(join(out, name), bytes);
  };
  try {
    const book = await record("createNotebook", { title: "RM01 合成兼容库" });
    const call = (op, p = {}) => record(op, { notebookId: book.id, ...p });
    put("schema.sql", schema);
    put("backup-revision.sql", revisionSQL);
    const markdown = [
      "# 中文 😀 e\u0301\n\n原有 __强调__ 和 *斜体*、~~删除~~、`代码`。\n\n> 引用\n\n- 列表\n  - 子项\n\n1. 有序\n\n- [x] 完成\n- [ ] 待办\n\n| 左 | 右 |\n| :-- | --: |\n| a | b |\n",
      '前段\r\n\r\n:::anynote{type="future.custom" version="9" id="opaque" extra="keep"}\r\n{"unknown":{"keep":[1,"😀"]}}\r\n:::\r\n后段\r\n',
      '```md\n:::anynote{type="not.a.block" version="1"}\n{}\n:::\n```\n\n~~~\n:::anynote{type="also.code"}\n{}\n:::\n~~~\n',
      ':::anynote{type="broken.json" version="1"}\n{broken\n:::\n\n:::anynote{type="unclosed"}\n{}\n',
      '<section data-unknown="keep">HTML 原文</section>\n\n[引用][ref]\n\n[ref]: https://example.invalid/ "保留"\n',
      ':::anynote{type="garden.reading.card" version="1" id="reading"}\n{"excerpt":"摘录","thoughts":"思考","unknown":true}\n:::\n',
    ];
    json(
      join(out, "markdown.json"),
      markdown.map((source, i) => ({
        id: `md-${i + 1}`,
        source,
        blocks: parseBlocks(source),
      })),
    );
    json(
      join(out, "markdown-boundaries.json"),
      [10240, 102400, 500000, 500001].map((codeUnits) => {
        const seed = "中😀abc\n";
        const source = seed
          .repeat(Math.ceil(codeUnits / seed.length))
          .slice(0, codeUnits);
        return {
          codeUnits,
          seed,
          recipe: "repeat seed then slice UTF-16 code units",
          utf8Bytes: Buffer.byteLength(source),
          sha256: digest(source),
        };
      }),
    );
    const folder = await call("createNode", { kind: "folder", title: "目录" });
    const note = await call("createNode", {
      parentId: folder.id,
      title: "Markdown",
      body: markdown.join("\n"),
    });
    const updated = await call("saveNote", {
      id: note.id,
      expectedRevision: note.revision,
      body:
        note.body + `\n[自身](anynote://notebook/${book.id}/note/${note.id})`,
      tags: ["合成", "边界"],
      favorite: true,
    });
    await assert.rejects(
      call("saveNote", { id: note.id, expectedRevision: 1, body: "不能覆盖" }),
    );
    await assert.rejects(call("getNote", { id: "invalid-uuid" }));
    const trash = await call("createNode", {
      title: "回收站",
      body: "保留删除内容",
    });
    await call("trashNode", { id: trash.id });
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=";
    put("media/pixel.png", Buffer.from(png, "base64"));
    put("media/three-pages.pdf", multiPagePdf(3));
    const image = await call("importFile", {
      name: "pixel.png",
      mime: "image/png",
      data: png,
    });
    const pdf = await call("importFile", {
      name: "three-pages.pdf",
      mime: "application/pdf",
      data: Buffer.from(multiPagePdf(3)).toString("base64"),
    });
    const asset = await call("getAssetInfo", {
      id: pdf.primary_resource_id,
      noteId: pdf.id,
    });
    await call("addAnnotation", {
      id: pdf.id,
      assetHash: asset.hash,
      page: 2,
      selector: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.1 }],
      quote: "Anynote page 2",
      body: "合成批注",
    });
    const board = await call("createNode", {
      title: "白板历史",
      body: "# 白板\n",
    });
    const types = [
      "rectangle",
      "diamond",
      "ellipse",
      "text",
      "line",
      "arrow",
      "freedraw",
      "image",
      "frame",
      "iframe",
      "embeddable",
    ];
    const elements = types.map((type, i) => ({
      id: `element-${i}`,
      type,
      x: i * 30,
      y: 10,
      width: 20,
      height: 20,
      angle: 0,
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: i + 1,
      version: 1,
      versionNonce: i + 1,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
      customData: { unknown: "preserve" },
      ...(type === "text"
        ? {
            text: "文字😀",
            originalText: "文字😀",
            fontSize: 20,
            fontFamily: 1,
            textAlign: "left",
            verticalAlign: "top",
            containerId: null,
            autoResize: true,
            lineHeight: 1.25,
          }
        : {}),
      ...(["line", "arrow", "freedraw"].includes(type)
        ? {
            points: [
              [0, 0],
              [20, 20],
            ],
            startBinding: null,
            endBinding: null,
            startArrowhead: null,
            endArrowhead: type === "arrow" ? "arrow" : null,
            pressures: [0.5, 0.8],
            simulatePressure: false,
          }
        : {}),
      ...(type === "image"
        ? { fileId: "sample", status: "saved", scale: [1, 1], crop: null }
        : {}),
    }));
    const scene = {
      elements,
      appState: {
        viewBackgroundColor: "#ffffff",
        scrollX: 4,
        scrollY: 6,
        zoom: { value: 1.25 },
      },
      files: {
        sample: {
          dataURL: `data:image/png;base64,${png}`,
          mimeType: "image/png",
          created: 1,
        },
      },
    };
    json(join(out, "scene-input.json"), scene);
    const blockId = randomUUID();
    const first = await call("saveWhiteboard", {
      id: board.id,
      expectedRevision: 1,
      blockId,
      scene,
      preview: png,
    });
    const block = parseBlocks(first.body).find(
      (b) => b.attrs?.type === "core.whiteboard",
    );
    await call("saveWhiteboard", {
      id: board.id,
      expectedRevision: first.revision,
      blockId,
      ...block.data,
      scene: { ...scene, elements: [], files: {} },
      preview: png,
    });
    const historicalScene = await call("getWhiteboard", {
      id: block.data.resourceId,
      noteId: board.id,
      revisionId: first.head_revision_id,
    });
    assert.deepEqual(historicalScene.elements, elements);
    json(join(out, "scene-readback.json"), historicalScene);
    const db = s.open(book.id);
    db.prepare(
      "INSERT INTO extension_data(extension_id,key,value_json,schema_version) VALUES(?,?,?,?)",
    ).run(
      "unknown.fixture",
      "opaque.state",
      '{"unknown":[1,"保留"],"version":9}',
      9,
    );
    const captureImage = Buffer.from(png, "base64");
    const captureImagePath = `assets/${digest(captureImage)}.png`;
    const captureBody = `# 浏览器采集\n\n合成文字与表格\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n![采集图片](${captureImagePath})\n`;
    const bytes = Buffer.from(captureBody);
    const manifest = {
      format: "anynote.capture",
      version: 1,
      captureId: randomUUID(),
      title: "合成采集",
      source: {
        kind: "selection",
        url: "https://example.invalid/article",
        capturedAt: "2026-11-08T00:00:00.000Z",
      },
      body: { path: "content.md", size: bytes.length, sha256: digest(bytes) },
      assets: [
        {
          path: captureImagePath,
          sha256: digest(captureImage),
          size: captureImage.length,
          mime: "image/png",
          name: "pixel.png",
        },
      ],
      missing: [],
      complete: true,
    };
    const chunks = [];
    await writeCapture(
      { manifest, body: captureBody },
      async function* (path) {
        assert.equal(path, captureImagePath);
        yield captureImage;
      },
      async (chunk) => chunks.push(Buffer.from(chunk)),
    );
    put("capture.anyclip", Buffer.concat(chunks));
    json(join(out, "capture-manifest.json"), manifest);
    const prepared = await s.run("prepareCaptureFile", {
      notebookId: book.id,
      path: join(out, "capture.anyclip"),
    });
    const captured = await call("commitImportPreview", {
      previewId: prepared.preview.previewId,
    });
    const receipt = {
      captureId: manifest.captureId,
      digest: await captureDigest(manifest),
      noteId: captured.id,
      appliedSeq: db
        .prepare("SELECT applied_seq FROM capture_receipts WHERE capture_id=?")
        .get(manifest.captureId).applied_seq,
    };
    json(join(out, "cloud-capture-acks.json"), [receipt]);
    const full = Buffer.from(
      (await s.run("exportArchive", { notebookId: book.id })).data,
      "base64",
    );
    put("full.anynote", full);
    const currentJob = await s.run("startExportArchiveFile", {
      notebookId: book.id,
      path: join(out, "current.anynote"),
      currentOnly: true,
    });
    await s.jobs.get(currentJob.id).promise;
    assert.equal(
      s.jobs.get(currentJob.id).status,
      "completed",
      s.jobs.get(currentJob.id).error,
    );
    const archive = unzipSync(full);
    const archiveManifest = JSON.parse(
      Buffer.from(archive["manifest.json"]).toString(),
    );
    json(join(out, "archive-manifest.json"), archiveManifest);
    for (const [name, data] of Object.entries(archive))
      put(join("notebook", name), data);
    await writeArchive(
      join(out, "zip64.anynote"),
      archiveManifest,
      (name) => join(out, "notebook", name),
      { forceZip64: true },
    );
    const snapshot = snapshotBundle(full);
    const projectionFile = join(root, "projection.sqlite");
    writeFileSync(projectionFile, archive["notebook.sqlite"]);
    const projection = await browseSnapshot(
      projectionFile,
      new AbortController().signal,
      [manifest.captureId],
    );
    assert(projection.browse);
    snapshot.manifest.browse = projection.browse;
    snapshot.manifest.captureAcks = projection.captureAcks;
    for (const [hash, source] of projection.sources)
      snapshot.objects.set(hash, readFileSync(source.file));
    json(join(out, "cloud-snapshot.json"), snapshot.manifest);
    for (const [hash, data] of snapshot.objects)
      put(`cloud-objects/${hash}.bin`, data);
    const disk = join(root, "disk");
    mkdirSync(disk);
    const target = await initializeTarget(disk, [s.root]);
    const engine = new LocalBackupService();
    await engine.backup(
      target,
      book.id,
      async () => {
        const dir = mkdtempSync(join(root, "capture-"));
        const result = await captureLocalNotebook(s, book.id, dir);
        result.release = async () =>
          rmSync(dir, { recursive: true, force: true });
        return result;
      },
      { sources: [s.root] },
    );
    await engine.verify(target, book.id);
    cpSync(join(target.path, "notebooks", book.id), join(out, "local-backup"), {
      recursive: true,
    });
    const badManifest = { ...archiveManifest, schemaVersion: 999 };
    put(
      "invalid/unknown-schema.anynote",
      zipSync({
        ...archive,
        "manifest.json": Buffer.from(JSON.stringify(badManifest)),
      }),
    );
    put(
      "invalid/database-hash.anynote",
      zipSync({ ...archive, "notebook.sqlite": Buffer.from("not a database") }),
    );
    put(
      "invalid/path-traversal.anynote",
      zipSync({ ...archive, "../escape": Buffer.from("denied") }),
    );
    put(
      "invalid/body-hash.anyclip",
      zipSync({
        "manifest.json": manifestBytes(manifest),
        "content.md": Buffer.from("tampered"),
        [captureImagePath]: captureImage,
      }),
    );
    put(
      "invalid/unknown-version.anyclip",
      zipSync({
        "manifest.json": Buffer.from(
          JSON.stringify({ ...manifest, version: 999 }),
        ),
        "content.md": bytes,
        [captureImagePath]: captureImage,
      }),
    );
    const invalidCloud = structuredClone(snapshot.manifest);
    invalidCloud.database.chunks[0].size++;
    json(join(out, "invalid/cloud-chunk.json"), invalidCloud);
    const localManifest = JSON.parse(
      readFileSync(join(out, "local-backup/.backup/manifest.json"), "utf8"),
    );
    json(join(out, "invalid/local-files.json"), {
      ...localManifest,
      files: [],
    });
    const nodes = await call("listNodes");
    const notes = [];
    for (const row of nodes.filter((n) => n.kind === "note")) {
      notes.push({
        note: await call("getNote", { id: row.id }),
        history: await call("history", { id: row.id }),
      });
    }
    json(join(out, "expected.json"), {
      notebookId: book.id,
      folderId: folder.id,
      markdownId: updated.id,
      trashId: trash.id,
      imageId: image.id,
      pdfId: pdf.id,
      boardId: board.id,
      boardResourceId: block.data.resourceId,
      boardRevisionId: first.head_revision_id,
      notes,
      extensionData: db
        .prepare("SELECT * FROM extension_data ORDER BY extension_id,key")
        .all(),
      revisionResources: db
        .prepare(
          "SELECT * FROM revision_resources ORDER BY revision_id,resource_id",
        )
        .all(),
      annotations: db.prepare("SELECT * FROM annotations ORDER BY id").all(),
      sqliteMaster: db
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
        )
        .all(),
    });
    json(join(out, "observations.json"), observations);
    json(join(out, "manifest.json"), {
      format: "anynote.rust-migration-fixtures",
      version: 1,
      baselineCommit,
      generatedAt: new Date().toISOString(),
      node: process.version,
      sqlite: process.versions.sqlite,
      source: "synthetic-only; generated by unchanged TS implementation",
      sceneScope:
        "storage preservation of synthetic element fields; not Excalidraw interaction acceptance",
      files: filesUnder(out).map((path) => ({
        path: path.slice(out.length + 1),
        size: readFileSync(path).length,
        sha256: digest(readFileSync(path)),
      })),
    });
  } finally {
    for (const job of s.jobs.values()) job.controller?.abort();
    await Promise.all([...s.jobs.values()].map((job) => job.promise));
    s.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const out = process.argv[2];
assert(
  out,
  "Usage: node scripts/rust-migration-fixtures.mjs <new output directory>",
);
assert.equal(
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  baselineCommit,
  "Rebuild in the frozen baseline checkout, with this generator copied in",
);
assert.equal(
  execFileSync(
    "git",
    ["diff", baselineCommit, "--", "apps", "packages", "pnpm-lock.yaml"],
    { encoding: "utf8" },
  ),
  "",
  "Baseline source must be unchanged; rebuild backend before generating",
);
mkdirSync(resolve(out), { recursive: false });
await generate(resolve(out));
console.log(`Generated synthetic corpus: ${out}`);
