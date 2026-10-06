import { guard } from "@anynote/backup-local";
import { patchLocalTarget, readLocalTargets } from "./local.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  environmentPause,
  isStickyPause,
  readPolicy,
  type EnvironmentState,
  type PauseReason,
} from "./policy.js";
import type { Storage } from "@anynote/storage-sqlite/index.js";
import type { BackupTarget } from "@anynote/types/runtime.js";

/** Scheduler options. */
export interface SchedulerOptions {
  /** How often the scheduler wakes up, in milliseconds. */
  intervalMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Host environment reader (battery/metered); overrides the persisted value. */
  environment?: () => EnvironmentState | undefined;
}

/**
 * Application-wide backup scheduler; it only acts on targets that explicitly enable automatic backup.
 *
 * Every pass applies the unified retry/pause policy: sticky pauses
 * (auth/permanent/exhausted) stop automatic runs until the user acts, the host
 * environment (battery/metered network/large task) can defer runs, and a failed
 * target is not retried before its backoff `nextAttemptAt`.
 *
 * @param storage Storage service used to run backups.
 * @param options Scheduler options (poll interval, clock and environment reader).
 * @returns Handle exposing a manual `tick` and a `dispose` function.
 */
export function startBackupScheduler(
  storage: Storage,
  { intervalMs = 60000, now = Date.now, environment }: SchedulerOptions = {},
) {
  const localOnline = new Map<string, boolean>();
  let disposed = false,
    running = false;

  /**
   * Persist an environment-driven pause on a local target (or clear it).
   *
   * @param id Local target ID.
   * @param reason Pause reason, or null to clear.
   */
  const setLocalPause = (id: string, reason: PauseReason | null) => {
    try {
      patchLocalTarget(storage, id, { pausedReason: reason });
    } catch {}
  };

  /**
   * Persist an environment-driven pause on a remote target (or clear it).
   *
   * @param target Remote backup target.
   * @param reason Pause reason, or null to clear.
   */
  const setRemotePause = (target: BackupTarget, reason: PauseReason | null) =>
    storage
      .run("commitBackupCursor", {
        notebookId: target.notebookId,
        targetId: target.id,
        cursor: { pausedReason: reason },
      })
      .catch(() => {});

  /** One scheduling pass: trigger automatic backups for local and remote targets according to configuration. */
  const tick = async () => {
    if (disposed || running) return;
    running = true;
    try {
      const { policy, environment: reported } = readPolicy(storage),
        env = environment?.() ?? reported,
        time = now(),
        path = join(storage.root, "_local", "backup-targets.json"),
        targets: BackupTarget[] = existsSync(path)
          ? JSON.parse(readFileSync(path, "utf8"))
          : [];
      for (const target of readLocalTargets(storage)) {
        if (disposed) break;
        let online = false;
        try {
          await guard({ id: target.diskId, path: target.path });
          online = true;
        } catch {}
        const mounted = online && localOnline.get(target.id) === false;
        localOnline.set(target.id, online);
        if (!target.autoBackup || !online) continue;
        // A sticky pause (permanent failure/exhausted retries) is only cleared
        // by a config change or success, never by the environment recovering.
        if (isStickyPause(target.pausedReason)) continue;
        const pause = environmentPause(policy, env, target.lastTaskBytes);
        if (pause) {
          if (target.pausedReason !== pause)
            await setLocalPause(target.id, pause);
          continue;
        }
        if (target.pausedReason) await setLocalPause(target.id, null);
        const mountedNow = target.onMount && mounted;
        if (!mountedNow) {
          if (target.nextAttemptAt && time < target.nextAttemptAt) continue;
          if (
            time - (target.lastAttempt || target.lastSuccess || 0) <
            target.intervalMinutes * 60000
          )
            continue;
        }
        await storage
          .run("startLocalBackup", {
            notebookId: target.notebookId,
            targetId: target.id,
          })
          .catch(() => {});
      }
      for (const target of targets) {
        if (disposed) break;
        if (
          !target.autoBackup ||
          !existsSync(
            join(storage.directory(target.notebookId), "notebook.sqlite"),
          )
        )
          continue;
        if (isStickyPause(target.pausedReason)) continue;
        const pause = environmentPause(policy, env, target.lastTaskBytes);
        if (pause) {
          if (target.pausedReason !== pause)
            await setRemotePause(target, pause);
          continue;
        }
        if (target.pausedReason) await setRemotePause(target, null);
        if (target.nextAttemptAt && time < target.nextAttemptAt) continue;
        if (
          time - (target.lastAttempt || target.lastSuccess || 0) <
          (target.intervalMinutes || 10) * 60000
        )
          continue;
        try {
          await storage.run("startBackup", {
            notebookId: target.notebookId,
            targetId: target.id,
          });
        } catch (e: any) {
          await storage
            .run("commitBackupCursor", {
              notebookId: target.notebookId,
              targetId: target.id,
              cursor: { lastAttempt: now(), lastError: e.message },
            })
            .catch(() => {});
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
