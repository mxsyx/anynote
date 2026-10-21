import { databaseCapture } from "./helpers/database-capture.mjs";
import { test } from "vitest";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chunkAlignment,
  itemRef,
  oneDriveManifest,
  oneDriveProvider,
  parseItemRef,
  uploadChunkRanges,
} from "../.build/extensions/backup-onedrive/index.js";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * In-memory Graph: implements only the endpoints the Provider actually uses, to verify directory resolution, chunked upload,
 * eTag conflict handling, and download recovery; it does not replace real-API acceptance.
 */
function createFakeGraph() {
  const driveId = "drive-1",
    appRootId = "approot",
    items = new Map(),
    sessions = new Map();
  let nextId = 1,
    etagSeq = 0;

  const makeItem = (overrides) => {
    const id = overrides.id ?? `item-${nextId++}`;
    const item = {
      id,
      name: overrides.name,
      parentId: overrides.parentId,
      driveId,
      isFolder: overrides.isFolder ?? false,
      bytes: overrides.bytes ?? null,
      eTag: `W/"${++etagSeq}"`,
    };
    items.set(id, item);
    return item;
  };
  makeItem({ id: appRootId, name: "Apps/Anynote", isFolder: true });

  const childrenOf = (parentId) =>
    [...items.values()].filter((item) => item.parentId === parentId);

  const childByName = (parentId, name) =>
    childrenOf(parentId).find((item) => item.name === name) ?? null;

  const toJson = (item) => ({
    id: item.id,
    name: item.name,
    size: item.bytes ? item.bytes.length : 0,
    eTag: item.eTag,
    cTag: item.eTag,
    parentReference: { driveId, id: item.parentId },
    ...(item.isFolder ? { folder: { childCount: 0 } } : {}),
    ...(item.isFolder
      ? {}
      : { file: { mimeType: "application/octet-stream" } }),
  });

  const fail = (status) => {
    throw Object.assign(Error(`HTTP ${status}`), { status });
  };

  const fake = {
    driveId,
    appRootId,
    items,
    /** Force the next content write to return a conflict, to verify eTag/same-name conflict handling. */
    failNextWrite: null,

    resolveContentRange(headers) {
      const value = headers["Content-Range"] ?? headers["content-range"];
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? "");
      if (!match) fail(400);
      return {
        start: Number(match[1]),
        end: Number(match[2]),
        total: Number(match[3]),
      };
    },

    request(url, init = {}) {
      const method = init.method ?? "GET",
        parsed = new URL(url),
        segs = parsed.pathname
          .replace(/^\/v1\.0/, "")
          .split("/")
          .filter(Boolean);

      if (segs.join("/") === "me/drive/special/approot")
        return ok(toJson(items.get(appRootId)));

      if (segs.join("/") === "me/drive")
        return ok({
          id: driveId,
          driveType: "personal",
          quota: { total: 1_000_000, remaining: 900_000, used: 100_000 },
        });

      if (segs[0] !== "drives") fail(404);
      assert.equal(segs[1], driveId);
      const rawItem = segs[3] ?? "",
        isPath = rawItem.endsWith(":"),
        parentOrId = decodeURIComponent(rawItem).replace(/:$/, ""),
        tail = segs.slice(4),
        action = isPath ? tail[1] : tail[0],
        pathName = isPath
          ? decodeURIComponent((tail[0] ?? "").replace(/:$/, ""))
          : undefined;

      if (action === "children") {
        if (method === "POST") {
          const body = JSON.parse(Buffer.from(init.body).toString("utf8"));
          if (
            body["@microsoft.graph.conflictBehavior"] === "fail" &&
            childByName(parentOrId, body.name)
          )
            fail(409);
          return ok(
            toJson(
              makeItem({
                name: body.name,
                parentId: parentOrId,
                isFolder: true,
              }),
            ),
          );
        }
        return ok({ value: childrenOf(parentOrId).map(toJson) });
      }

      if (action === "createUploadSession") {
        const uploadUrl = `https://upload.example/session-${sessions.size + 1}`;
        sessions.set(uploadUrl, {
          parentId: isPath ? parentOrId : undefined,
          name: pathName,
          itemId: isPath ? undefined : parentOrId,
          bytes: Buffer.alloc(0),
        });
        return ok({ uploadUrl, expirationDateTime: new Date().toISOString() });
      }

      if (action === "content") {
        if (method === "GET") {
          const item = items.get(parentOrId);
          if (!item) fail(404);
          return raw(item.bytes ?? Buffer.alloc(0));
        }
        if (method === "PUT") {
          if (fake.failNextWrite) {
            const status = fake.failNextWrite;
            fake.failNextWrite = null;
            fail(status);
          }
          const body = Buffer.from(init.body);
          const item = isPath
            ? createOrReplace(parentOrId, pathName, body, parsed)
            : updateById(parentOrId, body, init.headers);
          return ok(toJson(item));
        }
      }

      if (method === "DELETE") {
        if (!items.delete(parentOrId)) fail(404);
        return raw(new Uint8Array(), 204);
      }

      if (method === "GET" && !action) {
        const item = items.get(parentOrId);
        if (!item) fail(404);
        return ok(toJson(item));
      }

      fail(404);

      /** Path create/overwrite: follows conflictBehavior semantics. */
      function createOrReplace(parentId, name, body, url) {
        const behavior =
            url.searchParams.get("@microsoft.graph.conflictBehavior") ??
            "replace",
          existing = childByName(parentId, name);
        if (existing && behavior === "fail") fail(409);
        const item = existing ?? makeItem({ name, parentId });
        item.bytes = body;
        item.isFolder = false;
        item.eTag = `W/"${++etagSeq}"`;
        return item;
      }

      /** Update by itemId: validates the If-Match version to avoid overwriting concurrent writes. */
      function updateById(id, body, headers) {
        const item = items.get(id);
        if (!item) fail(404);
        const ifMatch = headers?.["If-Match"];
        if (ifMatch && ifMatch !== item.eTag) fail(412);
        item.bytes = body;
        item.eTag = `W/"${++etagSeq}"`;
        return item;
      }
    },

    upload(url, init) {
      const session = sessions.get(url);
      if (!session) fail(404);
      const { start, end, total } = fake.resolveContentRange(
        init.headers ?? {},
      );
      const chunks = [];
      // init.source is AsyncIterable<Uint8Array>.
      return (async () => {
        for await (const chunk of init.source) chunks.push(chunk);
        const appended = Buffer.concat(chunks);
        session.bytes = Buffer.concat([session.bytes, appended]);
        assert.equal(start, session.bytes.length - appended.length);
        if (end + 1 < total)
          return ok({ nextExpectedRanges: [`${end + 1}-`] }, 202);
        const item = session.itemId
            ? items.get(session.itemId)
            : childByName(session.parentId, session.name),
          target =
            item ??
            makeItem({ name: session.name, parentId: session.parentId });
        target.bytes = session.bytes;
        target.isFolder = false;
        target.eTag = `W/"${++etagSeq}"`;
        sessions.delete(url);
        return ok(toJson(target), 201);
      })();
    },

    downloadToFile(url, _init, options = {}) {
      if (options.dest?.startsWith("chunks/"))
        assert.ok(options.maxBytes > 0 && options.maxBytes <= 1024 ** 2);
      const parsed = new URL(url),
        segs = parsed.pathname
          .replace(/^\/v1\.0/, "")
          .split("/")
          .filter(Boolean),
        item = items.get(decodeURIComponent(segs[3]));
      if (!item)
        return Promise.reject(
          Object.assign(Error("HTTP 404"), { status: 404 }),
        );
      const bytes = item.bytes ?? Buffer.alloc(0);
      return Promise.resolve({
        filePath: options.dest ?? "/tmp/anynote-onedrive-test",
        bytes: bytes.length,
        sha256: options.hash ? sha256(bytes) : undefined,
      });
    },
  };
  return fake;
}

