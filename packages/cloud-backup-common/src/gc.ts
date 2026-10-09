import type {
  CleanupPlan,
  CloudBackupHead,
  CloudBackupManifest,
  CloudObjectLocator,
} from "@anynote/types/cloud-backup.js";

/** 一个由本应用登记的受管对象。 */
export interface ManagedObject {
  locator: CloudObjectLocator;
  kind: "database" | "asset" | "manifest" | "pending";
  sha256?: string;
  /** 登记时间；用于提交宽限期判断。 */
  registeredAt?: number;
}

export interface CleanupInput {
  /** 当前指针；为空表示无法确定受管范围，禁止清理。 */
  currentHead: CloudBackupHead | null;
  currentManifest: CloudBackupManifest | null;
  /** 本机登记的全部受管对象。 */
  managed: readonly ManagedObject[];
  /** 进行中任务与恢复 pin 保护的对象。 */
  protectedLocators?: readonly CloudObjectLocator[];
  /** 提交宽限期（毫秒）；默认 24 小时。 */
  graceMs?: number;
  now?: number;
}

const locatorKey = (locator: CloudObjectLocator) =>
  `${locator.kind}\u0000${locator.ref}`;

/**
 * 生成受管垃圾回收计划（设计 §9.3、§14.3）。
 *
 * 只清理当前槽内、由本应用登记的对象；`current` 未确认、分页/读取失败或计划
 * 不完整时一律不清理。进行中任务、恢复下载与仍在提交宽限期的对象继续保留。
 *
 * @param input 受管对象与保护集合。
 * @returns 待清理对象计划。
 */
export function planCleanup(input: CleanupInput): CleanupPlan {
  if (!input.currentHead) throw Error("当前指针未确认，禁止清理受管对象");
  const graceMs = input.graceMs ?? 24 * 60 * 60 * 1000,
    now = input.now ?? Date.now(),
    keep = new Set<string>();
  keep.add(`manifest\u0000${input.currentHead.manifestRef}`);
  if (input.currentManifest) {
    keep.add(locatorKey(input.currentManifest.database.locator));
    for (const asset of input.currentManifest.assets)
      keep.add(locatorKey(asset.locator));
  }
  for (const locator of input.protectedLocators ?? [])
    keep.add(locatorKey(locator));

  const objects: CloudObjectLocator[] = [];
  for (const object of input.managed) {
    if (object.kind === "pending") continue;
    if (keep.has(locatorKey(object.locator))) continue;
    // 仍在提交宽限期的对象继续保留，避免误删在途恢复所需的副本。
    if (object.registeredAt != null && now - object.registeredAt < graceMs)
      continue;
    objects.push(object.locator);
  }
  return { objects };
}

/**
 * 判断清理计划是否安全可执行。
 *
 * @param plan 清理计划。
 * @returns 是否存在可清理对象。
 */
export const isCleanupEmpty = (plan: CleanupPlan): boolean =>
  plan.objects.length === 0;
