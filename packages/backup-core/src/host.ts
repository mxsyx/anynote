import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertLocalPath } from "@anynote/storage-sqlite/workspace.js";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Storage } from "@anynote/storage-sqlite/index.js";
import type {
  BackupHostContext,
  CloudAccountRef,
  CloudBackupAccount,
  ScopedAccountAPI,
  ScopedReadSource,
} from "@anynote/types/cloud-backup.js";
import type { OAuthBroker } from "@anynote/oauth-broker";
import { CloudAuthError } from "@anynote/oauth-broker";
import {
  createNotebookCaptureAPI,
  createResourcesAPI,
  createVerifierAPI,
} from "./capture.js";
import { deleteProviderState, providerState } from "./state.js";

/** 系统浏览器唤起的进程级钩子；只有主进程能真正执行。 */
let openExternalHook: ((url: string) => Promise<void>) | undefined;

/**
 * 注入「用系统浏览器打开授权页」的实现（由存储进程转发到主进程）。
 *
 * @param hook 打开外部链接的函数。
 */
export function setCloudOpenExternal(
  hook: ((url: string) => Promise<void>) | undefined,
): void {
  openExternalHook = hook;
}

/**
 * 读取当前注入的浏览器唤起实现。
 *
 * 未注入时返回 undefined，由调用方决定回退策略（如由渲染进程打开授权 URL）；
 * 这样浏览器预览与自动化测试可以复用同一条 PKCE 流程。
 *
 * @returns 唤起函数或 undefined。
 */
export function optionalCloudOpenExternal():
  | ((url: string) => Promise<void>)
  | undefined {
  return openExternalHook;
}

/** 脱敏日志环形缓冲；只保留最近条目，供诊断读取。 */
const logRing: { at: number; level: string; message: string }[] = [];

/**
 * 读取扩展脱敏日志。
 *
 * @returns 最近的日志条目副本。
 */
export const listProviderLogs = () => logRing.map((entry) => ({ ...entry }));

/** 受限 HTTP 客户端的构造参数。 */
interface AuthorizedClientArgs {
  accessToken(): Promise<string>;
  /** 令牌失效时刷新；返回新的 access token。 */
  refresh?(): Promise<string>;
}

const defaultMaxBytes = 8 * 1024 * 1024;

/** 单次 fetch 的中间结果。 */
interface RawResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

/**
 * 构造受限 HTTP 客户端。
 *
 * 规则（设计 §6.2、§16）：
 * - 非 `raw` 请求注入 Bearer；`raw` 用于自带凭据的上传会话 URL；
 * - 手动处理重定向，跨源时丢弃 Authorization，不向第三方转发 Bearer；
 * - 401 时刷新一次 access token 并重试，避免把过期当成永久失败。
 *
 * @param args access token 提供者与刷新函数。
 * @returns 受限请求、流式上传与流式下载能力。
 */
