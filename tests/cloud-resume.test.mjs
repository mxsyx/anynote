import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  openSync,
  writeSync,
  closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TransferSession } from "../.build/packages/backup/transfer-session.js";
import {
  cachedDownload,
  cachedChunk,
} from "../.build/packages/backup/transfer-download.js";
import {
  CloudflareClient,
  digest,
} from "../.build/packages/backup/providers.js";
import { fileSource } from "../.build/packages/protocol/file-source.js";

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "anynote-transfer-"));
  t.onTestFinished(() => rmSync(root, { force: true, recursive: true }));
  const target = {
    id: randomUUID(),
    endpoint: "https://backup.test",
    notebookId: randomUUID(),
    lineageId: randomUUID(),
    deviceId: randomUUID(),
    writerEpoch: 1,
  };
  return { root, target };
}

test("SIGKILL releases the lease and a new process reuses only synced download ranges", async (t) => {
  const { root, target } = setup(t);
  const child = spawnSync(process.execPath, [
    "tests/helpers/cloud-resume-child.mjs",
    root,
    JSON.stringify(target),
  ]);
  assert.equal(child.signal, "SIGKILL", child.stderr?.toString());
  const session = new TransferSession(root, target, "download");
  t.onTestFinished(() => session.close());
  const bytes = Buffer.alloc(32 * 1024 ** 2, 7),
    offsets = [];
  await cachedDownload(
    session,
    {
      async downloadObject(_path, { range }) {
        offsets.push(range.offset);
        return bytes.subarray(range.offset, range.offset + range.size);
      },
    },
    "/asset",
    join(root, "result"),
    { sha256: digest(bytes), size: bytes.length },
    new AbortController().signal,
    () => {},
  );
  assert.deepEqual(offsets, [16 * 1024 ** 2]);
  assert.equal(digest(readFileSync(join(root, "result"))), digest(bytes));
});

test("corrupted cached chunks and range suffixes are downloaded again before publication", async (t) => {
  const { root, target } = setup(t);
  const session = new TransferSession(root, target, "download");
  t.onTestFinished(() => session.close());
  const signal = new AbortController().signal;
  const chunk = Buffer.from("verified database bytes"),
    descriptor = { sha256: digest(chunk), size: chunk.length };
  writeFileSync(
    join(session.dir, "chunk." + descriptor.sha256),
    Buffer.alloc(chunk.length),
  );
  let requests = 0;
  assert.deepEqual(
    await cachedChunk(
      session,
      descriptor,
      async () => {
        requests++;
        return chunk;
      },
      signal,
    ),
    chunk,
  );
  await cachedChunk(
    session,
    descriptor,
    async () => {
      throw Error("cached chunk requested");
    },
    signal,
  );
  assert.equal(requests, 1);
  const bytes = Buffer.alloc(32 * 1024 ** 2 + 1, 9),
    expected = { sha256: digest(bytes), size: bytes.length };
  const file = join(session.dir, "asset." + expected.sha256);
  writeFileSync(file, bytes.subarray(0, 32 * 1024 ** 2));
  session.write("download.ranges." + expected.sha256, [
    digest(bytes.subarray(0, 16 * 1024 ** 2)),
    digest(bytes.subarray(16 * 1024 ** 2, 32 * 1024 ** 2)),
  ]);
  const fd = openSync(file, "r+");
  writeSync(fd, Buffer.from([0]), 0, 1, 16 * 1024 ** 2);
  closeSync(fd);
  const offsets = [];
  await cachedDownload(
    session,
    {
      async downloadObject(_path, { range }) {
        offsets.push(range.offset);
        return bytes.subarray(range.offset, range.offset + range.size);
      },
    },
    "/asset",
    join(root, "result"),
    expected,
    signal,
    () => {},
  );
  assert.deepEqual(offsets, [16 * 1024 ** 2, 32 * 1024 ** 2]);
  assert.equal(digest(readFileSync(join(root, "result"))), expected.sha256);
});

