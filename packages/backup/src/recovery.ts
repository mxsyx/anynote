import { readControl } from "./s3-control.js";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { Storage } from "@anynote/storage-sqlite/index.js";
import { assertLocalPath } from "@anynote/storage-sqlite/workspace.js";
import type { Credentials, BackupTarget } from "@anynote/types/runtime.js";
import { configSchema } from "./connection.js";
import { S3Objects, CloudflareClient, digest } from "./providers.js";
import { startCloudRestore } from "./restore-task.js";
const uuid = z.string().uuid(),
  connectionSchema = configSchema.omit({ notebookId: true, targetId: true });
type Connection = Omit<
  z.infer<typeof connectionSchema>,
  "token" | "accessKeyId" | "secretAccessKey" | "sessionToken"
> & { id: string };
export const recoveryOperations = [
  "configureCloudRecovery",
  "listCloudRecoveryConnections",
  "discoverCloudBackups",
  "restoreCloudBackup",
];
function file(s: Storage) {
  return assertLocalPath(s.root, "_local/recovery-connections.json");
}
function read(s: Storage): Connection[] {
  const path = file(s);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
}
export async function recoveryOperation(
  s: Storage,
  op: string,
  raw: unknown,
  secret: (s: Storage, id: string, value?: Credentials) => Promise<Credentials>,
) {
  if (!recoveryOperations.includes(op)) return { handled: false };
  if (op === "listCloudRecoveryConnections")
    return {
      handled: true,
      result: read(s).map((c) => ({
        ...c,
        credentialsMode: s.vault ? "system-encrypted" : "session-only",
      })),
    };
  if (op === "configureCloudRecovery") {
    const p = connectionSchema.parse(raw),
      url = new URL(p.endpoint);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["https:", "http:"].includes(url.protocol) ||
      (url.protocol === "http:" && !p.allowInsecure)
    )
      throw Error("默认要求 HTTPS；本机测试服务需明确允许 HTTP。");
    if (
      p.provider === "s3" &&
      (!p.bucket || !p.accessKeyId || !p.secretAccessKey)
    )
      throw Error("请填写 Bucket 与访问凭据");
    if (p.provider === "cloudflare" && !p.token)
      throw Error("请填写应用 Token");
    const entries = read(s);
    if (entries.length >= 20) throw Error("最多保存20个云恢复连接");
    const { token, accessKeyId, secretAccessKey, sessionToken, ...config } = p,
      id = randomUUID();
    await secret(s, id, { token, accessKeyId, secretAccessKey, sessionToken });
    const connection = { ...config, id },
      path = file(s);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path + ".tmp", JSON.stringify([...entries, connection]), {
      mode: 0o600,
      flush: true,
    });
    renameSync(path + ".tmp", path);
    return { handled: true, result: connection };
  }
  const p = z
      .object({
        connectionId: uuid,
        cursor: z.string().max(4096).optional(),
        notebookId: uuid.optional(),
        lineageId: uuid.optional(),
        generationId: uuid.optional(),
      })
      .strict()
      .parse(raw),
    connection = read(s).find((c) => c.id === p.connectionId);
  if (!connection) throw Error("云恢复连接不存在");
  const credentials = await secret(s, connection.id),
    provider =
      connection.provider === "s3"
        ? new S3Objects(connection, credentials)
        : new CloudflareClient(connection, credentials);
  if (op === "restoreCloudBackup") {
    if (!p.notebookId || !p.lineageId || !p.generationId)
      throw Error("请选择云端版本");
    const target: BackupTarget = {
      ...connection,
      notebookId: p.notebookId,
      lineageId: p.lineageId,
      deviceId: randomUUID(),
    };
    return {
      handled: true,
      result: startCloudRestore(s, target, provider, p.generationId),
    };
  }
  if (provider instanceof CloudflareClient) {
    const capability = await provider.call("/v1/capabilities");
    if (!capability.capabilities?.includes("backup-discovery-v1"))
      throw Error("服务端需升级以支持全新设备发现备份");
    return {
      handled: true,
      result: await provider.call(
        "/v1/backups" +
          (p.cursor ? "?cursor=" + encodeURIComponent(p.cursor) : ""),
      ),
    };
  }
  const cursor = p.cursor
    ? z
        .object({
          token: z.string().optional(),
          after: z.string().max(1000).optional(),
        })
        .strict()
        .parse(JSON.parse(p.cursor))
    : {};
  const page = await provider.listPage("", cursor.token),
    backups = [],
    warnings = [];
  let items = page.items;
  if (cursor.after) {
    const index = items.findIndex((i) => i.key === cursor.after);
    if (index < 0) throw Error("远端列举已改变，请重新查询");
    items = items.slice(index + 1);
  }
  let scanned = 0,
    last: string | undefined;
  for (const item of items) {
    const match = item.key.match(
      /^([a-f0-9-]{36})\/([a-f0-9-]{36})\/generations\/([a-f0-9-]{36})\/COMMITTED\.json$/i,
    );
    if (!match) continue;
    last = item.key;
    scanned++;
    try {
      const [, notebookId, lineageId, id] = match;
      uuid.parse(notebookId);
      uuid.parse(lineageId);
      uuid.parse(id);
      const control = (
        await readControl(provider, `${notebookId}/${lineageId}`)
      )?.value;
      if (
        control &&
        (control.retired.includes(id) || !control.committed.includes(id))
      )
        continue;
      const marker = JSON.parse(
          (await provider.get(item.key, { maxBytes: 65536 })).toString(),
        ),
        expected = `${notebookId}/${lineageId}/generations/${id}/manifest.json`;
      if (marker.manifestKey !== expected || marker.generationId !== id)
        throw Error("提交记录身份无效");
      const bytes = await provider.get(expected, { maxBytes: 16 * 1024 ** 2 });
      if (digest(bytes) !== marker.manifestHash)
        throw Error("清单哈希校验失败");
      const m = JSON.parse(bytes.toString());
      if (
        m.format !== "anynote.notebook" ||
        m.notebookId !== notebookId ||
        m.lineageId !== lineageId ||
        m.generationId !== id ||
        ![1, 2].includes(m.protocolVersion) ||
        !Array.isArray(m.assets)
      )
        throw Error("版本身份或协议无效");
      backups.push({
        notebookId,
        lineageId,
        id,
        name:
          typeof m.notebookName === "string"
            ? m.notebookName.slice(0, 240)
            : "Notebook " + notebookId.slice(0, 8),
        createdAt: m.createdAt,
        snapshotSeq: m.snapshotSeq,
        assets: m.assets.length,
      });
    } catch {
      warnings.push("一个已提交版本无法读取或校验，已跳过：" + match[3]);
    }
    if (scanned === 10) break;
  }
  const remaining =
    last && items.findIndex((i) => i.key === last) < items.length - 1;
  const next = remaining
    ? JSON.stringify({ token: cursor.token, after: last })
    : page.next
      ? JSON.stringify({ token: page.next })
      : null;
  return { handled: true, result: { backups, warnings, cursor: next } };
}
