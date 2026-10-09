import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Storage } from "@anynote/storage-sqlite/index.js";
import type {
  CloudBackupAccount,
  CloudBackupTarget,
} from "@anynote/types/cloud-backup.js";

/**
 * 云盘备份的设备侧状态文件（设计 §14.1）。
 *
 * 账号引用、目标配置、Provider 会话/游标都保存在应用数据目录的 `_local/`，
 * 不写进 Notebook SQLite，避免改变知识数据而触发新的备份。凭据本身只进入
 * 系统安全存储，这里仅保存引用。
 */

/** `_local/` 下的状态文件路径。 */
function localFile(s: Storage, name: string) {
  const dir = join(s.root, "_local");
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

/** 原子写入 JSON：先写临时文件再 rename，避免半截文件被读回。 */
function atomicJson(file: string, value: unknown) {
  writeFileSync(file + ".tmp", JSON.stringify(value), { flush: true });
  renameSync(file + ".tmp", file);
}

/** 读取 JSON 状态；文件不存在或损坏时回退到默认值。 */
function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** 全部已连接的云盘账号。 */
export const readAccounts = (s: Storage): CloudBackupAccount[] =>
  readJson<CloudBackupAccount[]>(
    localFile(s, "cloud-backup-accounts.json"),
    [],
  );

/** 覆盖写入账号列表。 */
export const writeAccounts = (s: Storage, items: CloudBackupAccount[]) =>
  atomicJson(localFile(s, "cloud-backup-accounts.json"), items);

/** 按账号引用 ID 查找账号。 */
export function findAccount(
  s: Storage,
  accountRefId: string,
): CloudBackupAccount | undefined {
  return readAccounts(s).find((account) => account.id === accountRefId);
}

/** 新增或更新账号。 */
export function upsertAccount(s: Storage, account: CloudBackupAccount) {
  const items = readAccounts(s).filter((item) => item.id !== account.id);
  writeAccounts(s, [...items, account]);
}

/** 全部云盘备份目标。 */
export const readTargets = (s: Storage): CloudBackupTarget[] =>
  readJson<CloudBackupTarget[]>(localFile(s, "cloud-backup-targets.json"), []);

/** 覆盖写入目标列表。 */
export const writeTargets = (s: Storage, items: CloudBackupTarget[]) =>
  atomicJson(localFile(s, "cloud-backup-targets.json"), items);

/** 按 Notebook 与目标 ID 查找目标。 */
export function findTarget(
  s: Storage,
  notebookId: string,
  targetId: string,
): CloudBackupTarget {
  const target = readTargets(s).find(
    (item) => item.id === targetId && item.notebookId === notebookId,
  );
  if (!target) throw Error("云盘备份目标不存在");
  return target;
}

/** 新增或替换目标。 */
export function upsertTarget(s: Storage, target: CloudBackupTarget) {
  const items = readTargets(s).filter((item) => item.id !== target.id);
  writeTargets(s, [...items, target]);
}

/**
 * 以原子方式修改一个目标，返回修改后的目标。
 *
 * @param s Storage。
 * @param targetId 目标 ID。
 * @param patch 目标字段更新或更新函数。
 * @returns 更新后的目标。
 */
export function patchTarget(
  s: Storage,
  targetId: string,
  patch:
    | Partial<CloudBackupTarget>
    | ((target: CloudBackupTarget) => Partial<CloudBackupTarget>),
): CloudBackupTarget {
  const items = readTargets(s),
    index = items.findIndex((item) => item.id === targetId);
  if (index < 0) throw Error("云盘备份目标不存在");
  const next = {
    ...items[index],
    ...(typeof patch === "function" ? patch(items[index]) : patch),
  };
  items[index] = next;
  writeTargets(s, items);
  return next;
}

/**
 * 按 Provider 命名空间保存扩展本机状态。
 *
 * 键命名遵循 `a.b.c` 约定；值必须是可 JSON 序列化的最小数据，敏感会话 URL
 * 或 token 不得写入这里。
 *
 * @param s Storage。
 * @param providerId 厂商标识。
 * @param key 状态键。
 * @param value 状态值；`undefined` 表示保留原值。
 * @returns 当前值。
 */
export function providerState(
  s: Storage,
  providerId: string,
  key: string,
  value?: unknown,
) {
  const file = localFile(s, "cloud-backup-provider-state.json"),
    store = readJson<Record<string, unknown>>(file, {}),
    fullKey = `${providerId}\u0000${key}`;
  if (value === undefined) return store[fullKey] ?? null;
  store[fullKey] = value;
  atomicJson(file, store);
  return value;
}

/** 删除一个 Provider 状态键。 */
export function deleteProviderState(
  s: Storage,
  providerId: string,
  key: string,
): void {
  const file = localFile(s, "cloud-backup-provider-state.json"),
    store = readJson<Record<string, unknown>>(file, {}),
    fullKey = `${providerId}\u0000${key}`;
  if (!(fullKey in store)) return;
  delete store[fullKey];
  atomicJson(file, store);
}
