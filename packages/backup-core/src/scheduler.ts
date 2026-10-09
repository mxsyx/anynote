import type { Storage } from "@anynote/storage-sqlite/index.js";
import { canAutoRun } from "./failure.js";
import { readAccounts, readTargets } from "./state.js";

export interface CloudSchedulerOptions {
  /** 轮询间隔；与远端目标调度保持同一量级。 */
  intervalMs?: number;
  now?: () => number;
}

/**
 * 启动云盘自动备份调度（设计 §8.3）。
 *
 * 与 Cloudflare/本地目标共用同一套策略语义：粘性暂停与退避期间不触发，达到
 * 配置的最小间隔才执行；手动「立即备份」不受此门控限制。合并连续编辑依赖
 * 最小间隔而不是编辑停止空闲去抖。
 *
 * @param s Storage。
 * @param options 轮询间隔与时钟。
 * @returns 调度句柄。
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
        // 单个目标失败不影响其他目标；失败状态由任务自身记录。
      }
    }
  };

  const timer = setInterval(() => void tick().catch(() => {}), intervalMs);
  timer.unref?.();
  return { tick, dispose: () => clearInterval(timer) };
}
