import type { Storage } from "./index.js";
import type {
  MarkdownTransformInput,
  ScriptAsyncSearchRequest,
  ScriptNetworkRequest,
  ScriptSearchContext,
  StatefulMarkdownTransformInput,
} from "@anynote/plugin-sdk/declarative.js";
import {
  runMarkdownTransform,
  runStatefulMarkdownTransform,
} from "@anynote/plugin-sdk/script-runner.js";
import { safeDownload } from "@anynote/importer/network.js";
import { downloadScriptNetwork } from "./script-network.js";
import { extensionCatalog } from "./extension-catalog.js";
export interface ScriptPlan {
  kind: "script-plan";
  source: string;
  input: MarkdownTransformInput | StatefulMarkdownTransformInput;
  stateRevision?: number;
  settingsRevision?: number;
  searchContextSeq?: number;
  asyncSearch?: ScriptAsyncSearchRequest[];
  networkRequests?: ScriptNetworkRequest[];
  controller: AbortController;
}
const closed = new WeakSet<Storage>();
export function closeScripts(s: Storage) {
  closed.add(s);
  cancelScripts(s);
}
const running = new WeakMap<
  Storage,
  Set<{ extensionId: string; notebookId: string; controller: AbortController }>
>();
export function registerScript(
  s: Storage,
  extensionId: string,
  notebookId: string,
) {
  if (closed.has(s)) throw Error("知识库服务已关闭");
  let jobs = running.get(s);
  if (!jobs) {
    jobs = new Set();
    running.set(s, jobs);
  }
  if (jobs.size >= 2) throw Error("脚本执行繁忙，请稍后重试");
  const controller = new AbortController();
  jobs.add({ extensionId, notebookId, controller });
  return controller;
}
export function cancelScripts(
  s: Storage,
  extensionId?: string,
  notebookId?: string,
) {
  for (const job of running.get(s) || [])
    if (
      (!extensionId || job.extensionId === extensionId) &&
      (!notebookId || job.notebookId === notebookId)
    )
      job.controller.abort();
}
function enqueue<T>(s: Storage, operation: () => Promise<T>) {
  const result = s.queue.then(() => {
    if (closed.has(s)) throw Error("知识库服务已关闭");
    return operation();
  });
  s.queue = result.catch(() => {});
  return result;
}
export async function runInstalledCommand(
  s: Storage,
  raw: Record<string, unknown>,
  download = safeDownload,
) {
  const prepared = await enqueue(s, () =>
    extensionCatalog(s, "runExtensionCommand", raw, { prepareScript: true }),
  );
  if (prepared?.kind !== "script-plan") return prepared;
  const plan = prepared as ScriptPlan;
  try {
    const host =
      plan.asyncSearch || plan.networkRequests
        ? {
            requests: plan.asyncSearch ?? [],
            networkRequests: plan.networkRequests,
            request: async (id: string) => {
              const check = () =>
                enqueue(s, async () => {
                  if (plan.controller.signal.aborted)
                    throw Error("扩展执行已撤销");
                  return (await extensionCatalog(
                    s,
                    "runExtensionCommand",
                    raw,
                    {
                      networkRequestId: id,
                      searchContextSeq: plan.searchContextSeq,
                    },
                  )) as ScriptNetworkRequest;
                });
              const declared = await check();
              const result = await downloadScriptNetwork(
                declared,
                plan.controller.signal,
                download,
              );
              await check();
              return result;
            },
            search: (queryId: string) =>
              enqueue(s, async () => {
                if (plan.controller.signal.aborted)
                  throw Error("扩展执行已撤销");
                return (await extensionCatalog(s, "runExtensionCommand", raw, {
                  searchContextSeq: plan.searchContextSeq,
                  searchRequestId: queryId,
                })) as ScriptSearchContext;
              }),
          }
        : undefined;
    const output =
      plan.stateRevision === undefined
        ? {
            body: await runMarkdownTransform(
              plan.source,
              plan.input,
              plan.controller.signal,
              host,
            ),
          }
        : await runStatefulMarkdownTransform(
            plan.source,
            plan.input as StatefulMarkdownTransformInput,
            plan.controller.signal,
            host,
          );
    return await enqueue(s, () => {
      if (plan.controller.signal.aborted) throw Error("扩展执行已撤销");
      return extensionCatalog(s, "runExtensionCommand", raw, {
        scriptBody: output.body,
        ...(plan.searchContextSeq !== undefined
          ? { searchContextSeq: plan.searchContextSeq }
          : {}),
        ...(plan.settingsRevision !== undefined
          ? { settingsRevision: plan.settingsRevision }
          : {}),
        ...("state" in output
          ? {
              scriptState: {
                value: output.state,
                expectedRevision: plan.stateRevision!,
              },
            }
          : {}),
      });
    });
  } finally {
    plan.controller.abort();
    const jobs = running.get(s);
    for (const job of jobs || [])
      if (job.controller === plan.controller) jobs!.delete(job);
  }
}
