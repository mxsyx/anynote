import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=",
  "base64",
);
test("bounded asset reads enforce identity, ranges, revision reference and corruption detection", async () => {
  const root = mkdtempSync(join(tmpdir(), "anynote-asset-range-")),
    s = new Storage(root);
  try {
    const b = await s.run("createNotebook", { title: "Asset range" }),
      n = await s.run("importFile", {
        notebookId: b.id,
        name: "pixel",
        mime: "image/png",
        data: png.toString("base64"),
      });
    const input = { notebookId: b.id, id: n.primary_resource_id, noteId: n.id };
    const info = await s.run("getAssetInfo", input);
    assert.equal(info.size, png.length);
    assert.deepEqual(
      Buffer.from(
        (
          await s.run("getAssetRange", {
            ...input,
            assetHash: info.hash,
            offset: 2,
            length: 20,
          })
        ).data,
        "base64",
      ),
      png.subarray(2, 22),
    );
    for (const patch of [
      { offset: -1, length: 1 },
      { offset: 0, length: 1024 ** 2 + 1 },
      { offset: 0, length: png.length + 1 },
      { offset: 0, length: 1, assetHash: "0".repeat(64) },
    ])
      await assert.rejects(
        s.run("getAssetRange", { ...input, assetHash: info.hash, ...patch }),
      );
    const other = await s.run("createNode", {
      notebookId: b.id,
      kind: "note",
      title: "Unrelated",
    });
    await assert.rejects(
      s.run("getAssetRange", {
        ...input,
        noteId: other.id,
        assetHash: info.hash,
        offset: 0,
        length: 1,
      }),
      /未引用/,
    );
    const asset = s
      .open(b.id)
      .prepare("SELECT path FROM assets WHERE hash=?")
      .get(info.hash);
    writeFileSync(s.notebookPath(b.id, asset.path), Buffer.alloc(png.length));
    await assert.rejects(s.run("getAssetInfo", input), /损坏/);
  } finally {
    s.close();
    rmSync(root, { recursive: true, force: true });
  }
});
