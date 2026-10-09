import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { safeEqual } from "./pkce.js";

/** 回调参数；成功时为 `code`+`state`，失败时为 `error` 等厂商字段。 */
export interface CallbackParams {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

/** 一个短期存活的回环回调监听器（设计 §6.1）。 */
export interface CallbackListener {
  /** 仅绑定回环地址的完整回调 URI。 */
  redirectUri: string;
  /** 等待一次回调；超时、路径不符或 state 校验失败会 reject。 */
  wait(signal?: AbortSignal): Promise<CallbackParams>;
  /** 关闭监听并释放端口。 */
  close(): void;
}

export interface LoopbackOptions {
  /** 期望的 OAuth state，必须与回调逐字节一致。 */
  expectedState: string;
  /** 回调路径；默认 `/` 以兼容厂商注册的任意端口回环 URI。 */
  path?: string;
  /** 会话最长存活时间（毫秒）。 */
  timeoutMs?: number;
}

/** 授权完成后返回给系统浏览器的极简页面。 */
const responsePage = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>Anynote 授权完成</title></head><body style="font-family:system-ui;padding:2rem">
<p>授权已完成，请返回 Anynote 继续配置。此页面可以关闭。</p></body></html>`;

/**
 * 在回环地址上开启一次性回调监听。
 *
 * 只绑定 `127.0.0.1` 的临时端口、监听单个路径、会话短期存活；回调验证 state
 * 与预期路径后立即关闭，不监听全部网卡，也不在带 Node 权限的 WebView 中执行。
 * 自定义 scheme 同样会校验 state，避免回调被截获。
 *
 * @param options 期望 state、回调路径与超时。
 * @returns 回调监听器。
 */
export async function startLoopbackListener(
  options: LoopbackOptions,
): Promise<CallbackListener> {
  const expectedPath = options.path ?? "/",
    timeoutMs = options.timeoutMs ?? 180_000,
    expectedState = options.expectedState;
  let settled = false;
  // 超时句柄在监听建立后才赋值，用可变持有对象避免 `prefer-const` 与 TDZ 冲突。
  const timers: { timeout?: NodeJS.Timeout } = {};
  let resolve!: (value: CallbackParams) => void,
    reject!: (error: Error) => void;
  const result = new Promise<CallbackParams>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  /** 结束回调等待，确保只结算一次。 */
  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    if (timers.timeout) clearTimeout(timers.timeout);
    fn();
  };

  const server = createServer((req, res) => {
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
      settle(() => reject(Error("OAuth 回调 state 校验失败")));
      return;
    }
    settle(() => resolve(params));
  });

  await new Promise<void>((ready, failed) => {
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => ready());
  });

  const address = server.address() as AddressInfo,
    redirectUri = `http://127.0.0.1:${address.port}${expectedPath}`;

  timers.timeout = setTimeout(() => {
    settle(() => reject(Error("OAuth 授权超时，请重新连接")));
  }, timeoutMs);
  timers.timeout.unref?.();

  server.once("close", () => {
    settle(() => reject(Error("OAuth 授权会话已关闭")));
  });

  return {
    redirectUri,
    wait: async (signal?: AbortSignal) => {
      const onAbort = () => settle(() => reject(Error("OAuth 授权已取消")));
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        return await result;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        server.close();
      }
    },
    close: () => {
      settle(() => reject(Error("OAuth 授权会话已关闭")));
      server.close();
    },
  };
}