function createHttpClient(args: AuthorizedClientArgs) {
  const send = async (
    url: string,
    {
      method = "GET",
      headers = {},
      body,
      signal,
      raw,
    }: {
      method?: string;
      headers?: Record<string, string>;
      body?: Uint8Array | string | ReadableStream<Uint8Array>;
      signal?: AbortSignal;
      raw?: boolean;
    },
    allowRefresh: boolean,
  ): Promise<RawResponse> => {
    let currentUrl = url,
      currentMethod = method,
      currentBody = body,
      token: string | undefined;
    if (!raw) token = await args.accessToken();
    const baseOrigin = new URL(url).origin;
    for (let hop = 0; hop <= 5; hop += 1) {
      signal?.throwIfAborted();
      const sendHeaders: Record<string, string> = { ...headers };
      // 跨源重定向后不再携带 Bearer，避免把凭据交给第三方主机。
      if (!raw && token && new URL(currentUrl).origin === baseOrigin)
        sendHeaders.Authorization = `Bearer ${token}`;
      const response = await fetch(currentUrl, {
        method: currentMethod,
        headers: sendHeaders,
        body: currentBody as BodyInit | undefined,
        redirect: "manual",
        signal,
        ...(currentBody && typeof currentBody === "object"
          ? { duplex: "half" }
          : {}),
      } as RequestInit & { duplex?: "half" });
      if (response.status === 401 && !raw && allowRefresh && args.refresh) {
        await response.body?.cancel();
        token = await args.refresh();
        allowRefresh = false;
        hop -= 1;
        continue;
      }
      const location = response.headers.get("location");
      if (location && response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        currentUrl = new URL(location, currentUrl).toString();
        // 303 与大多数 301/302 的 POST 都转为 GET；这里对非 307/308 统一降级。
        if (response.status !== 307 && response.status !== 308)
          if (currentMethod !== "GET" && currentMethod !== "HEAD") {
            currentMethod = "GET";
            currentBody = undefined;
          }
        continue;
      }
      return {
        status: response.status,
        headers: response.headers,
        body: response.body,
      };
    }
    throw Error("云盘重定向次数过多");
  };

  const buffer = async (
    response: RawResponse,
    maxBytes: number,
  ): Promise<Uint8Array> => {
    if (!response.body) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw Error("云盘响应超过读取预算");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  };

  return {
    send,
    buffer,
    async request(
      url: string,
      init: Parameters<ScopedAccountAPI["request"]>[1],
    ) {
      const response = await send(
        url,
        {
          method: init?.method,
          headers: init?.headers,
          body: init?.body,
          signal: init?.signal,
          raw: init?.raw,
        },
        true,
      );
      const bytes = await buffer(response, init?.maxBytes ?? defaultMaxBytes);
      if (response.status >= 400)
        throw Object.assign(Error(`云盘返回 HTTP ${response.status}`), {
          status: response.status,
          retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
        });
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        bytes,
      };
    },
    async upload(url: string, init: Parameters<ScopedAccountAPI["upload"]>[1]) {
      const response = await send(
        url,
        {
          method: init.method,
          headers: init.headers,
          body: Readable.toWeb(
            Readable.from(init.source),
          ) as unknown as ReadableStream<Uint8Array>,
          signal: init.signal,
          raw: init.raw,
        },
        true,
      );
      const bytes = await buffer(response, init.maxBytes ?? defaultMaxBytes);
      // 308 表示分片续传中，交给调用方按服务端确认偏移继续，不算错误。
      if (response.status >= 400)
        throw Object.assign(Error(`云盘上传返回 HTTP ${response.status}`), {
          status: response.status,
          retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
          bytes,
        });
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        bytes,
      };
    },
    async downloadToFile(
      url: string,
      init: Parameters<ScopedAccountAPI["request"]>[1],
      options: { maxBytes?: number; hash?: boolean } = {},
      tempFile: string,
    ) {
      const response = await send(
        url,
        {
          method: init?.method ?? "GET",
          headers: init?.headers,
          signal: init?.signal,
          raw: init?.raw,
        },
        true,
      );
      if (response.status >= 400) {
        await response.body?.cancel();
        throw Object.assign(Error(`云盘下载返回 HTTP ${response.status}`), {
          status: response.status,
        });
      }
      if (!response.body) throw Error("云盘下载缺少响应体");
      let bytes = 0;
      const hash = options.hash ? createHash("sha256") : undefined;
      const meter = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > (options.maxBytes ?? Number.MAX_SAFE_INTEGER)) {
            callback(Error("云盘下载超过预算"));
            return;
          }
          hash?.update(chunk);
          callback();
        },
      });
      await pipeline(
        Readable.fromWeb(
          response.body as unknown as import("node:stream/web").ReadableStream,
        ),
        meter,
        createWriteStream(tempFile, { mode: 0o600 }),
      );
      return {
        filePath: tempFile,
        bytes,
        sha256: hash?.digest("hex"),
      };
    },
  };
}

