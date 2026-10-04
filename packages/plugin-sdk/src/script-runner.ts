import {
  scriptAsyncSearchSchema,
  validateScriptSearchContext,
} from "@anynote/extension-tools/search-context.js";
import {
  scriptNetworkRequestsSchema,
  validateScriptNetworkResult,
} from "@anynote/extension-tools/network.js";
import { Worker } from "node:worker_threads";
import { validateScriptState } from "./script-state.js";
import type {
  MarkdownTransformInput,
  ScriptAsyncSearchRequest,
  ScriptNetworkRequest,
  ScriptNetworkResult,
  ScriptSearchContext,
  StatefulMarkdownTransformInput,
  StatefulMarkdownTransformResult,
} from "./declarative.js";
export const scriptLimits = Object.freeze({
  wallMs: 2000,
  cpuMs: 250,
  heapBytes: 64 * 1024 ** 2,
  scriptBytes: 64 * 1024,
  bodyCharacters: 2_000_000,
});
export interface ScriptHostOptions {
  requests: ScriptAsyncSearchRequest[];
  networkRequests?: ScriptNetworkRequest[];
  request?: (id: string) => Promise<ScriptNetworkResult>;
  search: (queryId: string) => Promise<ScriptSearchContext>;
}
let active = 0;
/** Worker isolation protects responsiveness; QuickJS/WASM provides guest/host separation. */
function runGuest(
  script: string,
  input: MarkdownTransformInput | StatefulMarkdownTransformInput,
  signal?: AbortSignal,
  stateful = false,
  host?: ScriptHostOptions,
): Promise<string | StatefulMarkdownTransformResult> {
  try {
    if (host?.requests.length) scriptAsyncSearchSchema.parse(host.requests);
    if (host?.networkRequests)
      scriptNetworkRequestsSchema.parse(host.networkRequests);
    if (host && !host.requests.length && !host.networkRequests)
      throw Error("宿主能力未声明");
    if (input.searchContext !== undefined)
      validateScriptSearchContext(input.searchContext);
    if (stateful)
      validateScriptState((input as StatefulMarkdownTransformInput).state);
  } catch (error) {
    return Promise.reject(error);
  }
  if (
    Buffer.byteLength(script) > scriptLimits.scriptBytes ||
    input.body.length > scriptLimits.bodyCharacters
  )
    return Promise.reject(Error("脚本或正文超过预算"));
  if (signal?.aborted) return Promise.reject(Error("扩展已停用或执行已撤销"));
  if (active >= 2) return Promise.reject(Error("脚本执行繁忙，请稍后重试"));
  active++;
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./script-worker.js", import.meta.url), {
        workerData: {
          script,
          input,
          stateful,
          asyncSearch: host?.requests.length ? host.requests : undefined,
          networkRequests: host?.networkRequests,
        },
        resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 },
        execArgv: [],
      });
    } catch (e) {
      active--;
      reject(e);
      return;
    }
    let finished = false;
    const finish = (
      error?: Error,
      body?: string | StatefulMarkdownTransformResult,
    ) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      // Do not release concurrency until the worker has actually stopped.
      void worker.terminate().then(
        () => {
          active--;
          if (error) reject(error);
          else resolve(body!);
        },
        (terminationError) => {
          active--;
          reject(error || terminationError);
        },
      );
    };
    const abort = () => finish(Error("扩展已停用或执行已撤销"));
    const timer = setTimeout(
      () => finish(Error("脚本执行超时")),
      scriptLimits.wallMs,
    );
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("error", (error) => finish(error));
    worker.once("exit", () => {
      if (!finished) finish(Error("脚本执行进程提前退出"));
    });
    let calls = 0,
      pending = false;
    worker.on("message", (message: unknown) => {
      if (finished) return;
      if (!message || typeof message !== "object") {
        finish(Error("脚本执行结果无效"));
        return;
      }
      if (
        "kind" in message &&
        ["host-search", "host-network"].includes(String(message.kind))
      ) {
        const request = message as {
          kind: string;
          sequence?: unknown;
          queryId?: unknown;
        };
        const network = request.kind === "host-network";
        const declaration = network
          ? host?.networkRequests?.find((r) => r.id === request.queryId)
          : host?.requests.find((r) => r.id === request.queryId);
        if (
          !host ||
          !declaration ||
          pending ||
          ++calls > 4 ||
          request.sequence !== calls ||
          (network && !host.request)
        ) {
          finish(Error("异步宿主调用无效或超过预算"));
          return;
        }
        pending = true;
        void Promise.resolve()
          .then<ScriptNetworkResult | ScriptSearchContext>(() =>
            network
              ? host.request!(declaration.id)
              : host.search(declaration.id),
          )
          .then((raw) => {
            if (finished || signal?.aborted) return;
            const value = network
              ? validateScriptNetworkResult(raw)
              : validateScriptSearchContext(raw);
            if (network) {
              if (
                (value as ScriptNetworkResult).url !==
                (declaration as ScriptNetworkRequest).url
              )
                throw Error("网络响应范围无效");
            } else {
              const r = value as ScriptSearchContext,
                d = declaration as ScriptAsyncSearchRequest;
              if (
                r.query !== d.query ||
                r.results.length > d.limit ||
                r.results.some((n) => n.id === input.id)
              )
                throw Error("异步搜索结果范围无效");
            }
            pending = false;
            worker.postMessage({
              kind: "host-search-result",
              sequence: request.sequence,
              value,
            });
          })
          .catch((error) =>
            finish(
              Error(error instanceof Error ? error.message : "异步宿主失败"),
            ),
          );
        return;
      }
      if (pending) {
        finish(Error("脚本结束前必须等待异步搜索完成"));
        return;
      }
      const result = message as {
        ok?: boolean;
        body?: unknown;
        error?: unknown;
        state?: unknown;
      };
      if (
        result.ok === true &&
        typeof result.body === "string" &&
        result.body.length <= scriptLimits.bodyCharacters
      ) {
        try {
          finish(
            undefined,
            stateful
              ? { body: result.body, state: validateScriptState(result.state) }
              : result.body,
          );
        } catch (error) {
          finish(error as Error);
        }
      } else
        finish(
          Error(
            typeof result.error === "string"
              ? result.error
              : "脚本执行结果无效",
          ),
        );
    });
    if (signal?.aborted) abort();
  });
}

export function runMarkdownTransform(
  script: string,
  input: MarkdownTransformInput,
  signal?: AbortSignal,
  host?: ScriptHostOptions,
): Promise<string> {
  return runGuest(script, input, signal, false, host) as Promise<string>;
}
export function runStatefulMarkdownTransform(
  script: string,
  input: StatefulMarkdownTransformInput,
  signal?: AbortSignal,
  host?: ScriptHostOptions,
): Promise<StatefulMarkdownTransformResult> {
  return runGuest(
    script,
    input,
    signal,
    true,
    host,
  ) as Promise<StatefulMarkdownTransformResult>;
}
