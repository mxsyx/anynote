import type { Storage } from "@anynote/storage-sqlite/index.js";
import { canAutoRun } from "./failure.js";
import { readAccounts, readTargets } from "./state.js";

export interface CloudSchedulerOptions {
  /** Poll interval; kept on the same order as remote-target scheduling. */
  intervalMs?: number;
  now?: () => number;
}

/**
 * Start cloud automatic backup scheduling (design §8.3).
 *
 * Shares the same policy semantics as Cloudflare/local targets: no trigger during a sticky pause or backoff, and it runs only when
 * the configured minimum interval is reached; manual "backup now" is not gated by this. Merging consecutive edits relies on
 * the minimum interval rather than an edit-idle debounce.
 *
 * @param s Storage。
 * @param options Poll interval and clock.
 * @returns The scheduling handle.
 */
export function startCloudBackupScheduler(
  s: Storage,
  options: CloudSchedulerOptions = {},
) {
  const intervalMs = options.intervalMs ?? 60_000,
    now = options.now ?? Date.now;

  const tick = async () => {
    const accounts = new Set(readAccounts(s).map((account) => account.id));
    for (const target of readTargets(s)) {
      if (!target.autoBackup || !accounts.has(target.accountRefId)) continue;
      if (!canAutoRun(target, now())) continue;
      const interval = Math.max(target.intervalMinutes ?? 10, 10) * 60_000;
      if (target.lastAttempt && now() - target.lastAttempt < interval) continue;
      try {
        await s.run("startCloudBackup", {
          notebookId: target.notebookId,
          targetId: target.id,
        });
      } catch {
        // One target failing does not affect others; the failure state is recorded by the task itself.
      }
    }
  };

  const timer = setInterval(() => void tick().catch(() => {}), intervalMs);
  timer.unref?.();
  return { tick, dispose: () => clearInterval(timer) };
}