test("multipart cancellation persists receipts and changed source bytes cannot reuse them", async (t) => {
  const { root, target } = setup(t);
  const file = join(root, "source");
  const bytes = Buffer.alloc(33 * 1024 ** 2, 3);
  writeFileSync(file, bytes);
  let session = new TransferSession(root, target, "upload");
  const client = new CloudflareClient(target, { token: "fixture" });
  const puts = [];
  client.call = async (path, options) => {
    if (options.method === "PUT") {
      puts.push(path);
      return { partNumber: Number(path.split("/").pop()), etag: "etag" };
    }
    return path.endsWith("/multipart")
      ? { uploadId: "session" }
      : { verified: true };
  };
  const controller = new AbortController();
  // The source reader itself is allowed to finish; the next iteration must honor cancellation before network I/O.
  await assert.rejects(
    client.uploadFile(
      "/asset",
      fileSource(file, bytes.length),
      controller.signal,
      () => controller.abort(),
      session,
      digest(bytes),
    ),
  );
  session.close();
  session = new TransferSession(root, target, "upload");
  t.onTestFinished(() => session.close());
  const fd = openSync(file, "r+");
  writeSync(fd, Buffer.from([4]), 0, 1, 0);
  closeSync(fd);
  await assert.rejects(
    client.uploadFile(
      "/asset",
      fileSource(file, bytes.length),
      new AbortController().signal,
      () => {},
      session,
      digest(bytes),
    ),
    /切点/,
  );
  assert.equal(puts.length, 1);
});

test("session lease excludes concurrent writers and isolates endpoint and writer identity", (t) => {
  const { root, target } = setup(t);
  const session = new TransferSession(root, target, "upload");
  t.onTestFinished(() => session.close());
  assert.throws(() => new TransferSession(root, target, "upload"), /locked/);
  for (const override of [
    { endpoint: "https://other.test" },
    { writerEpoch: 2 },
    { lineageId: randomUUID() },
  ]) {
    const other = new TransferSession(
      root,
      { ...target, ...override },
      "upload",
    );
    assert.notEqual(other.dir, session.dir);
    other.close(true);
  }
});

test("range download refuses a full response or mismatched Content-Range", async () => {
  const client = new CloudflareClient(
    { endpoint: "https://backup.test" },
    { token: "fixture" },
  );
  for (const status of [200, 206]) {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("abc", {
        status,
        headers: { "Content-Range": "bytes 1-3/9" },
      }),
    );
    await assert.rejects(
      client.downloadObject("/asset", {
        maxBytes: 3,
        range: { offset: 3, size: 3, total: 9 },
      }),
      /范围/,
    );
  }
});

test("an expired multipart session starts afresh within the same retry", async (t) => {
  const { root, target } = setup(t);
  const session = new TransferSession(root, target, "upload");
  t.onTestFinished(() => session.close());
  const bytes = Buffer.from("new bytes"),
    hash = digest(bytes);
  session.write("upload.parts." + hash, {
    uploadId: "expired",
    parts: [{ partNumber: 1, etag: "old", sha256: hash }],
  });
  const client = new CloudflareClient(target, { token: "fixture" });
  const calls = [];
  client.call = async (path, options) => {
    calls.push(path);
    if (path.includes("expired")) throw Error("UPLOAD_SESSION_MISSING");
    if (options.method === "PUT") return { partNumber: 1, etag: "new" };
    return path.endsWith("/multipart")
      ? { uploadId: "fresh" }
      : { verified: true };
  };
  let processed = 0;
  await client.uploadFile(
    "/asset",
    { size: bytes.length, read: async () => bytes },
    new AbortController().signal,
    (bytes) => {
      processed += bytes;
    },
    session,
    hash,
  );
  assert.deepEqual(calls, [
    "/asset/multipart/expired",
    "/asset/multipart",
    "/asset/multipart/fresh/1",
    "/asset/multipart/fresh",
  ]);
  assert.equal(processed, bytes.length);
});
