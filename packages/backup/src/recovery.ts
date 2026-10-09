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
import { CloudflareClient } from "./providers.js";
import { startCloudRestore } from "./restore-task.js";

const uuid = z.string().uuid(),
  connectionSchema = configSchema.omit({ notebookId: true, targetId: true });

/** Saved cloud recovery connection (without credentials, which are stored encrypted separately). */
type Connection = Omit<z.infer<typeof connectionSchema>, "token"> & {
  id: string;
};

/** Operation names related to cloud recovery on a brand-new device. */
export const recoveryOperations = [
  "configureCloudRecovery",
  "listCloudRecoveryConnections",
  "discoverCloudBackups",
  "restoreCloudBackup",
];

/**
 * Managed path of the recovery connections config file.
 *
 * @param s Storage service.
 * @returns Config file path.
 */
function file(s: Storage) {
  return assertLocalPath(s.root, "_local/recovery-connections.json");
}

/**
 * Read saved cloud recovery connections.
 *
 * @param s Storage service.
 * @returns Saved connections.
 */
function read(s: Storage): Connection[] {
  const path = file(s);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
}

/**
 * Handle cloud recovery on a brand-new device: save a standalone connection, discover cloud versions with pagination, and restore.
 *
 * Connection info is decoupled from the Notebook/target config and credentials
 * are encrypted by the host; versions are discovered through the Cloudflare
 * server discovery endpoint.
 *
 * @param s Storage service.
 * @param op Operation name.
 * @param raw Raw operation payload.
 * @param secret Credential read/write helper.
 * @returns Handled flag with the operation result.
 */
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
    if (!p.token) throw Error("请填写应用 Token");
    const entries = read(s);
    if (entries.length >= 20) throw Error("最多保存20个云恢复连接");
    const { token, ...config } = p,
      id = randomUUID();
    await secret(s, id, { token });
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
    provider = new CloudflareClient(connection, credentials);

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
