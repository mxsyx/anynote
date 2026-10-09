import { test, afterAll } from "vitest";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFileLevelBackup } from "../.build/packages/cloud-backup-common/index.js";
import {
  cloudBackupExtension,
  contentHashBlockBytes,
  createDropboxClient,
  dropboxCapabilities,
  dropboxContentHash,
  dropboxErrorCode,
  dropboxProvider,
  isDropboxConflict,
  sessionThresholdBytes,
} from "../.build/extensions/backup-dropbox/index.js";

const tempRoot = mkdtempSync(join(tmpdir(), "anynote-dropbox-"));

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** An independent implementation of the Dropbox content hash, to verify the chunking logic (design §11.2) [D2]. */
function referenceDropboxHash(bytes) {
  const overall = createHash("sha256");
  for (let offset = 0; offset < bytes.length; offset += 4 * 1024 * 1024) {
    const block = bytes.subarray(
      offset,
      Math.min(offset + 4 * 1024 * 1024, bytes.length),
    );
    overall.update(createHash("sha256").update(block).digest());
  }
  return overall.digest("hex");
}

/** Wrap bytes as the read-only source the Provider needs. */
function sourceOf(bytes) {
  const buffer = Buffer.from(bytes);
  return {
    size: buffer.length,
    read: async (offset, length) => buffer.subarray(offset, offset + length),
    stream: async function* () {
      if (buffer.length) yield buffer;
    },
  };
}

/** Minimal capture result handle. */
function captureOf({ notebookId, database, assets = [] }) {
  return {
    notebookId,
    notebookName: "测试笔记库",
    contentSeq: 3,
    schemaVersion: 2,
    database: { ...sourceOf(database), sha256: sha256(database) },
    assets: assets.map((asset) => {
      const bytes = Buffer.from(asset.content),
        digest = sha256(bytes);
      return {
        path: `assets/sha256/${digest.slice(0, 2)}/${digest}.bin`,
        sha256: digest,
        size: bytes.length,
        mimeType: asset.mimeType,
        ...sourceOf(bytes),
      };
    }),
    release: async () => {},
  };
}

/**
 * In-memory Dropbox service stub: implements the endpoint semantics the Dropbox Provider uses.
 *
 * Covers key real-API behaviors: case-insensitive paths, the content_hash chunking algorithm, and upload
 * session offset assembly, `add` no-overwrite, and the `update` rev conditional-write conflict.
 */
