import type { Storage } from "@anynote/storage-sqlite/index.js";
import { cloudPause } from "./network.js";
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

  let running = false,
    disposed = false;
  const tick = async () => {
    if (running || disposed) return;
    running = true;
    try {
      const accounts = new Set(
        readAccounts(s)
          .filter((account) => !account.reauthReason)
          .map((account) => account.id),
      );
      for (const target of readTargets(s)) {
        if (!target.autoBackup || !accounts.has(target.accountRefId)) continue;
        if (disposed) break;
        if (!canAutoRun(target, now()) || cloudPause(s, target)) continue;
        const interval = Math.max(target.intervalMinutes ?? 10, 10) * 60_000;
        if (target.lastAttempt && now() - target.lastAttempt < interval)
          continue;
        try {
          await s.run("startCloudBackup", {
            notebookId: target.notebookId,
            targetId: target.id,
          });
        } catch {
          // One target failing does not affect others; the failure state is recorded by the task itself.
        }
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick().catch(() => {}), intervalMs);
  timer.unref?.();
  return {
    tick,
    dispose: () => {
      disposed = true;
      clearInterval(timer);
    },
  };
}