/**
 * 解析 `Retry-After` 头。
 *
 * @param value 头值。
 * @returns 建议等待的毫秒数。
 */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** 核心私有临时目录；扩展只拿到其中的文件路径，拿不到 root。 */
export function createTempDir(s: Storage, prefix: string): string {
  const dir = join(s.root, "_local", "cloud-backup-tmp");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${prefix}-${randomUUID()}`);
  mkdirSync(target, { recursive: true });
  return target;
}

export interface HostContextArgs {
  s: Storage;
  broker: OAuthBroker;
  account: CloudBackupAccount;
  /** 已授权 Notebook；仅探测能力时可以为空。 */
  notebookId?: string;
  providerId: string;
  signal: AbortSignal;
  deviceLabel?: string;
  concurrency?: number;
  onProgress?: (bytes: number, message?: string) => void;
  /** 核心管理的临时目录，用于流式下载大对象。 */
  tempDir: string;
}

/**
 * 为一次 Provider 调用构造运行期上下文（设计 §15.2）。
 *
 * 上下文只暴露捕获、资源、账号、网络、任务、本机状态与校验门面；SDK 不公开
 * 任意数据库连接、绝对磁盘路径或全局 token。
 *
 * @param args Storage、broker、账号与任务参数。
 * @returns Provider 运行期上下文。
 */
export function createBackupHostContext(
  args: HostContextArgs,
): BackupHostContext {
  const { s, broker, account, providerId } = args,
    // 按 provider + Notebook 隔离扩展状态，避免多库共用一份键空间。
    stateScope = `${providerId}:${args.notebookId ?? "-"}`,
    ref: CloudAccountRef = account.ref,
    tokenProvider = broker.tokenProvider(
      account.id,
      ref.providerId,
      ref.oauthClientId,
    ),
    client = createHttpClient({
      accessToken: async () => (await tokenProvider.getAccessToken()).token,
      refresh: async () => (await tokenProvider.getAccessToken()).token,
    });

  const scopedAccounts: ScopedAccountAPI = {
    current: () => ref,
    tokenProvider: () => tokenProvider,
    request: (url, init) => client.request(url, init),
    upload: (url, init) => client.upload(url, init),
    downloadToFile: async (url, init, options) => {
      const relative = options?.dest,
        filePath = relative
          ? assertLocalPath(args.tempDir, relative)
          : join(args.tempDir, `download-${randomUUID()}`);
      mkdirSync(dirname(filePath), { recursive: true });
      return client.downloadToFile(url, init, options ?? {}, filePath);
    },
  };

  return {
    capture: createNotebookCaptureAPI(s),
    resources: {
      open: async (sha256, signal) => {
        if (!args.notebookId)
          throw Error("当前任务没有已授权的 Notebook 上下文");
        return createResourcesAPI(s, args.notebookId).open(sha256, signal);
      },
    },
    accounts: scopedAccounts,
    http: scopedAccounts.request,
    tasks: {
      signal: args.signal,
      progress: (bytes, message) => args.onProgress?.(bytes, message),
      log: (level, message) => {
        logRing.push({ at: Date.now(), level, message });
        // 只保留最近 200 条，避免长时任务无限增长。
        if (logRing.length > 200) logRing.splice(0, logRing.length - 200);
      },
      concurrency: () => args.concurrency ?? 2,
    },
    state: {
      get: async <T = unknown>(key: string) =>
        (providerState(s, stateScope, key) ?? null) as T | null,
      set: async (key, value) => {
        providerState(s, stateScope, key, value);
      },
      delete: async (key) => {
        deleteProviderState(s, stateScope, key);
      },
    },
    verifier: createVerifierAPI(),
    notebookId: args.notebookId,
    deviceLabel: args.deviceLabel,
  };
}

/** 便于测试断言：把 `ScopedReadSource` 全量读成字节。 */
export async function readAll(
  source: ScopedReadSource,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source.stream(signal)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export { CloudAuthError };