function createDropboxStub(options = {}) {
  const nodes = new Map(),
    sessions = new Map(),
    stats = { sessionStarts: 0, uploads: 0 };
  let counter = 0;

  const nextId = () => `id-${(counter += 1)}`,
    nextRev = () => `rev-${(counter += 1)}`,
    lower = (path) => path.toLowerCase(),
    parentOf = (path) => {
      const index = path.lastIndexOf("/");
      return index <= 0 ? "" : path.slice(0, index);
    };

  const fail = (status, summary) => {
    const error = Object.assign(Error(`Dropbox HTTP ${status}: ${summary}`), {
      status,
      bytes: Buffer.from(
        JSON.stringify({
          error_summary: summary,
          error: { ".tag": summary.split("/")[0] },
        }),
      ),
    });
    throw error;
  };

  const metadata = (node) =>
    node.isFolder
      ? {
          ".tag": "folder",
          id: node.id,
          name: node.name,
          path_lower: node.pathLower,
          path_display: node.pathDisplay,
        }
      : {
          ".tag": "file",
          id: node.id,
          name: node.name,
          path_lower: node.pathLower,
          path_display: node.pathDisplay,
          rev: node.rev,
          size: node.size,
          content_hash: options.corruptContentHash
            ? "0".repeat(64)
            : node.contentHash,
        };

  const createFolder = (path) => {
    const key = lower(path);
    if (nodes.has(key)) return nodes.get(key);
    const parent = parentOf(key);
    if (parent) createFolder(parent);
    const node = {
      id: nextId(),
      name: path.split("/").at(-1),
      pathLower: key,
      pathDisplay: path,
      isFolder: true,
    };
    nodes.set(key, node);
    return node;
  };

  const putFile = (path, content, mode) => {
    const key = lower(path),
      parent = parentOf(key);
    if (parent && !nodes.get(parent)) fail(409, "path/not_found/.");
    const existing = nodes.get(key);
    if (existing?.isFolder) fail(409, "path/conflict/folder/.");
    if (!existing && mode[".tag"] === "update") fail(409, "path/not_found/.");
    if (existing && mode[".tag"] === "add") fail(409, "path/conflict/file/.");
    if (existing && mode[".tag"] === "update" && mode.update !== existing.rev)
      fail(409, "path/conflict/file/.");
    const node = {
      id: existing?.id ?? nextId(),
      name: path.split("/").at(-1),
      pathLower: key,
      pathDisplay: path,
      isFolder: false,
      content,
      size: content.length,
      rev: nextRev(),
      contentHash: referenceDropboxHash(content),
    };
    nodes.set(key, node);
    return node;
  };

  const children = (path, recursive) => {
    const base = lower(path),
      result = [];
    for (const node of nodes.values()) {
      if (node.pathLower === base) continue;
      const parent = parentOf(node.pathLower);
      if (!recursive ? parent === base : node.pathLower.startsWith(base + "/"))
        result.push(node);
    }
    return result;
  };

  const requireNode = (path) => {
    const node = nodes.get(lower(path));
    if (!node) fail(409, "path/not_found/.");
    return node;
  };

  const handleRpc = async (url, init) => {
    const route = url.split("/2/")[1],
      body = init.body ? JSON.parse(init.body) : null;
    if (route === "users/get_space_usage")
      return reply({
        used: 1024,
        allocation: { ".tag": "individual", allocated: 4 * 1024 * 1024 * 1024 },
      });
    if (route === "users/get_current_account")
      return reply({
        account_id: "acc-1",
        email: "user@example.test",
        name: { display_name: "测试账号" },
      });
    if (route === "files/download") {
      const arg = JSON.parse(init.headers["Dropbox-API-Arg"]),
        node = requireNode(arg.path);
      if (node.isFolder) fail(409, "path/not_found/.");
      return { status: 200, headers: {}, bytes: node.content };
    }
    if (route === "files/get_metadata")
      return reply(metadata(requireNode(body.path)));
    if (route === "files/list_folder") {
      requireNode(body.path);
      return reply({
        entries: children(body.path, body.recursive).map(metadata),
        cursor: "cursor-1",
        has_more: false,
      });
    }
    if (route === "files/create_folder_v2") {
      const key = lower(body.path);
      if (nodes.has(key)) fail(409, "path/conflict/folder/.");
      return reply({ metadata: metadata(createFolder(body.path)) });
    }
    if (route === "files/delete_v2") {
      const key = lower(body.path);
      requireNode(body.path);
      for (const node of [...nodes.keys()])
        if (node === key || node.startsWith(key + "/")) nodes.delete(node);
      return reply({ metadata: { ".tag": "file" } });
    }
    fail(400, "unknown/route");
  };

  const readSource = async (source) => {
    const chunks = [];
    for await (const chunk of source) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  };

  const handleUpload = async (url, init) => {
    const route = url.split("/2/")[1],
      arg = JSON.parse(init.headers["Dropbox-API-Arg"]),
      body = await readSource(init.source);
    if (route === "files/upload") {
      stats.uploads += 1;
      return reply(metadata(putFile(arg.path, body, arg.mode)));
    }
    if (route === "files/upload_session/start") {
      stats.sessionStarts += 1;
      const sessionId = `session-${(counter += 1)}`;
      sessions.set(sessionId, { path: arg.path, chunks: [body] });
      return reply({ session_id: sessionId });
    }
    if (route === "files/upload_session/append_v2") {
      const session = sessions.get(arg.cursor.session_id);
      if (!session) fail(409, "not_found/.");
      const offset = session.chunks.reduce((n, c) => n + c.length, 0);
      if (offset !== arg.cursor.offset) fail(409, "cursor/offset_incorrect");
      session.chunks.push(body);
      return { status: 200, headers: {}, bytes: Buffer.alloc(0) };
    }
    if (route === "files/upload_session/finish") {
      const session = sessions.get(arg.cursor.session_id);
      if (!session) fail(409, "not_found/.");
      const offset = session.chunks.reduce((n, c) => n + c.length, 0);
      if (offset !== arg.cursor.offset) fail(409, "cursor/offset_incorrect");
      session.chunks.push(body);
      sessions.delete(arg.cursor.session_id);
      return reply(
        metadata(
          putFile(
            arg.commit.path,
            Buffer.concat(session.chunks),
            arg.commit.mode,
          ),
        ),
      );
    }
    fail(400, "unknown/route");
  };

  const handleDownload = async (url, init, options, filePath) => {
    const route = url.split("/2/")[1];
    if (route !== "files/download") fail(400, "unknown/route");
    const arg = JSON.parse(init.headers["Dropbox-API-Arg"]),
      node = requireNode(arg.path);
    if (node.isFolder) fail(409, "path/not_found/.");
    writeFileSync(filePath, node.content, { mode: 0o600 });
    return {
      filePath,
      bytes: node.content.length,
      sha256: options?.hash ? sha256(node.content) : undefined,
    };
  };

  const reply = (payload) => ({
    status: 200,
    headers: {},
    bytes: Buffer.from(JSON.stringify(payload)),
  });

  return { handleRpc, handleUpload, handleDownload, stats, nodes };
}

