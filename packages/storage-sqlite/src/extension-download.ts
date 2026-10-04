import {
  extensionDirectorySchema,
  type DirectoryEntry,
} from "@anynote/protocol/extension-directory.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { safeDownload } from "@anynote/importer/network.js";
import {
  extensionURLSchema,
  verifyExtensionPackage,
} from "./extension-signature.js";
import { extensionCatalog } from "./extension-catalog.js";
import type { Storage } from "./index.js";
import type {
  ExtensionSource,
  InstalledExtension,
  InstallableManifest,
} from "@anynote/plugin-sdk/declarative.js";
interface Review {
  package: unknown;
  url: string;
  expiresAt: number;
  expectedInstalledChecksum: string | null;
}
interface State {
  jobs: Set<AbortController>;
  reviews: Map<string, Review>;
  closed: boolean;
}
const states = new WeakMap<Storage, State>();
let active = 0;
function state(s: Storage) {
  let current = states.get(s);
  if (!current) {
    current = { jobs: new Set(), reviews: new Map(), closed: false };
    states.set(s, current);
  }
  if (current.closed) throw Error("知识库服务已关闭");
  return current;
}
export function closeExtensionDownloads(s: Storage) {
  const current = states.get(s) || {
    jobs: new Set<AbortController>(),
    reviews: new Map<string, Review>(),
    closed: false,
  };
  current.closed = true;
  for (const job of current.jobs) job.abort();
  current.reviews.clear();
  states.set(s, current);
}
export function cancelExtensionDownloads(s: Storage) {
  const current = state(s);
  for (const controller of current.jobs) controller.abort();
  current.reviews.clear();
  return true;
}
interface Preview {
  manifest: InstallableManifest;
  checksum: string;
  source: ExtensionSource;
  installed: {
    checksum: string;
    version: string;
    source: ExtensionSource;
  } | null;
}
// Test transport injection is internal-only, never selected by an IPC argument or an environment flag.
export async function downloadExtension(
  s: Storage,
  op: string,
  raw: Record<string, unknown>,
  download = safeDownload,
  options: {
    directory?: boolean;
    expected?: DirectoryEntry;
    checkOnly?: boolean;
    signal?: AbortSignal;
  } = {},
) {
  const current = state(s);
  const p =
    op === "downloadExtension"
      ? z.object({ url: extensionURLSchema }).strict().parse(raw)
      : z
          .object({
            notebookId: z.string().uuid().optional(),
            extensionId: z.string(),
            checksum: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict()
          .parse(raw);
  if (active >= 2) throw Error("扩展下载繁忙，请稍后重试");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.throwIfAborted();
  options.signal?.addEventListener("abort", cancel, { once: true });
  current.jobs.add(controller);
  active++;
  const timer = setTimeout(
    () => controller.abort(Error("扩展下载超时")),
    20_000,
  );
  let abortListener: (() => void) | undefined;
  try {
    let installed: InstalledExtension | undefined;
    let url: string;
    if ("url" in p) url = new URL(p.url).href;
    else {
      const entries: InstalledExtension[] = p.notebookId
        ? await s.run("listExtensions", { notebookId: p.notebookId })
        : await s.run("listExtensionUpdateSources");
      installed = entries.find((e) => e.manifest.id === p.extensionId);
      if (!installed || installed.checksum !== p.checksum)
        throw Error("已安装扩展发生变化，请刷新");
      if (
        !installed.source?.signed ||
        !installed.source.trusted ||
        !installed.downloadURL
      )
        throw Error("此扩展没有受信任的远程更新来源");
      url = extensionURLSchema.parse(installed.downloadURL);
    }
    controller.signal.throwIfAborted();
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () =>
        reject(controller.signal.reason || Error("扩展下载已取消"));
      controller.signal.addEventListener("abort", abortListener, {
        once: true,
      });
    });
    const response = await Promise.race([
      download(url, {
        signal: controller.signal,
        maxBytes: options.directory ? 256 * 1024 : 160 * 1024,
        redirects: 3,
        protocols: ["https:"],
      }),
      aborted,
    ]);
    controller.signal.throwIfAborted();
    // Defense in depth for the final URL and decoded bytes as well as transport limits.
    extensionURLSchema.parse(response.url);
    if (response.data.length > (options.directory ? 256 : 160) * 1024)
      throw Error("下载内容超过预算");
    const pack = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(response.data),
    );
    if (options.directory) {
      state(s);
      return {
        status: "directory" as const,
        directory: extensionDirectorySchema.parse(pack),
        url,
        finalURL: response.url,
      };
    }
    verifyExtensionPackage(pack);
    const preview: Preview = await s.run("previewExtension", { package: pack });
    state(s);
    controller.signal.throwIfAborted();
    const expected = options.expected;
    if (
      expected &&
      (preview.manifest.id !== expected.id ||
        preview.manifest.version !== expected.version ||
        preview.checksum !== expected.checksum ||
        preview.source.fingerprint !== expected.fingerprint ||
        preview.manifest.name !== expected.name ||
        preview.manifest.runtime !== expected.runtime ||
        JSON.stringify(preview.manifest.permissions) !==
          JSON.stringify(expected.permissions) ||
        (expected.description !== undefined &&
          preview.manifest.description !== expected.description))
    )
      throw Error("目录条目与签名包不匹配，请刷新目录");
    if (
      installed &&
      (preview.manifest.id !== installed.manifest.id ||
        preview.installed?.checksum !== installed.checksum)
    )
      throw Error("更新来源返回了不同扩展或安装状态已改变");
    if (preview.installed?.source.signed) {
      if (preview.installed.source.fingerprint !== preview.source.fingerprint)
        throw Error("更新必须由原发布者签名");
      const oldVersion = BigInt(preview.installed.version.split(".")[2]);
      const newVersion = BigInt(preview.manifest.version.split(".")[2]);
      if (
        newVersion < oldVersion ||
        (newVersion === oldVersion &&
          preview.installed.checksum !== preview.checksum)
      )
        throw Error("拒绝版本回退或同版本内容替换");
    }
    if (installed?.checksum === preview.checksum)
      return { status: "current", manifest: preview.manifest };
    if (options.checkOnly)
      return {
        status: "available",
        manifest: preview.manifest,
        checksum: preview.checksum,
      };
    const now = Date.now();
    for (const [id, r] of current.reviews)
      if (r.expiresAt <= now) current.reviews.delete(id);
    if (current.reviews.size >= 8)
      current.reviews.delete(current.reviews.keys().next().value!);
    const reviewId = randomUUID();
    current.reviews.set(reviewId, {
      package: pack,
      url,
      expiresAt: now + 10 * 60_000,
      expectedInstalledChecksum: preview.installed?.checksum ?? null,
    });
    return {
      status: "review",
      reviewId,
      url,
      finalURL: response.url,
      package: pack,
      ...preview,
    };
  } catch (error) {
    if (controller.signal.aborted)
      throw Error(
        controller.signal.reason?.message === "扩展下载超时"
          ? "扩展下载超时"
          : "扩展下载已取消",
      );
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    clearTimeout(timer);
    if (abortListener)
      controller.signal.removeEventListener("abort", abortListener);
    current.jobs.delete(controller);
    active--;
  }
}
// Called only inside the storage write queue. Install exactly the reviewed snapshot, with no second download.
export async function installDownloadedExtension(
  s: Storage,
  raw: Record<string, unknown>,
) {
  const p = z.object({ reviewId: z.string().uuid() }).strict().parse(raw);
  const current = state(s),
    review = current.reviews.get(p.reviewId);
  if (!review || review.expiresAt <= Date.now()) {
    current.reviews.delete(p.reviewId);
    throw Error("下载审核已过期，请重新下载");
  }
  const result = await extensionCatalog(
    s,
    "installExtension",
    { package: review.package },
    {
      downloadURL: review.url,
      expectedInstalledChecksum: review.expectedInstalledChecksum,
    },
  );
  current.reviews.delete(p.reviewId);
  return result;
}
