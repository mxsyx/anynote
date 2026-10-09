import type {
  CleanupPlan,
  CloudBackupHead,
  CloudBackupManifest,
  CloudObjectLocator,
} from "@anynote/types/cloud-backup.js";

/** A managed object registered by this app. */
export interface ManagedObject {
  locator: CloudObjectLocator;
  kind: "database" | "asset" | "manifest" | "pending";
  sha256?: string;
  /** Registration time; used for the commit grace-period check. */
  registeredAt?: number;
}

export interface CleanupInput {
  /** Current pointer; empty means the managed scope cannot be determined, so cleanup is forbidden. */
  currentHead: CloudBackupHead | null;
  currentManifest: CloudBackupManifest | null;
  /** All managed objects registered locally. */
  managed: readonly ManagedObject[];
  /** Objects protected by in-progress tasks and restore pins. */
  protectedLocators?: readonly CloudObjectLocator[];
  /** Commit grace period (milliseconds); defaults to 24 hours. */
  graceMs?: number;
  now?: number;
}

const locatorKey = (locator: CloudObjectLocator) =>
  `${locator.kind}\u0000${locator.ref}`;

/**
 * Build a managed garbage collection plan (design §9.3, §14.3).
 *
 * Only cleans objects registered by this app within the current slot; if `current` is unconfirmed, paging/reading fails,
 * or the plan is incomplete, nothing is cleaned. In-progress tasks, restore downloads, and objects still in the commit grace period are kept.
 *
 * @param input Managed objects and the protected set.
 * @returns The plan of objects to clean up.
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
    // Objects still within the commit grace period are kept, avoiding deletion of copies needed by an in-flight restore.
    if (object.registeredAt != null && now - object.registeredAt < graceMs)
      continue;
    objects.push(object.locator);
  }
  return { objects };
}

/**
 * Determine whether a cleanup plan is safe to execute.
 *
 * @param plan The cleanup plan.
 * @returns Whether there are objects to clean up.
 */
export const isCleanupEmpty = (plan: CleanupPlan): boolean =>
  plan.objects.length === 0;
