import { test } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../.build/packages/storage-sqlite/index.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=",
  "base64",
);

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "anynote-image-")),
    s = new Storage(root);
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const b = await s.run("createNotebook", { title: "图片" });
  const call = (op, p = {}) => s.run(op, { notebookId: b.id, ...p });
  return { s, b, call };
}

test("imports SVG originals and enforces the raster pixel budget", async (t) => {
  const { call } = await fixture(t),
    svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
    );
  const image = await call("importFile", {
    name: "图.svg",
    mime: "image/svg+xml",
    data: svg.toString("base64"),
  });
  const asset = await call("getAsset", { id: image.primary_resource_id });
  assert.equal(asset.mime, "image/svg+xml");
  // The original SVG is stored untouched; sanitizing happens at render time.
  assert.equal(asset.data, svg.toString("base64"));

  const huge = Buffer.from(png);
  huge.writeUInt32BE(20_000, 16);
  huge.writeUInt32BE(20_000, 20);
  await assert.rejects(
    call("importFile", {
      name: "巨图.png",
      mime: "image/png",
      data: huge.toString("base64"),
    }),
    /边长|像素/,
  );
  await assert.rejects(
    call("importFile", {
      name: "伪造.svg",
      mime: "image/svg+xml",
      data: Buffer.from("not an svg").toString("base64"),
    }),
    /类型不一致/,
  );
});

test("stores image region annotations and saves a rotated copy as a new version", async (t) => {
  const { call } = await fixture(t),
    image = await call("importFile", {
      name: "图.png",
      mime: "image/png",
      data: png.toString("base64"),
    }),
    first = await call("getAssetInfo", { id: image.primary_resource_id });
  await call("addAnnotation", {
    id: image.id,
    assetHash: first.hash,
    page: 1,
    selector: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }],
    quote: "",
    body: "区域批注",
    color: "yellow",
  });
  const list = await call("listAnnotations", { id: image.id });
  assert.equal(list.length, 1);
  assert.equal(list[0].body, "区域批注");
  assert.equal(list[0].page, 1);

  // Editing produces a new immutable asset version while the edited bytes are
  // what is stored; annotations keep their old target hash until reanchored.
  const edited = Buffer.from(png);
  edited[edited.length - 2] ^= 0xff;
  const saved = await call("saveImageVersion", {
    id: image.id,
    expectedRevision: image.revision,
    assetHash: first.hash,
    data: edited.toString("base64"),
    mime: "image/png",
    name: "图.png",
  });
  assert.equal(saved.revision, image.revision + 1);
  const second = await call("getAssetInfo", { id: image.primary_resource_id });
  assert.notEqual(second.hash, first.hash);
  assert.equal(second.hash, createHash("sha256").update(edited).digest("hex"));
  assert.equal(
    (await call("listAnnotations", { id: image.id }))[0].target_asset_hash,
    first.hash,
  );
  await assert.rejects(
    call("saveImageVersion", {
      id: image.id,
      expectedRevision: saved.revision,
      assetHash: first.hash,
      data: edited.toString("base64"),
      mime: "image/png",
      name: "图.png",
    }),
    /版本已改变/,
  );
  await assert.rejects(
    call("saveImageVersion", {
      id: image.id,
      expectedRevision: saved.revision,
      assetHash: second.hash,
      data: edited.toString("base64"),
      mime: "image/png",
      name: "图.png",
    }),
    /内容未改变/,
  );
});

test("only image notes accept a new image version", async (t) => {
  const { call } = await fixture(t),
    note = await call("createNode", { title: "文字", body: "正文" });
  await assert.rejects(
    call("saveImageVersion", {
      id: note.id,
      expectedRevision: note.revision,
      assetHash: "a".repeat(64),
      data: png.toString("base64"),
      mime: "image/png",
      name: "图.png",
    }),
    /图片笔记/,
  );
});
