import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  OAuthError,
  OAuthPortError,
  OAuthStateError,
  OAuthTimeoutError,
} from "./errors.js";
import { safeEqual } from "./pkce.js";

/** Callback params; on success `code`+`state`, on failure vendor fields like `error`. */
export interface CallbackParams {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

/** A short-lived loopback callback listener (design §6.1). */
export interface CallbackListener {
  /** Full callback URI bound to the loopback address only. */
  redirectUri: string;
  /** Wait for one callback; rejects on timeout, path mismatch, or state check failure. */
  wait(signal?: AbortSignal): Promise<CallbackParams>;
  /** Close the listener and release the port. */
  close(): void;
}

export interface LoopbackOptions {
  /** Expected OAuth state, which must match the callback byte for byte. */
  expectedState: string;
  /** Callback path; defaults to `/` to support vendor-registered loopback URIs on any port. */
  path?: string;
  /**
   * Preferred loopback ports to try; a random system-assigned port is used when empty.
   *
   * The Google desktop client may use any port, while vendors such as Dropbox that require
   * a pre-registered callback URI may need fixed ports; when a port is busy it falls back in order, reporting port status only when all are busy.
   */
  ports?: readonly number[];
  /** Maximum session lifetime (milliseconds). */
  timeoutMs?: number;
}

/** Minimal page returned to the system browser after authorization completes. */
const responsePage = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>Anynote 授权完成</title></head><body style="font-family:system-ui;padding:2rem">
<p>授权已完成，请返回 Anynote 继续配置。此页面可以关闭。</p></body></html>`;

/**
 * Start the server by trying candidate ports in order.
 *
 * Port-busy is reported only when all candidates fail with `EADDRINUSE`; other errors (such as permission) are
 * rethrown directly, with no pointless fallback.
 *
 * @param ports Candidate ports; `0` means system-assigned.
 * @param handler Request handler.
 * @returns The server that has started listening.
 */
async function listenOn(
  ports: readonly number[],
  handler: RequestListener,
): Promise<Server> {
  let lastError: unknown;
  for (const port of ports) {
    const server = createServer(handler);
    try {
      await new Promise<void>((ready, failed) => {
        server.once("error", failed);
        server.listen(port, "127.0.0.1", () => ready());
      });
      return server;
    } catch (error) {
      // After a failure clean up this candidate, removing the error listener to avoid an unhandled event on close.
      server.removeAllListeners("error");
      server.close(() => {});
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      lastError = error;
    }
  }
  throw new OAuthPortError(
    `OAuth 回调端口被占用（${ports.join("、")}），请关闭占用该端口的程序后重试。`,
    { cause: lastError },
  );
}

/**
 * Open a one-shot callback listener on the loopback address.
 *
 * Binds only `127.0.0.1` on an ephemeral port, listens on a single path, and lives briefly; the callback verifies state
 * and the expected path then closes immediately, neither listening on all interfaces nor running in a Node-privileged WebView.
 * Custom schemes also verify state, preventing callback interception.
 *
 * @param options Expected state, callback path, preferred ports, and timeout.
 * @returns The callback listener.
 */
export async function startLoopbackListener(
  options: LoopbackOptions,
): Promise<CallbackListener> {
  const expectedPath = options.path ?? "/",
    timeoutMs = options.timeoutMs ?? 180_000,
    expectedState = options.expectedState,
    candidates = options.ports?.length ? [...options.ports] : [0];
  let settled = false;
  // The timeout handle is assigned only after listening starts; a mutable holder avoids a `prefer-const` vs TDZ conflict.
  const timers: { timeout?: NodeJS.Timeout } = {};
  let resolve!: (value: CallbackParams) => void,
    reject!: (error: Error) => void;
  const result = new Promise<CallbackParams>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The session may settle with no one calling `wait()` (e.g. close/discard right after `begin`);
  // attach an empty handler in advance to avoid unhandled rejections on these paths.
  result.catch(() => {});

  /** End the callback wait, ensuring it settles only once. */
  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    if (timers.timeout) clearTimeout(timers.timeout);
    fn();
  };

  const handler: RequestListener = (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== expectedPath) {
      res.writeHead(404).end();
      return;
    }
    const params: CallbackParams = {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
      error: url.searchParams.get("error") ?? undefined,
      errorDescription: url.searchParams.get("error_description") ?? undefined,
    };
    res
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(responsePage);
    if (!params.state || !safeEqual(expectedState, params.state)) {
      settle(() => reject(new OAuthStateError("OAuth 回调 state 校验失败")));
      return;
    }
    settle(() => resolve(params));
  };

  const server = await listenOn(candidates, handler);

  const address = server.address() as AddressInfo,
    redirectUri = `http://127.0.0.1:${address.port}${expectedPath}`;

  timers.timeout = setTimeout(() => {
    settle(() => reject(new OAuthTimeoutError("OAuth 授权超时，请重新连接")));
  }, timeoutMs);
  timers.timeout.unref?.();

  server.once("close", () => {
    settle(() => reject(new OAuthError("OAuth 授权会话已关闭")));
  });

  return {
    redirectUri,
    wait: async (signal?: AbortSignal) => {
      const onAbort = () =>
        settle(() => reject(new OAuthError("OAuth 授权已取消")));
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        return await result;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        server.close();
      }
    },
    close: () => {
      settle(() => reject(new OAuthError("OAuth 授权会话已关闭")));
      server.close();
    },
  };
}
