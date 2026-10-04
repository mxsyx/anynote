import { unzipSync, zipSync } from "fflate";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "@anynote/storage-sqlite/index.js";
import type { BackupTarget, LogicalManifest } from "@anynote/types/runtime.js";
import { DatabaseSync } from "@anynote/types/runtime.js";
import { digest } from "./providers.js";
const tables = [
  "notebook_meta",
  "nodes",
  "notes",
  "assets",
  "resources",
  "note_revisions",
  "revision_resources",
  "annotations",
  "extension_data",
  "changes",
  "import_reports",
];
export function logicalBundle(bundle: Buffer) {
  const files = unzipSync(bundle),
    archive = JSON.parse(Buffer.from(files["manifest.json"]).toString()),
    root = mkdtempSync(join(tmpdir(), "anynote-logical-")),
    path = join(root, "notebook.sqlite");
  writeFileSync(path, files["notebook.sqlite"]);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const entities = [],
      objects = new Map();
    for (const table of tables) {
      const pks = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .filter((c) => c.pk)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
      for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
        const bytes = Buffer.from(JSON.stringify(row)),
          hash = digest(bytes),
          key = table + ":" + pks.map((k) => row[k]).join(":");
        entities.push({ table, key, hash, size: bytes.length });
        objects.set(hash, bytes);
      }
    }
    for (const a of archive.assets)
      objects.set(a.sha256, Buffer.from(files[a.path]));
    return {
      manifest: {
        format: "anynote.logical",
        protocolVersion: 1,
        schemaVersion: 2,
        notebookId: archive.notebookId,
        snapshotSeq: archive.snapshotSeq,
        entities,
        assets: archive.assets,
        createdAt: archive.createdAt,
      } as LogicalManifest,
      objects,
    };
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}
export async function uploadLogical(
  client: import("./providers.js").CloudflareClient,
  bundle: Buffer,
  target: BackupTarget,
  {
    generationId,
    progress,
    signal,
  }: {
    generationId: string;
    progress: (message: string) => void;
    signal: AbortSignal;
  },
) {
  const { manifest, objects } = logicalBundle(bundle);
  const remote = target.remoteNotebookId || target.notebookId;
  if (remote !== manifest.notebookId) {
    const sourceId = manifest.notebookId;
    for (const entity of manifest.entities) {
      if (entity.table !== "notebook_meta" && entity.table !== "note_revisions")
        continue;
      const row = JSON.parse(objects.get(entity.hash));
      if (entity.table === "notebook_meta") {
        row.id = remote;
        entity.key = "notebook_meta:" + remote;
      } else
        row.body = row.body.replaceAll(
          "anynote://notebook/" + sourceId + "/",
          "anynote://notebook/" + remote + "/",
        );
      const bytes = Buffer.from(JSON.stringify(row));
      entity.hash = digest(bytes);
      entity.size = bytes.length;
      objects.set(entity.hash, bytes);
    }
    manifest.notebookId = remote;
  }
  Object.assign(manifest, {
    generationId,
    lineageId: target.lineageId,
    deviceId: target.deviceId,
    expectedHead: target.lastGeneration || "",
    writerEpoch: target.writerEpoch || 1,
  });
  const path = `/v1/notebooks/${target.remoteNotebookId || target.notebookId}/backup`,
    plan = await client.call(path + "/plan", {
      method: "POST",
      body: manifest,
    });
  for (const hash of plan.missing) {
    signal.throwIfAborted();
    const bytes = objects.get(hash);
    if (!bytes) throw Error("缺少计划中的本地对象");
    progress("正在上传逻辑对象 " + hash.slice(0, 10));
    await client.uploadObject(path + `/${generationId}/objects/${hash}`, bytes);
  }
  signal.throwIfAborted();
  progress("正在提交远端版本");
  const committed = await client.call(path + `/${generationId}/commit`, {
    method: "POST",
    body: {
      expectedHead: manifest.expectedHead,
      writerEpoch: target.writerEpoch || 1,
    },
  });
  return {
    generationId: committed.generationId,
    snapshotSeq: manifest.snapshotSeq,
  };
}
export async function listLogical(
  client: import("./providers.js").CloudflareClient,
  target: BackupTarget,
) {
  return (
    await client.call(
      `/v1/notebooks/${target.remoteNotebookId || target.notebookId}/backups?lineageId=${target.lineageId}`,
    )
  ).items;
}
export async function restoreLogical(
  client: import("./providers.js").CloudflareClient,
  target: BackupTarget,
  generationId: string,
) {
  const pinId = randomUUID(),
    pinPath = `/v1/notebooks/${target.remoteNotebookId || target.notebookId}/backups/${generationId}/pin`;
  const capabilities = await client.call("/v1/capabilities");
  const pinned = capabilities.capabilities?.includes("restore-pin");
  if (pinned) await client.call(pinPath, { method: "POST", body: { pinId } });
  let renewalError;
  const timer = pinned
    ? setInterval(() => {
        void client
          .call(pinPath, { method: "POST", body: { pinId } })
          .catch((e) => {
            renewalError = e;
          });
      }, 30000)
    : null;
  try {
    const manifest = await client.call(
      `/v1/notebooks/${target.remoteNotebookId || target.notebookId}/backups/${generationId}/manifest`,
    );
    if (
      manifest.notebookId !== (target.remoteNotebookId || target.notebookId) ||
      manifest.lineageId !== target.lineageId ||
      manifest.schemaVersion !== 2 ||
      manifest.format !== "anynote.logical"
    )
      throw Error("逻辑版本不兼容或身份不匹配");
    const root = mkdtempSync(join(tmpdir(), "anynote-restore-")),
      path = join(root, "notebook.sqlite"),
      db = new DatabaseSync(path),
      files: Record<string, Uint8Array> = {},
      cache = new Map();
    let total = 0;
    try {
      db.exec(schema);
      db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;");
      for (const entity of manifest.entities) {
        if (renewalError) throw renewalError;
        if (
          !tables.includes(entity.table) ||
          !/^[a-f0-9]{64}$/.test(entity.hash)
        )
          throw Error("无效逻辑实体");
        const bytes =
          cache.get(entity.hash) ||
          (await client.downloadObject(
            `/v1/notebooks/${target.remoteNotebookId || target.notebookId}/objects/${entity.hash}`,
          ));
        total += bytes.length;
        if (
          total > 100 * 1024 * 1024 ||
          digest(bytes) !== entity.hash ||
          bytes.length !== entity.size
        )
          throw Error("逻辑对象校验失败");
        cache.set(entity.hash, bytes);
        const row = JSON.parse(bytes),
          columns = db
            .prepare(`PRAGMA table_info(${entity.table})`)
            .all()
            .map((c) => c.name);
        if (Object.keys(row).some((k) => !columns.includes(k)))
          throw Error("未知实体字段");
        const names = Object.keys(row);
        db.prepare(
          `INSERT INTO ${entity.table}(${names.map((n) => '"' + n + '"').join(",")}) VALUES(${names.map(() => "?").join(",")})`,
        ).run(...names.map((n) => row[n]));
      }
      db.exec("COMMIT;");
      db.close();
      const database = readFileSync(path);
      files["notebook.sqlite"] = database;
      for (const a of manifest.assets) {
        if (renewalError) throw renewalError;
        if (!/^assets\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.bin$/.test(a.path))
          throw Error("资源路径无效");
        const bytes = await client.downloadObject(
          `/v1/notebooks/${target.remoteNotebookId || target.notebookId}/objects/${a.sha256}`,
        );
        total += bytes.length;
        if (
          total > 100 * 1024 * 1024 ||
          digest(bytes) !== a.sha256 ||
          bytes.length !== a.size
        )
          throw Error("资源校验失败");
        files[a.path] = bytes;
      }
      files["manifest.json"] = Buffer.from(
        JSON.stringify({
          format: "anynote.notebook",
          formatVersion: 1,
          schemaVersion: 2,
          notebookId: manifest.notebookId,
          generationId,
          createdAt: manifest.createdAt,
          snapshotSeq: manifest.snapshotSeq,
          database: {
            path: "notebook.sqlite",
            size: database.length,
            sha256: digest(database),
          },
          assets: manifest.assets,
          includesHistory: true,
          includesTrash: true,
        }),
      );
      return Buffer.from(zipSync(files));
    } finally {
      try {
        db.close();
      } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    if (timer) clearInterval(timer);
    if (pinned)
      await client
        .call(pinPath, { method: "DELETE", body: { pinId } })
        .catch(() => {});
  }
}
