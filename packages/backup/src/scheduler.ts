import { guard } from "@anynote/backup-local";
import { readLocalTargets } from "./local.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Storage } from "@anynote/storage-sqlite/index.js";
import type { BackupTarget } from "@anynote/types/runtime.js";

/**
 * Application-wide backup scheduler; it only acts on targets that explicitly enable automatic backup.
 *
 * @param storage Storage service used to run backups.
 * @param options Scheduler options (poll interval and clock).
 * @returns Handle exposing a manual `tick` and a `dispose` function.
 */
export function startBackupScheduler(
  storage: Storage,
  { intervalMs = 60000, now = Date.now } = {},
) {
  const localOnline = new Map<string, boolean>();
  let disposed = false,
    running = false;

  /** One scheduling pass: trigger automatic backups for local and remote targets according to configuration. */
  const tick = async () => {
    if (disposed || running) return;
    running = true;
    try {
      const path = join(storage.root, "_local", "backup-targets.json"),
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
        if (
          !target.autoBackup ||
          !online ||
          (!(target.onMount && mounted) &&
            now() - (target.lastAttempt || target.lastSuccess || 0) <
              target.intervalMinutes * 60000)
        )
          continue;
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
          ) ||
          now() - (target.lastAttempt || target.lastSuccess || 0) <
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
