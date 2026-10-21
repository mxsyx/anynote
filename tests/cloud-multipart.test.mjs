import { test } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { multipart } from "../.build/apps/cloudflare-backup/src/multipart.js";
import { R2 } from "./helpers/cloud-adapters.mjs";

test("multipart verifies the whole file before publication and clears failed staging data", async () => {
  const bucket = new R2(),
    bytes = Buffer.from("immutable attachment");
  const expected = {
    hash: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
  const key = `objects/book/${expected.hash}`;
  const send = (method, body, token, part) =>
    multipart(
      new Request("https://backup.test/upload", { method, body }),
      bucket,
      key,
      "staging/book",
      expected,
      token,
      part,
    );
  await bucket.put(key, bytes);
  const { uploadId } = await send("POST");
  const part = await send("PUT", Buffer.alloc(bytes.length), uploadId, 1);
  await assert.rejects(
    send("POST", JSON.stringify({ parts: [part] }), uploadId),
    /SHA-256/,
  );
  assert.deepEqual(bucket.objects.get(key), bytes);
  assert.deepEqual([...bucket.objects.keys()], [key]);
  assert.equal(bucket.uploads.size, 0);

  const next = await send("POST");
  const good = await send("PUT", bytes, next.uploadId, 1);
  assert.deepEqual(
    await send("POST", JSON.stringify({ parts: [good] }), next.uploadId),
    { verified: true },
  );
  assert.deepEqual(bucket.objects.get(key), bytes);
  assert.deepEqual([...bucket.objects.keys()], [key]);
});

test("multipart abort discards transport parts without publishing an object", async () => {
  const bucket = new R2(),
    expected = { hash: "a".repeat(64), size: 4 };
  const send = (method, body, token, part) =>
    multipart(
      new Request("https://backup.test/upload", { method, body }),
      bucket,
      "objects/asset",
      "staging/book",
      expected,
      token,
      part,
    );
  const { uploadId } = await send("POST");
  await assert.rejects(send("PUT", Buffer.alloc(3), uploadId, 1), /大小/);
  await send("PUT", Buffer.alloc(4), uploadId, 1);
  await send("DELETE", undefined, uploadId);
  assert.equal(bucket.uploads.size, 0);
  assert.equal(bucket.objects.size, 0);
});

test("interrupted verified-copy finalization reuses the private completed object", async () => {
  const bucket = new R2(),
    bytes = Buffer.from("verified copy retry");
  const expected = {
    hash: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
  const key = `objects/book/${expected.hash}`;
  const create = bucket.createMultipartUpload.bind(bucket);
  let fail = true;
  bucket.createMultipartUpload = async (path) => {
    const upload = await create(path);
    if (path === key && fail)
      return {
        ...upload,
        uploadPart: async () => {
          fail = false;
          throw Error("copy interrupted");
        },
      };
    return upload;
  };
  const send = (method, body, token, part) =>
    multipart(
      new Request("https://backup.test/upload", { method, body }),
      bucket,
      key,
      "staging/book",
      expected,
      token,
      part,
    );
  const { uploadId } = await send("POST");
  const part = await send("PUT", bytes, uploadId, 1);
  await assert.rejects(
    send("POST", JSON.stringify({ parts: [part] }), uploadId),
    /copy interrupted/,
  );
  assert.equal(bucket.uploads.size, 0);
  assert.equal(
    bucket.objects.size,
    1,
    "private completed transport object remains resumable",
  );
  assert.deepEqual(
    await send("POST", JSON.stringify({ parts: [part] }), uploadId),
    { verified: true },
  );
  assert.deepEqual(bucket.objects.get(key), bytes);
  assert.equal(bucket.objects.size, 1);
});
