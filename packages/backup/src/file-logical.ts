import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cloudObjectLimit,
  logicalTables,
  objectDescriptors,
} from "@anynote/protocol/cloud-objects.js";
import { hashFile } from "@anynote/storage-sqlite/archive-stream.js";
import { schema } from "@anynote/storage-sqlite/index.js";
import type {
  BackupTarget,
  Entity,
  LogicalManifest,
  SqlRow,
} from "@anynote/types/runtime.js";
import { DatabaseSync } from "@anynote/types/runtime.js";
import type { FileManifest, FileSnapshot } from "./file-snapshot.js";
import {
  prepareFiles,
  readSource,
  restoreFile,
  verifyDirectoryBudget,
} from "./file-snapshot.js";
import { CloudflareClient, digest } from "./providers.js";
const bytesLimit = 5 * 1024 ** 2;
export async function logicalSnapshotFiles(
  snapshot: FileSnapshot,
  target: BackupTarget,
  signal: AbortSignal,
  progress: (message: string) => void,
) {
  const objects = await prepareFiles(snapshot, signal, progress);
  const db = new DatabaseSync(join(snapshot.dir, "notebook.sqlite"), {
    readOnly: true,
  });
  const remote = target.remoteNotebookId || target.notebookId;
  const dir = join(snapshot.dir, "objects");
  await mkdir(dir);
  const entities: Entity[] = [];
  try {
    for (const table of logicalTables) {
      const pks = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .filter((c) => c.pk)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name as string);
      for (const raw of db.prepare(`SELECT * FROM ${table}`).iterate()) {
        signal.throwIfAborted();
        const row = raw as SqlRow;
        if (remote !== snapshot.manifest.notebookId) {
          if (table === "notebook_meta") row.id = remote;
          if (table === "note_revisions")
            row.body = row.body.replaceAll(
              `anynote://notebook/${snapshot.manifest.notebookId}/`,
              `anynote://notebook/${remote}/`,
            );
        }
        const bytes = Buffer.from(JSON.stringify(row)),
          hash = digest(bytes);
        if (bytes.length > cloudObjectLimit || entities.length >= 200000)
          throw Error("逻辑实体超过协议预算");
        const key = table + ":" + pks.map((k) => row[k]).join(":");
        if (key.length > 1000) throw Error("逻辑实体键超过协议预算");
        entities.push({ table, key, hash, size: bytes.length });
        const file = join(dir, hash);
        await writeFile(file, bytes);
        objects.set(hash, { file, offset: 0, size: bytes.length });
      }
    }
    const manifest: LogicalManifest = {
      format: "anynote.logical",
      protocolVersion: 1,
      schemaVersion: 2,
      notebookId: remote,
      notebookName: snapshot.manifest.notebookName,
      snapshotSeq: snapshot.manifest.snapshotSeq,
      createdAt: snapshot.manifest.createdAt,
      entities,
      assets: snapshot.manifest.assets,
    };
    objectDescriptors(manifest);
    return { manifest, objects };
  } finally {
    db.close();
  }
}
export async function uploadLogicalFiles(
  client: CloudflareClient,
  snapshot: FileSnapshot,
  target: BackupTarget,
  generationId: string,
  signal: AbortSignal,
  progress: (message: string) => void,
  onBytes: (bytes: number) => void,
) {
  const capabilities = await client.call("/v1/capabilities", { signal });
  if (
    snapshot.manifest.assets.some((a) => a.size > 16 * 1024 ** 2) &&
    !capabilities.capabilities?.includes("chunked-assets-v1")
  )
    throw Error("服务端需升级以支持分块附件");
  const { manifest, objects } = await logicalSnapshotFiles(
    snapshot,
    target,
    signal,
    progress,
  );
  Object.assign(manifest, {
    generationId,
    lineageId: target.lineageId,
    deviceId: target.deviceId,
    expectedHead: target.lastGeneration || "",
    writerEpoch: target.writerEpoch || 1,
  });
  if (Buffer.byteLength(JSON.stringify(manifest)) > bytesLimit)
    throw Error("逻辑清单超过5MiB预算");
  const path = `/v1/notebooks/${manifest.notebookId}/backup`;
  const plan = await client.call(path + "/plan", {
    method: "POST",
    body: manifest,
    signal,
  });
  for (const hash of plan.missing) {
    signal.throwIfAborted();
    const source = objects.get(hash);
    if (!source) throw Error("计划要求不存在的本地对象");
    const bytes = await readSource(source, signal);
    if (digest(bytes) !== hash) throw Error("备份源文件在上传前改变");
    progress("正在上传逻辑分块 " + hash.slice(0, 10));
    await client.uploadObject(
      path + `/${generationId}/objects/${hash}`,
      bytes,
      signal,
    );
    onBytes(bytes.length);
  }
  signal.throwIfAborted();
  progress("正在提交远端版本");
  const committed = await client.call(path + `/${generationId}/commit`, {
    method: "POST",
    body: {
      expectedHead: manifest.expectedHead,
      writerEpoch: manifest.writerEpoch,
    },
  });
  return {
    generationId: committed.generationId,
    snapshotSeq: manifest.snapshotSeq,
  };
}
export async function restoreLogicalFiles(
  client: CloudflareClient,
  target: BackupTarget,
  generationId: string,
  dir: string,
  signal: AbortSignal,
  onBytes: (bytes: number) => void,
  onTotal: (bytes: number) => void = () => {},
): Promise<FileManifest> {
  const book = target.remoteNotebookId || target.notebookId;
  const pinId = randomUUID(),
    pinPath = `/v1/notebooks/${book}/backups/${generationId}/pin`;
  const capabilities = await client.call("/v1/capabilities", { signal });
  const pinned = capabilities.capabilities?.includes("restore-pin");
  if (pinned)
    await client.call(pinPath, { method: "POST", body: { pinId }, signal });
  let renewalError: unknown;
  const timer = pinned
    ? setInterval(() => {
        void client
          .call(pinPath, { method: "POST", body: { pinId }, signal })
          .catch((e) => {
            renewalError = e;
          });
      }, 30000)
    : null;
  const check = () => {
    signal.throwIfAborted();
    if (renewalError) throw renewalError;
  };
  try {
    const manifest: LogicalManifest = await client.call(
      `/v1/notebooks/${book}/backups/${generationId}/manifest`,
      { signal },
    );
    if (
      manifest.notebookId !== book ||
      manifest.lineageId !== target.lineageId ||
      manifest.generationId !== generationId ||
      manifest.schemaVersion !== 2 ||
      manifest.protocolVersion !== 1 ||
      manifest.format !== "anynote.logical" ||
      !Array.isArray(manifest.entities) ||
      manifest.entities.length > 200000 ||
      !Array.isArray(manifest.assets) ||
      manifest.assets.length > 10000
    )
      throw Error("逻辑版本不兼容或身份不匹配");
    objectDescriptors(manifest);
    const entityBytes = manifest.entities.reduce((n, e) => n + e.size, 0);
    await verifyDirectoryBudget(
      dir,
      entityBytes * 3 + 1024 ** 2,
      manifest.assets,
    );
    onTotal(
      entityBytes + manifest.assets.reduce((total, a) => total + a.size, 0),
    );
    const file = join(dir, "notebook.sqlite"),
      db = new DatabaseSync(file);
    try {
      db.exec(schema);
      db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;");
      for (const e of manifest.entities) {
        check();
        if (!(logicalTables as readonly string[]).includes(e.table))
          throw Error("无效逻辑实体表");
        const bytes = await client.downloadObject(
          `/v1/notebooks/${book}/objects/${e.hash}`,
          { maxBytes: e.size, signal },
        );
        if (bytes.length !== e.size || digest(bytes) !== e.hash)
          throw Error("逻辑对象校验失败");
        const row = JSON.parse(bytes.toString());
        if (!row || typeof row !== "object" || Array.isArray(row))
          throw Error("逻辑实体不是字段对象");
        const columns = db.prepare(`PRAGMA table_info(${e.table})`).all();
        const names = Object.keys(row);
        if (
          !names.length ||
          names.some((k) => !columns.some((c) => c.name === k))
        )
          throw Error("未知实体字段");
        const key =
          e.table +
          ":" +
          columns
            .filter((c) => c.pk)
            .sort((a, b) => a.pk - b.pk)
            .map((c) => row[c.name])
            .join(":");
        if (key !== e.key) throw Error("逻辑实体键与数据不匹配");
        db.prepare(
          `INSERT INTO ${e.table}(${names.map((n) => '"' + n + '"').join(",")}) VALUES(${names.map(() => "?").join(",")})`,
        ).run(...names.map((n) => row[n]));
        onBytes(bytes.length);
      }
      db.exec("COMMIT;");
    } finally {
      db.close();
    }
    check();
    const database = {
      path: "notebook.sqlite",
      ...(await hashFile(file, signal)),
    };
    await verifyDirectoryBudget(dir, database.size, manifest.assets);
    for (const a of manifest.assets) {
      check();
      await restoreFile(
        dir,
        a,
        async (c) => {
          check();
          const bytes = await client.downloadObject(
            `/v1/notebooks/${book}/objects/${c.sha256}`,
            { maxBytes: c.size, signal },
          );
          check();
          return bytes;
        },
        signal,
        onBytes,
      );
    }
    check();
    return {
      format: "anynote.notebook",
      formatVersion: 1,
      schemaVersion: 2,
      appVersion: "0.1.0",
      notebookId: book,
      generationId,
      createdAt: manifest.createdAt,
      snapshotSeq: manifest.snapshotSeq,
      database,
      assets: manifest.assets,
      includesHistory: true,
      includesTrash: true,
    };
  } finally {
    if (timer) clearInterval(timer);
    if (pinned)
      await client
        .call(pinPath, { method: "DELETE", body: { pinId } })
        .catch(() => {});
  }
}
