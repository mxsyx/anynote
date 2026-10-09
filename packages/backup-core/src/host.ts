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

/** Process-level hook for launching the system browser; only the main process can actually do it. */
let openExternalHook: ((url: string) => Promise<void>) | undefined;

/**
 * Inject the "open the authorization page in the system browser" implementation (forwarded from the storage process to the main process).
 *
 * @param hook Function that opens an external link.
 */
export function setCloudOpenExternal(
  hook: ((url: string) => Promise<void>) | undefined,
): void {
  openExternalHook = hook;
}

/**
 * Read the currently injected browser launcher.
 *
 * Returns undefined when not injected; the caller decides the fallback (e.g. the renderer opening the authorization URL),
 * so browser preview and automated tests can reuse the same PKCE flow.
 *
 * @returns The launch function or undefined.
 */
export function optionalCloudOpenExternal():
  | ((url: string) => Promise<void>)
  | undefined {
  return openExternalHook;
}

/** Redacted log ring buffer; keeps only recent entries for diagnostics. */
const logRing: { at: number; level: string; message: string }[] = [];

/**
 * Read the extension redacted log.
 *
 * @returns A copy of the recent log entries.
 */
export const listProviderLogs = () => logRing.map((entry) => ({ ...entry }));

/** Construction arguments for the restricted HTTP client. */
interface AuthorizedClientArgs {
  accessToken(): Promise<string>;
  /** Refresh when the token expires; returns a new access token. */
  refresh?(): Promise<string>;
}

const defaultMaxBytes = 8 * 1024 * 1024;

/** Intermediate result of a single fetch. */
interface RawResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

/**
 * Build the restricted HTTP client.
 *
 * Rules (design §6.2, §16):
 * - Inject Bearer for non-`raw` requests; `raw` is for upload session URLs that carry their own credentials;
 * - Handle redirects manually, dropping Authorization on cross-origin, never forwarding Bearer to a third party;
 * - On 401, refresh the access token once and retry, avoiding treating expiry as permanent failure.
 *
 * @param args Access token provider and refresh function.
 * @returns Restricted request, streaming upload, and streaming download capabilities.
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
      // Do not carry Bearer after a cross-origin redirect, avoiding handing credentials to a third-party host.
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
        // 303 and most 301/302 POSTs become GET; here everything other than 307/308 is downgraded uniformly.
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
          // Include the error response body so vendor extensions can distinguish semantics like path/not_found and conflict,
          // instead of treating every non-2xx as the same failure (design §11.3, §12.3).
          bytes,
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
      // 308 means a resumable chunk upload is in progress; the caller continues from the server-confirmed offset, not an error.
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
 * Parse the `Retry-After` header.
 *
 * @param value Header value.
 * @returns Suggested wait in milliseconds.
 */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Core-private temp directory; extensions only get file paths within it, never the root. */
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
  /** Authorized Notebook; may be empty when only probing capabilities. */
  notebookId?: string;
  providerId: string;
  signal: AbortSignal;
  deviceLabel?: string;
  concurrency?: number;
  onProgress?: (bytes: number, message?: string) => void;
  /** Core-managed temp directory used to stream large-object downloads. */
  tempDir: string;
}

/**
 * Build a runtime context for a single Provider call (design §15.2).
 *
 * The context exposes only the capture, asset, account, network, task, local-state, and verification facades; the SDK never exposes
 * arbitrary database connections, absolute disk paths, or global tokens.
 *
 * @param args Storage, broker, account, and task arguments.
 * @returns The Provider runtime context.
 */
export function createBackupHostContext(
  args: HostContextArgs,
): BackupHostContext {
  const { s, broker, account, providerId } = args,
    // Isolate extension state by provider + Notebook, avoiding a shared key space across notebooks.
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
        // Keep only the latest 200 entries, preventing unbounded growth over long tasks.
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

/** For test assertions: read a `ScopedReadSource` fully into bytes. */
export async function readAll(
  source: ScopedReadSource,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source.stream(signal)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export { CloudAuthError };