/** Build a test double of the core runtime context; implements only the facades the Provider uses. */
function createContext(server, notebookId, deviceLabel = "测试设备") {
  const state = new Map();
  const accounts = {
    current: () => ({
      providerId: "dropbox",
      oauthClientId: "app-key",
      accountId: "acc-1",
    }),
    tokenProvider: () => ({
      getAccessToken: async () => ({
        token: "access-token",
        expiryDate: Date.now() + 3_600_000,
      }),
    }),
    request: (url, init) => server.handleRpc(url, init ?? {}),
    upload: (url, init) => server.handleUpload(url, init),
    downloadToFile: (url, init, options) => {
      const dir = mkdtempSync(join(tempRoot, "dl-")),
        dest = options?.dest;
      assert.ok(!dest || !dest.includes(".."), "下载目标禁止路径逃逸");
      const filePath = dest ? join(dir, dest) : join(dir, "download.bin");
      mkdirSync(join(filePath, ".."), { recursive: true });
      return server.handleDownload(url, init ?? {}, options, filePath);
    },
  };
  return {
    accounts,
    http: accounts.request,
    tasks: {
      signal: new AbortController().signal,
      progress() {},
      log() {},
      concurrency: () => 2,
    },
    state: {
      get: async (key) => (state.has(key) ? state.get(key) : null),
      set: async (key, value) => {
        state.set(key, value);
      },
      delete: async (key) => {
        state.delete(key);
      },
    },
    verifier: {
      sha256: (bytes) => sha256(bytes),
      createHasher: () => {
        const hash = createHash("sha256");
        return {
          update: (chunk) => hash.update(chunk),
          digest: () => hash.digest("hex"),
        };
      },
    },
    notebookId,
    deviceLabel,
  };
}

test("Dropbox 内容哈希按 4MiB 分块，且不等于整文件 SHA-256", async () => {
  // An empty file has no blocks, equal to the SHA-256 of an empty string (per Dropbox docs).
  const empty = Buffer.alloc(0);
  assert.equal(
    await dropboxContentHash(sourceOf(empty), 0),
    createHash("sha256").digest("hex"),
  );
  // ≤4MiB is a single block: hash the block, then hash the digest (double hashing).
  const small = Buffer.from("anynote");
  assert.equal(
    await dropboxContentHash(sourceOf(small), small.length),
    referenceDropboxHash(small),
  );
  const multi = Buffer.alloc(contentHashBlockBytes + 1234, 7);
  assert.equal(
    await dropboxContentHash(sourceOf(multi), multi.length),
    referenceDropboxHash(multi),
  );
  // content_hash is not a whole-file SHA-256, avoiding mixing up rev/hash (design §11.2).
  assert.notEqual(referenceDropboxHash(multi), sha256(multi));
  assert.notEqual(referenceDropboxHash(small), sha256(small));
});

test("capabilities 把条件写标记为实测结论而非默认值", () => {
  // Rev conflicts are handled in publish via conditional update on the just-read rev, but this is unverified, so conditional write is not declared.
  assert.equal(dropboxCapabilities.conditionalHead, false);
  assert.deepEqual(dropboxCapabilities.providerChecksum, [
    "dropbox-content-hash",
  ]);
  assert.equal(dropboxCapabilities.appScopedStorage, true);
  assert.equal(dropboxCapabilities.resumableUpload, true);
  // Real API is wired in, so it is no longer marked Beta, consistent with Google Drive / OneDrive (real-account acceptance tracked in TODO).
  assert.equal(cloudBackupExtension.beta, false);
  assert.notEqual(
    cloudBackupExtension.manifest.contributes.backupProviders[0].beta,
    true,
  );
});

