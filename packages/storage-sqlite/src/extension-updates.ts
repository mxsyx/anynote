import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Storage } from "./index.js";
import type { InstalledExtension } from "@anynote/plugin-sdk/declarative.js";
import { assertLocalPath } from "./workspace.js";
import { extensionCatalog } from "./extension-catalog.js";
import { downloadExtension } from "./extension-download.js";
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const resultSchema = z
  .object({
    extensionId: z.string().max(81),
    installedChecksum: z.string().regex(/^[a-f0-9]{64}$/),
    sourceURL: z.string().max(2048),
    status: z.enum(["current", "available", "error"]),
    version: z.string().max(128).optional(),
    checkedAt: timestamp,
    error: z.string().max(300).optional(),
  })
  .strict();
const settingsSchema = z
  .object({
    enabled: z.boolean(),
    intervalHours: z.number().int().min(1).max(168),
    revision: z.string().uuid(),
    lastAttempt: timestamp,
    results: z.array(resultSchema).max(64),
  })
  .strict();
type Settings = z.infer<typeof settingsSchema>;
interface Runtime {
  closed: boolean;
  running: boolean;
  controller?: AbortController;
  token?: string;
}
const states = new WeakMap<Storage, Runtime>();
function runtime(s: Storage) {
  let r = states.get(s);
  if (!r) {
    r = { closed: false, running: false };
    states.set(s, r);
  }
  if (r.closed) throw Error("知识库服务已关闭");
  return r;
}
export function closeExtensionUpdateChecks(s: Storage) {
  const r = states.get(s) || { closed: false, running: false };
  r.closed = true;
  r.controller?.abort();
  r.token = undefined;
  states.set(s, r);
}
function load(s: Storage) {
  const path = assertLocalPath(s.root, "_local/extensions/update-checks.json");
  if (!existsSync(path))
    return {
      path,
      settings: settingsSchema.parse({
        enabled: false,
        intervalHours: 24,
        revision: randomUUID(),
        lastAttempt: 0,
        results: [],
      }),
    };
  const bytes = readFileSync(path);
  if (bytes.length > 256 * 1024) throw Error("更新检查配置超过预算");
  return { path, settings: settingsSchema.parse(JSON.parse(bytes.toString())) };
}
function save(path: string, settings: Settings) {
  settingsSchema.parse(settings);
  const json = JSON.stringify(settings);
  if (Buffer.byteLength(json) > 256 * 1024) throw Error("更新检查配置超过预算");
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + "." + randomUUID();
  writeFileSync(tmp, json, { mode: 0o600, flush: true });
  renameSync(tmp, path);
}
export async function updateOperation(
  s: Storage,
  op: string,
  raw: Record<string, unknown>,
) {
  const r = runtime(s),
    c = load(s),
    settings = c.settings;
  if (op === "getExtensionUpdateSettings") {
    z.object({}).strict().parse(raw);
    const sources: InstalledExtension[] = await extensionCatalog(
      s,
      "listExtensionUpdateSources",
      {},
    );
    return {
      ...settings,
      running: r.running,
      nextCheckAt: settings.enabled
        ? settings.lastAttempt
          ? settings.lastAttempt + settings.intervalHours * 3600_000
          : Date.now()
        : null,
      results: settings.results.filter((e) =>
        sources.some(
          (source) =>
            source.manifest.id === e.extensionId &&
            source.checksum === e.installedChecksum &&
            source.downloadURL === e.sourceURL,
        ),
      ),
    };
  }
  if (op === "configureExtensionUpdates") {
    const p = z
      .object({
        enabled: z.boolean(),
        intervalHours: z.number().int().min(1).max(168),
      })
      .strict()
      .parse(raw);
    settings.enabled = p.enabled;
    settings.intervalHours = p.intervalHours;
    settings.revision = randomUUID();
    settings.lastAttempt = 0;
    save(c.path, settings);
    r.controller?.abort();
    r.token = undefined;
    return true;
  }
  if (op === "beginExtensionUpdateCheck") {
    const p = z
      .object({ force: z.boolean(), now: timestamp })
      .strict()
      .parse(raw);
    if (
      !p.force &&
      (!settings.enabled ||
        (settings.lastAttempt > 0 &&
          p.now >= settings.lastAttempt &&
          p.now - settings.lastAttempt < settings.intervalHours * 3600_000))
    )
      return null;
    const token = randomUUID();
    r.token = token;
    settings.lastAttempt = p.now;
    save(c.path, settings);
    return {
      token,
      revision: settings.revision,
      sources: await extensionCatalog(s, "listExtensionUpdateSources", {}),
    };
  }
  if (op === "commitExtensionUpdateCheck") {
    const p = z
      .object({
        token: z.string().uuid(),
        revision: z.string().uuid(),
        results: z.array(resultSchema).max(64),
      })
      .strict()
      .parse(raw);
    if (r.token !== p.token || settings.revision !== p.revision)
      throw Error("更新检查配置已改变");
    settings.results = p.results;
    save(c.path, settings);
    r.token = undefined;
    return true;
  }
  throw Error("更新检查操作无效");
}
export async function checkExtensionUpdates(
  s: Storage,
  force = false,
  now = Date.now,
) {
  const r = runtime(s);
  if (r.running) {
    if (force) throw Error("更新检查正在进行");
    return false;
  }
  r.running = true;
  const controller = new AbortController();
  r.controller = controller;
  try {
    const prepared: {
      token: string;
      revision: string;
      sources: InstalledExtension[];
    } | null = await s.run("beginExtensionUpdateCheck", { force, now: now() });
    if (!prepared) return false;
    const results: z.infer<typeof resultSchema>[] = [];
    for (const source of prepared.sources) {
      controller.signal.throwIfAborted();
      const base = {
        extensionId: source.manifest.id,
        installedChecksum: source.checksum,
        sourceURL: source.downloadURL!,
        checkedAt: now(),
      };
      try {
        const result = await downloadExtension(
          s,
          "checkExtensionUpdate",
          { extensionId: source.manifest.id, checksum: source.checksum },
          undefined,
          { checkOnly: true, signal: controller.signal },
        );
        if (result.status !== "current" && result.status !== "available")
          throw Error("更新检查响应无效");
        results.push({
          ...base,
          status: result.status,
          version: result.manifest!.version.slice(0, 128),
        });
      } catch (error) {
        controller.signal.throwIfAborted();
        results.push({
          ...base,
          status: "error",
          error: (error as Error).message.slice(0, 300),
        });
      }
    }
    controller.signal.throwIfAborted();
    await s.run("commitExtensionUpdateCheck", {
      token: prepared.token,
      revision: prepared.revision,
      results,
    });
    return true;
  } catch (error) {
    if (controller.signal.aborted) throw Error("扩展更新检查已取消");
    throw error;
  } finally {
    r.running = false;
    if (r.controller === controller) r.controller = undefined;
  }
}
export function startExtensionUpdateScheduler(
  s: Storage,
  { intervalMs = 60_000, now = Date.now } = {},
) {
  let disposed = false;
  const tick = () =>
    disposed ? Promise.resolve(false) : checkExtensionUpdates(s, false, now);
  const timer = setInterval(() => void tick().catch(() => {}), intervalMs);
  timer.unref?.();
  return {
    tick,
    dispose() {
      disposed = true;
      clearInterval(timer);
      states.get(s)?.controller?.abort();
    },
  };
}

export function cancelExtensionUpdateCheck(s: Storage) {
  const r = runtime(s);
  r.controller?.abort();
  r.token = undefined;
  return true;
}