function ok(value, status = 200) {
  return {
    status,
    headers: {},
    bytes: Buffer.from(JSON.stringify(value)),
  };
}

/** Raw byte response (content download). */
function raw(bytes, status = 200) {
  return { status, headers: {}, bytes: Buffer.from(bytes) };
}

/** Build a runtime context that implements only the required facades. */
function createContext(fake) {
  const store = new Map();
  return {
    accounts: {
      current: () => ({
        providerId: "onedrive",
        oauthClientId: "c",
        accountId: "a",
      }),
      request: (url, init) => Promise.resolve(fake.request(url, init)),
      upload: (url, init) => Promise.resolve(fake.upload(url, init)),
      downloadToFile: (url, init, options) =>
        fake.downloadToFile(url, init, options),
    },
    http: (url, init) => Promise.resolve(fake.request(url, init)),
    tasks: {
      signal: new AbortController().signal,
      progress() {},
      log() {},
      concurrency: () => 2,
    },
    state: {
      async get(key) {
        return store.has(key) ? store.get(key) : null;
      },
      async set(key, value) {
        store.set(key, value);
      },
      async delete(key) {
        store.delete(key);
      },
    },
    verifier: {
      sha256: (bytes) => sha256(Buffer.from(bytes)),
      createHasher: () => {
        const hash = createHash("sha256");
        return {
          update: (chunk) => hash.update(chunk),
          digest: () => hash.digest("hex"),
        };
      },
    },
    deviceLabel: "测试设备",
  };
}