test("App Folder 根目录身份标记校验并拒绝陌生目录", async () => {
  const notebookId = randomUUID(),
    server = createDropboxStub(),
    ctx = createContext(server, notebookId);
  const target = await dropboxProvider.ensureTarget(
    { notebookId, notebookName: "N", deviceSlotId: randomUUID() },
    ctx,
  );
  assert.equal(target.rootRef, "/AnynoteBackup");
  assert.match(target.notebookRef, /^\/AnynoteBackup\/notebooks\//);
  assert.match(target.deviceSlotRef, /\/devices\//);
  const client = createDropboxClient(ctx);
  const marker = await client.getMetadata("/AnynoteBackup/root.json");
  assert.ok(marker, "应写入根目录身份标记");

  // A foreign directory (a marker not written by this app) must refuse writes of managed objects.
  const foreign = createDropboxStub();
  const foreignCtx = createContext(foreign, notebookId);
  foreign.nodes.set("/anynotebackup/root.json", {
    id: "foreign",
    name: "root.json",
    pathLower: "/anynotebackup/root.json",
    pathDisplay: "/AnynoteBackup/root.json",
    isFolder: false,
    content: Buffer.from(
      JSON.stringify({
        format: "anynote.cloud-backup-root",
        formatVersion: 1,
        app: "other-app",
        createdAt: new Date().toISOString(),
      }),
    ),
    size: 1,
    rev: "rev-x",
    contentHash: sha256(Buffer.from("x")),
  });
  await assert.rejects(
    dropboxProvider.ensureTarget(
      { notebookId, notebookName: "N", deviceSlotId: randomUUID() },
      foreignCtx,
    ),
  );
});

test("文件级流程：首次上传、无变化跳过、新增附件只传新对象", async () => {
  const notebookId = randomUUID(),
    deviceSlotId = randomUUID(),
    server = createDropboxStub(),
    ctx = createContext(server, notebookId),
    target = await dropboxProvider.ensureTarget(
      { notebookId, notebookName: "N", deviceSlotId },
      ctx,
    ),
    database = Buffer.from("sqlite-bytes"),
    assetA = Buffer.from("asset-a-content");

  const captureA = captureOf({
    notebookId,
    database,
    assets: [{ content: assetA }],
  });
  const first = await runFileLevelBackup({
    provider: dropboxProvider,
    ctx,
    target,
    capture: captureA,
    deviceSlotId,
  });
  assert.equal(first.unchanged, false);
  assert.equal(first.uploadedBytes, database.length + assetA.length);
  assert.equal(first.manifest.database.verification, "provider-checksum");
  assert.equal(first.manifest.assets[0].verification, "provider-checksum");
  assert.equal(first.manifest.assets[0].sha256, sha256(assetA));
  assert.equal(first.head.deviceSlotId, deviceSlotId);

  // Unchanged: only confirm the pointer and object state, without re-uploading the database/assets.
  const second = await runFileLevelBackup({
    provider: dropboxProvider,
    ctx,
    target,
    capture: captureA,
    deviceSlotId,
    previous: first.manifest,
    previousHead: first.head,
  });
  assert.equal(second.unchanged, true);
  assert.equal(second.uploadedBytes, 0);

  // New asset: reuse the database and old assets, uploading only the new object.
  const assetB = Buffer.from("asset-b-content"),
    captureB = captureOf({
      notebookId,
      database,
      assets: [{ content: assetA }, { content: assetB }],
    });
  const third = await runFileLevelBackup({
    provider: dropboxProvider,
    ctx,
    target,
    capture: captureB,
    deviceSlotId,
    previous: first.manifest,
    previousHead: first.head,
  });
  assert.equal(third.unchanged, false);
  assert.equal(third.uploadedBytes, assetB.length);
  assert.equal(third.manifest.assets.length, 2);

  // Restore: list device slots and read the database and assets back from the current copy.
  const page = await dropboxProvider.listCurrentBackups(ctx);
  assert.deepEqual(
    page.slots.map((slot) => slot.deviceSlotId),
    [deviceSlotId],
  );
  const bundle = await dropboxProvider.download({ deviceSlotId }, ctx);
  assert.equal(bundle.databaseSha256, sha256(database));
  assert.equal(bundle.assets.length, 2);
  assert.equal(bundle.verification, "download-sha256");
});

test("大文件走 upload session，并按 offset 拼接后校验内容", async () => {
  const notebookId = randomUUID(),
    deviceSlotId = randomUUID(),
    server = createDropboxStub(),
    ctx = createContext(server, notebookId);
  await dropboxProvider.ensureTarget(
    { notebookId, notebookName: "N", deviceSlotId },
    ctx,
  );
  const client = createDropboxClient(ctx),
    large = Buffer.alloc(sessionThresholdBytes + 1024, 3),
    entry = await client.upload({
      path: "/AnynoteBackup/databases/large.sqlite",
      mode: { tag: "add" },
      source: sourceOf(large),
      size: large.length,
    });
  assert.equal(server.stats.sessionStarts, 1);
  assert.equal(entry.contentHash, referenceDropboxHash(large));
  const readBack = await client.downloadBytes(
    entry.pathLower,
    large.length + 1,
  );
  assert.equal(Buffer.compare(Buffer.from(readBack), large), 0);
});

test("rev 冲突处理：add 禁止覆盖，update 需匹配 rev 且不产生副本", async () => {
  const notebookId = randomUUID(),
    server = createDropboxStub(),
    ctx = createContext(server, notebookId),
    client = createDropboxClient(ctx);
  await client.ensureFolder("/AnynoteBackup");
  const path = "/AnynoteBackup/notebooks/n/devices/d/current.json",
    first = await client.uploadJson({
      path,
      mode: { tag: "add" },
      bytes: Buffer.from("first"),
    });
  await assert.rejects(
    client.uploadJson({ path, mode: { tag: "add" }, bytes: Buffer.from("x") }),
    (error) =>
      isDropboxConflict(dropboxErrorCode(error)) || error.status === 409,
  );
  await assert.rejects(
    client.uploadJson({
      path,
      mode: { tag: "update", rev: "stale-rev" },
      bytes: Buffer.from("x"),
    }),
    (error) => error.status === 409,
  );
  const updated = await client.uploadJson({
    path,
    mode: { tag: "update", rev: first.rev },
    bytes: Buffer.from("second"),
  });
  assert.notEqual(updated.rev, first.rev);
  // A conflict does not produce a renamed copy: still only one file in the directory.
  const files = (
    await client.listFolder("/AnynoteBackup", { recursive: true })
  ).filter((entry) => !entry.isFolder);
  assert.equal(files.length, 1);
});

test("上传后 content_hash 不一致时拒绝提交", async () => {
  const notebookId = randomUUID(),
    server = createDropboxStub({ corruptContentHash: true }),
    ctx = createContext(server, notebookId),
    client = createDropboxClient(ctx);
  await client.ensureFolder("/AnynoteBackup");
  await assert.rejects(
    client.upload({
      path: "/AnynoteBackup/a.bin",
      mode: { tag: "add" },
      source: sourceOf(Buffer.from("payload")),
      size: 7,
    }),
    /内容校验失败/,
  );
});

test("路径不存在与时序保护：缺失元数据返回 null，清理与删除幂等", async () => {
  const notebookId = randomUUID(),
    deviceSlotId = randomUUID(),
    server = createDropboxStub(),
    ctx = createContext(server, notebookId),
    client = createDropboxClient(ctx);
  assert.equal(await client.getMetadata("/AnynoteBackup/missing.json"), null);
  assert.deepEqual(await client.listFolder("/AnynoteBackup/missing"), []);
  // Deleting a non-existent object is treated as an idempotent success.
  await client.remove("/AnynoteBackup/missing.json");

  const target = await dropboxProvider.ensureTarget(
    { notebookId, notebookName: "N", deviceSlotId },
    ctx,
  );
  const capture = captureOf({
    notebookId,
    database: Buffer.from("db"),
    assets: [{ content: Buffer.from("a") }],
  });
  const result = await runFileLevelBackup({
    provider: dropboxProvider,
    ctx,
    target,
    capture,
    deviceSlotId,
  });
  // Managed cleanup deletes only planned objects; the database/assets referenced by the current pointer must be kept.
  const cleanup = await dropboxProvider.cleanup({ objects: [] }, ctx);
  assert.deepEqual(cleanup, { deleted: 0, failed: 0 });
  const remaining = await client.listFolder(target.deviceSlotRef, {
    recursive: true,
  });
  assert.ok(remaining.some((entry) => entry.name.endsWith(".sqlite")));
  assert.ok(result.manifest.database.locator.ref.includes("/databases/"));

  const deleted = await dropboxProvider.deleteSlot({ deviceSlotId }, ctx);
  assert.ok(deleted.deleted >= 2);
  assert.deepEqual(
    await client.listFolder(target.deviceSlotRef, { recursive: true }),
    [],
  );
});
