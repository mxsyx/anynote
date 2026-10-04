import { parentPort, workerData } from "node:worker_threads";
import { getQuickJS } from "quickjs-emscripten";
import { validateScriptState } from "./script-state.js";
import type {
  MarkdownTransformInput,
  ScriptAsyncSearchRequest,
  ScriptNetworkRequest,
} from "./declarative.js";
// Only this trusted wrapper runs in Node. Guest code is evaluated inside WASM,
// with declared JSON capability bridges; no module loader, files or direct network bindings.
const data = workerData as {
  script: string;
  input: MarkdownTransformInput;
  stateful?: boolean;
  asyncSearch?: ScriptAsyncSearchRequest[];
  networkRequests?: ScriptNetworkRequest[];
};
try {
  const quickJS = await getQuickJS(),
    runtime = quickJS.newRuntime();
  runtime.setMemoryLimit(64 * 1024 ** 2);
  runtime.setMaxStackSize(256 * 1024);
  let remainingMs = 250,
    sliceStart = performance.now();
  runtime.setInterruptHandler(
    () => performance.now() - sliceStart > remainingMs,
  );
  const charge = <T>(fn: () => T): T => {
    sliceStart = performance.now();
    try {
      return fn();
    } finally {
      remainingMs -= performance.now() - sliceStart;
    }
  };
  const context = runtime.newContext();
  let alive = true,
    fatal = "",
    calls = 0;
  const pending = new Map<number, ReturnType<typeof context.newPromise>>();
  const receive = (message: unknown) => {
    if (!alive || !message || typeof message !== "object") return;
    const result = message as {
      kind?: string;
      sequence?: number;
      value?: unknown;
    };
    if (result.kind !== "host-search-result") return;
    const promise = pending.get(result.sequence!);
    if (!promise) {
      fatal = "异步搜索响应无效";
      return;
    }
    const value = context.newString(JSON.stringify(result.value));
    try {
      charge(() => promise.resolve(value));
    } finally {
      value.dispose();
      promise.dispose();
      pending.delete(result.sequence!);
    }
  };
  parentPort!.on("message", receive);
  try {
    for (const [name, declarations, kind] of [
      ["search", data.asyncSearch, "host-search"],
      ["request", data.networkRequests, "host-network"],
    ] as const) {
      if (!declarations) continue;
      const bridge = context.newFunction(name, (queryId) => {
        if (
          !queryId ||
          context.typeof(queryId) !== "string" ||
          pending.size ||
          calls >= 4
        ) {
          fatal = "异步宿主参数、并发或调用次数超限";
          return { error: context.newError(fatal) };
        }
        const id = context.getString(queryId);
        if (!declarations.some((r) => r.id === id)) {
          fatal = "异步宿主请求未声明";
          return { error: context.newError(fatal) };
        }
        const promise = context.newPromise(),
          sequence = ++calls;
        pending.set(sequence, promise);
        parentPort!.postMessage({ kind, sequence, queryId: id });
        return promise.handle;
      });
      context.setProp(context.global, "__anynote" + name, bridge);
      bridge.dispose();
    }
    const input = JSON.stringify(JSON.stringify(data.input));
    // Capture intrinsics before executing guest code. Serialize JSON ourselves so
    // guest toJSON hooks, accessors and prototype mutations cannot alter the envelope.
    const result = charge(() =>
      context.evalCode(
        `${data.asyncSearch || data.networkRequests ? "(async()=>{" : "(()=>{"}"use strict";
        const stringify=JSON.stringify, keys=Reflect.ownKeys, descriptor=Object.getOwnPropertyDescriptor,
          prototype=Object.getPrototypeOf, plain=Object.prototype, isArray=Array.isArray, finite=Number.isFinite, string=String, own=Object.hasOwn;
        const parse=JSON.parse, search=globalThis.__anynotesearch, request=globalThis.__anynoterequest;
        delete globalThis.__anynotesearch;delete globalThis.__anynoterequest;
        const host=${Boolean(data.asyncSearch || data.networkRequests)}?Object.freeze({
          ...(${Boolean(data.asyncSearch)}?{search:async(id)=>parse(await search(id))}:{}),
          ...(${Boolean(data.networkRequests)}?{request:async(id)=>parse(await request(id))}:{}),
        }):undefined;
        const input=Object.freeze(parse(${input}));
        let nodes=0;
        function encode(value,depth){
          if(++nodes>4096||depth>16)throw Error("状态结构超限");
          if(value===null||typeof value==="string"||typeof value==="boolean")return stringify(value);
          if(typeof value==="number"&&finite(value))return stringify(value);
          if(typeof value!=="object"||!value)throw Error("状态必须是 JSON 数据");
          const array=isArray(value);
          if(!array&&prototype(value)!==plain)throw Error("状态必须是普通对象");
          let text=array?"[":"{", count=0;
          const fields=keys(value);
          for(let i=0;i<fields.length;i++){
            const key=fields[i];
            if(array&&key==="length")continue;
            const field=descriptor(value,key);
            if(typeof key!=="string"||!field.enumerable||!own(field,"value"))throw Error("不能使用访问器或符号");
            if(array&&key!==string(count))throw Error("数组必须连续");
            text+=(count++?",":"")+(array?"":stringify(key)+":")+encode(field.value,depth+1);
          }
          if(array&&count!==value.length)throw Error("数组必须连续");
          return text+(array?"]":"}");
        }
        const transform=(${data.script});
        if(typeof transform!=="function")throw Error("转换入口不是函数");
        const output=${data.asyncSearch || data.networkRequests ? "await " : ""}transform(input,host);
        if(!${Boolean(data.stateful)})return output;
        if(!output||typeof output!=="object"||isArray(output)||prototype(output)!==plain)throw Error("必须返回正文与状态");
        const fields=keys(output),body=descriptor(output,"body"),state=descriptor(output,"state");
        if(fields.length!==2||!body||!state||!body.enumerable||!state.enumerable||!own(body,"value")||!own(state,"value")||typeof body.value!=="string")throw Error("输出字段无效");
        if(!state.value||typeof state.value!=="object"||isArray(state.value))throw Error("状态必须是对象");
        return '{"body":'+stringify(body.value)+',"state":'+encode(state.value,0)+'}';
      })()`,
        "extension-transform.js",
      ),
    );
    if (result.error) {
      result.error.dispose();
      throw Error("脚本执行失败或超出 CPU/内存预算");
    }
    let outputHandle = result.value;
    try {
      if (data.asyncSearch || data.networkRequests) {
        while (true) {
          if (fatal) throw Error(fatal);
          if (remainingMs <= 0) throw Error("脚本超出执行预算");
          const jobs = charge(() => runtime.executePendingJobs(16));
          if (jobs.error) {
            jobs.error.dispose();
            throw Error("异步脚本执行失败或超出预算");
          }
          const state = context.getPromiseState(result.value);
          if (state.type === "fulfilled") {
            outputHandle = state.value;
            break;
          }
          if (state.type === "rejected") {
            state.error.dispose();
            throw Error(fatal || "异步脚本执行失败或超出预算");
          }
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      }
      if (fatal || pending.size)
        throw Error(fatal || "脚本结束前必须等待异步搜索完成");
      if (context.typeof(outputHandle) !== "string")
        throw Error("脚本结果必须是正文字符串");
      const text = context.getString(outputHandle);
      const output = data.stateful ? JSON.parse(text) : { body: text };
      const body = output.body;
      if (body.length > 2_000_000) throw Error("脚本正文超出 2MB 编辑预算");
      if (data.stateful) validateScriptState(output.state);
      parentPort!.postMessage({
        ok: true,
        body,
        ...(data.stateful ? { state: output.state } : {}),
      });
    } finally {
      if (outputHandle !== result.value) outputHandle.dispose();
      result.value.dispose();
    }
  } finally {
    alive = false;
    parentPort!.off("message", receive);
    for (const promise of pending.values()) promise.dispose();
    pending.clear();
    context.dispose();
    runtime.dispose();
  }
} catch (e) {
  parentPort!.postMessage({ ok: false, error: (e as Error).message });
}