test("OneDrive Provider 声明应用目录最小权限与能力", () => {
  assert.equal(oneDriveProvider.id, "onedrive");
  assert.equal(oneDriveProvider.capabilities.appScopedStorage, true);
  assert.equal(oneDriveProvider.capabilities.resumableUpload, true);
  // Conditional writes are not yet verified: CAS capability must not be declared (design §9.2, §12.3).
  assert.equal(oneDriveProvider.capabilities.conditionalHead, false);
  assert.deepEqual(oneDriveProvider.capabilities.providerChecksum, []);
  assert.ok(
    oneDriveProvider.accountDescriptor.scopes.includes(
      "Files.ReadWrite.AppFolder",
    ),
  );
  assert.ok(oneDriveManifest.permissions.includes("accounts:onedrive"));
  assert.equal(oneDriveManifest.contributes.backupProviders[0].beta, undefined);
});

test("对象引用与 320KiB 分片对齐", () => {
  const ref = itemRef("b!drive", "01ITEM");
  assert.deepEqual(parseItemRef(ref), {
    driveId: "b!drive",
    itemId: "01ITEM",
  });
  assert.throws(() => parseItemRef("no-separator"));

  const size = chunkAlignment * 2 + 100,
    ranges = uploadChunkRanges(size, chunkAlignment * 2);
  assert.deepEqual(
    ranges.map((range) => [range.offset, range.end]),
    [
      [0, chunkAlignment * 2],
      [chunkAlignment * 2, size],
    ],
  );
  // Non-final chunks must be aligned to 320KiB; the final chunk may be unaligned.
  assert.equal(ranges[0].length % chunkAlignment, 0);
  assert.throws(() => uploadChunkRanges(10, 1234), /320KiB/);
});

test("OneDrive 端到端：分块去重、eTag 冲突拒绝、恢复读回", async () => {
  const fake = createFakeGraph(),
    ctx = createContext(fake),
    notebookId = randomUUID(),
    deviceSlotId = randomUUID();
  ctx.notebookId = notebookId;

  const handle = await oneDriveProvider.ensureTarget(
    { notebookId, notebookName: "Test", deviceSlotId },
    ctx,
  );
  assert.match(handle.deviceSlotRef, /^drive-1::/);

  const dbBytes = Buffer.concat([
      Buffer.alloc(1024 ** 2, 1),
      Buffer.alloc(1024 ** 2, 2),
      Buffer.alloc(1024 ** 2, 1),
      Buffer.from("tail"),
    ]),
    capture = {
      notebookId,
      notebookName: "Test",
      contentSeq: 3,
      schemaVersion: 4,
      database: databaseCapture(dbBytes),
      assets: [],
      release: async () => {},
    };

  const plan = await oneDriveProvider.plan(
    { capture, target: handle, previous: null, previousHead: null },
    ctx,
  );
  assert.equal(plan.items.length, 3);
  assert.equal(plan.uploadBytes, 2 * 1024 ** 2 + 4);
  plan.capture = capture;

  const prepared = await oneDriveProvider.execute(plan, ctx);
  const manifest = await oneDriveProvider.verify(prepared, ctx);
  assert.equal(manifest.database.chunks[0].verification, "download-sha256");
  assert.equal(manifest.assets.length, 0);

  // A concurrent writer already published current: a same-name/version conflict must be rejected, not overwritten.
  fake.failNextWrite = 409;
  await assert.rejects(
    oneDriveProvider.publish({ prepared, observedHead: null }, ctx),
    /已被其他写入者更新/,
  );

  const committed = await oneDriveProvider.publish(
    { prepared, observedHead: null },
    ctx,
  );
  assert.equal(committed.commitId, plan.commitId);

  const slots = await oneDriveProvider.listCurrentBackups(ctx);
  assert.equal(slots.slots.length, 1);
  assert.equal(slots.slots[0].deviceSlotId, deviceSlotId);

  const bundle = await oneDriveProvider.download(
    await oneDriveProvider.prepareRestore({ deviceSlotId }, ctx),
    ctx,
  );
  assert.equal(bundle.manifest.database.sha256, sha256(dbBytes));
  assert.equal(bundle.manifest.database.chunks.length, 4);
  assert.equal(new Set(bundle.databaseChunks.map((c) => c.sha256)).size, 3);
  const changed = Buffer.from(dbBytes);
  changed[1024 ** 2] = 99;
  const incremental = await oneDriveProvider.plan(
    {
      capture: { ...capture, database: databaseCapture(changed) },
      target: handle,
      previous: manifest,
      previousHead: committed.head,
    },
    ctx,
  );
  assert.equal(incremental.items.length, 1);
  assert.equal(incremental.uploadBytes, 1024 ** 2);

  assert.equal(bundle.assets.length, 0);
});

test("OneDrive 第二设备只读恢复按名称定位远端槽", async () => {
  const fake = createFakeGraph(),
    writerCtx = createContext(fake),
    notebookId = randomUUID(),
    deviceSlotId = randomUUID();
  writerCtx.notebookId = notebookId;
  const handle = await oneDriveProvider.ensureTarget(
    { notebookId, notebookName: "Test", deviceSlotId },
    writerCtx,
  );
  const dbBytes = Buffer.from("second-device-db"),
    capture = {
      notebookId,
      notebookName: "Test",
      contentSeq: 1,
      schemaVersion: 4,
      database: databaseCapture(dbBytes),
      assets: [],
      release: async () => {},
    };
  const plan = await oneDriveProvider.plan(
    { capture, target: handle, previous: null, previousHead: null },
    writerCtx,
  );
  plan.capture = capture;
  const prepared = await oneDriveProvider.execute(plan, writerCtx);
  await oneDriveProvider.verify(prepared, writerCtx);
  await oneDriveProvider.publish({ prepared, observedHead: null }, writerCtx);

  // New device: the local slot table is empty, so remote slots can only be discovered by name under the Notebook directory.
  const readerCtx = createContext(fake);
  readerCtx.notebookId = notebookId;
  await oneDriveProvider.ensureTarget(
    { notebookId, notebookName: "Test", deviceSlotId: randomUUID() },
    readerCtx,
  );
  const bundle = await oneDriveProvider.download(
    await oneDriveProvider.prepareRestore({ deviceSlotId }, readerCtx),
    readerCtx,
  );
  assert.equal(bundle.manifest.database.sha256, sha256(dbBytes));
});
