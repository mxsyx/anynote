import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import {
  createProcessExtensionHost,
  bundledExtensions,
} from "@anynote/extension-host";
import { launchNodeExtension } from "@anynote/extension-host/node.js";
import { hostedRequest } from "@anynote/extension-host/rpc.js";

async function setup(
  t,
  source,
  permissions = ["notes:write"],
  timeoutMs = 2000,
) {
  const root = mkdtempSync(join(tmpdir(), "anynote-host-"));
  const storage = new Storage(join(root, "books"));
  const book = await storage.run("createNotebook", { title: "宿主验收" });
  const other = await storage.run("createNotebook", { title: "隔离 Notebook" });
  const extension = source
    ? {
        manifest: {
          id: "anynote.host-fixture",
          name: "测试",
          version: "0.1.0",
          runtime: "trusted-first-party",
          permissions,
          commands: [{ id: "anynote.host-fixture.run", title: "测试" }],
        },
        entry: join(root, "extension.mjs"),
      }
    : bundledExtensions[0];
  if (source) writeFileSync(extension.entry, source(root));
  let launches = 0;
  const host = createProcessExtensionHost({
    storage,
    extensions: [extension],
    timeoutMs,
    launch(entry) {
      launches++;
      return launchNodeExtension(entry);
    },
  });
  const input = {
    notebookId: book.id,
    extensionId: extension.manifest.id,
    commandId: extension.manifest.commands[0].id,
  };
  t.onTestFinished(async () => {
    host.dispose();
    await delay(200);
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    storage,
    book,
    other,
    host,
    input,
    extension,
    launches: () => launches,
    enable: (notebookId = book.id) =>
      host.configure({
        notebookId,
        extensionId: extension.manifest.id,
        enabled: true,
      }),
    disable: () =>
      host.configure({
        notebookId: book.id,
        extensionId: extension.manifest.id,
        enabled: false,
      }),
  };
}

test("首方宿主按命令惰性激活、复用进程并限定 Notebook；授权不会自动扩散", async (t) => {
  const s = await setup(t);
  await assert.rejects(s.host.execute(s.input), /授权/);
  await s.enable();
  assert.equal(s.launches(), 0);
  assert.equal((await s.host.list(s.book.id))[0].state, "idle");
  const note = await s.host.execute(s.input);
  assert.equal(note.title, "阅读记录");
  assert.match(note.body, /关键观点/);
  await s.host.execute(s.input);
  assert.equal(s.launches(), 1);
  assert.equal((await s.host.list(s.book.id))[0].state, "active");
  assert.equal(
    (await s.storage.run("listNodes", { notebookId: s.other.id })).length,
    0,
  );
  await assert.rejects(
    s.host.execute({ ...s.input, notebookId: s.other.id }),
    /授权/,
  );
  await s.enable(s.other.id);
  await s.host.execute({ ...s.input, notebookId: s.other.id });
  assert.equal(s.launches(), 2);
  await s.disable();
  assert.equal((await s.host.list(s.book.id))[0].state, "disabled");
  assert.equal(
    (await s.storage.run("listNodes", { notebookId: s.book.id })).length,
    2,
  );
  await assert.rejects(s.host.execute(s.input), /授权/);
});

test("下载清单、任意入口与额外授权字段不能进入首方执行等级", async (t) => {
  const s = await setup(t);
  await assert.rejects(
    s.host.configure({
      notebookId: s.book.id,
      extensionId: "third.party",
      enabled: true,
    }),
    /首方清单/,
  );
  await assert.rejects(
    s.host.configure({
      notebookId: s.book.id,
      extensionId: s.extension.manifest.id,
      enabled: true,
      entry: "/tmp/plugin.js",
    }),
    /unrecognized_keys/,
  );
  assert.throws(
    () =>
      hostedRequest(s.host, "listHostedExtensions", {
        notebookId: s.book.id,
        path: "/tmp",
      }),
    /unrecognized_keys/,
  );
  await s.enable();
  await assert.rejects(
    s.host.execute({ ...s.input, commandId: "anynote.other.run" }),
    /未声明/,
  );
  assert.equal(s.launches(), 0);
});

test("跨进程 SDK 拒绝越权、跨 Notebook 参数、原始存储操作", async (t) => {
  const s = await setup(
    t,
    () => `export function activate({api,registerCommand}) {
    return registerCommand("anynote.host-fixture.run", async input=>{
      if(input.mode==="read")return api.notes.get(input.id);
      return api.notes.create(input);
    });
  }`,
  );
  await s.enable();
  await assert.rejects(
    s.host.execute({ ...s.input, input: { mode: "read", id: randomUUID() } }),
    /权限/,
  );
  await assert.rejects(
    s.host.execute({
      ...s.input,
      input: { title: "越界", notebookId: s.other.id },
    }),
    /unrecognized_keys/,
  );
  await assert.rejects(
    s.host.execute({
      ...s.input,
      input: { title: "越界", path: "/tmp", op: "listNotebooks" },
    }),
    /unrecognized_keys/,
  );
  assert.equal(
    (await s.storage.run("listNodes", { notebookId: s.book.id })).length,
    0,
  );
});

test("激活失败清理命令和进程，重新授权后可恢复", async (t) => {
  const s = await setup(
    t,
    () => `export function activate({registerCommand}) {
    registerCommand("anynote.host-fixture.run",()=>null);throw Error("激活失败");
  }`,
  );
  await s.enable();
  await assert.rejects(s.host.execute(s.input), /激活失败/);
  assert.equal((await s.host.list(s.book.id))[0].state, "failed");
  await delay(150);
  writeFileSync(
    s.extension.entry,
    `export function activate({registerCommand}) {return registerCommand("anynote.host-fixture.run",()=>"恢复");}`,
  );
  await s.enable();
  assert.equal(await s.host.execute(s.input), "恢复");
});

test("无限循环只终止扩展进程；其他 Notebook 存储和宿主仍可使用", async (t) => {
  const s = await setup(
    t,
    () =>
      `process.on("SIGTERM",()=>{}); export function activate({registerCommand}) {return registerCommand("anynote.host-fixture.run",()=>{while(true){}});}`,
    [],
    500,
  );
  await s.enable();
  await assert.rejects(s.host.execute(s.input), /超时/);
  assert.equal((await s.host.list(s.book.id))[0].state, "failed");
  const healthy = await s.storage.run("createNode", {
    notebookId: s.other.id,
    title: "仍可编辑",
  });
  assert.equal(healthy.title, "仍可编辑");
});

test("扩展崩溃拒绝等待中的命令并标记故障", async (t) => {
  const s = await setup(
    t,
    () =>
      `export function activate({registerCommand}) {return registerCommand("anynote.host-fixture.run",()=>process.exit(3));}`,
    [],
  );
  await s.enable();
  await assert.rejects(s.host.execute(s.input), /进程已退出/);
  await assert.rejects(s.host.execute(s.input), /重新授权/);
});

test("Notebook 撤权终止等待，运行清理钩子，迟到的回调无法再写入", async (t) => {
  const s = await setup(
    t,
    (root) => `import {writeFileSync} from "node:fs";
    export function activate({api,registerCommand}) {
      const dispose=registerCommand("anynote.host-fixture.run",()=>new Promise(resolve=>setTimeout(async()=>{
        try {resolve(await api.notes.create({title:"迟到写入"}));}catch{resolve(null);}
      },300)));
      return ()=>{dispose();writeFileSync(${JSON.stringify(join(root, "disposed"))},"done");};
    }`,
  );
  await s.enable();
  const result = s.host.execute(s.input);
  const rejection = assert.rejects(result, /停用/);
  for (let i = 0; i < 50; i++) {
    if ((await s.host.list(s.book.id))[0].state === "active") break;
    await delay(10);
  }
  s.host.revokeNotebook(s.book.id);
  await rejection;
  await delay(350);
  assert.ok(existsSync(join(s.root, "disposed")));
  assert.equal(
    (await s.storage.run("listNodes", { notebookId: s.book.id })).length,
    0,
  );
});

test("停用与激活并发时撤销能力，延迟返回 disposer 只清理一次", async () => {
  const { createExtensionHost } = await import(
    "../.build/packages/plugin-sdk/host.js"
  );
  const manifest = bundledExtensions[0].manifest;
  const host = createExtensionHost(
    { run: async () => null },
    { trustedIds: [manifest.id] },
  );
  let finish,
    cleaned = 0;
  const pending = host.activate(
    { ...manifest, commands: undefined },
    { notebookId: randomUUID(), permissions: manifest.permissions },
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  // The strict facade intentionally excludes contribution metadata.
  await assert.rejects(pending, /unrecognized_keys/);
  const { commands: _commands, ...base } = manifest;
  const activation = host.activate(
    base,
    { notebookId: randomUUID(), permissions: manifest.permissions },
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  host.dispose();
  finish(() => cleaned++);
  await assert.rejects(activation, /停用/);
  assert.equal(cleaned, 1);
});

test("Notebook 撤销覆盖未完成的授权校验", async () => {
  const notebookId = randomUUID();
  let release;
  const extension = bundledExtensions[0];
  const child = new EventEmitter();
  child.postMessage = () => {};
  child.kill = () => child.emit("exit");
  const host = createProcessExtensionHost({
    extensions: [extension],
    storage: {
      run: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
    launch: () => child,
    timeoutMs: 1000,
  });
  const authorization = host.configure({
    notebookId,
    extensionId: extension.manifest.id,
    enabled: true,
  });
  host.revokeNotebook(notebookId);
  release([]);
  await assert.rejects(authorization, /撤销/);
  host.dispose();
});

test("宿主拒绝异常进程消息，Notebook 之间的故障不传播", async () => {
  const children = [];
  const extension = bundledExtensions[0];
  const host = createProcessExtensionHost({
    extensions: [extension],
    storage: { run: async () => [] },
    timeoutMs: 1000,
    launch() {
      const child = new EventEmitter();
      child.postMessage = (message) => {
        if (message.kind === "activate")
          queueMicrotask(() => {
            child.emit("message", {
              kind: "register",
              id: extension.manifest.commands[0].id,
            });
            child.emit("message", {
              kind: "result",
              id: message.id,
              value: null,
            });
          });
        if (message.kind === "execute")
          queueMicrotask(() =>
            child.emit("message", {
              kind: "result",
              id: message.id,
              value: "healthy",
            }),
          );
        if (message.kind === "dispose") child.emit("exit");
      };
      child.kill = () => child.emit("exit");
      children.push(child);
      queueMicrotask(() => child.emit("message", { kind: "ready" }));
      return child;
    },
  });
  try {
    const inputs = [randomUUID(), randomUUID()].map((notebookId) => ({
      notebookId,
      extensionId: extension.manifest.id,
      commandId: extension.manifest.commands[0].id,
    }));
    for (const input of inputs) {
      await host.configure({
        notebookId: input.notebookId,
        extensionId: input.extensionId,
        enabled: true,
      });
      assert.equal(await host.execute(input), "healthy");
    }
    children[0].emit("message", {
      kind: "api",
      id: 1,
      method: "raw.sql",
      input: {},
    });
    // Unknown methods are rejected by the broker without dispatching Storage.
    await delay(5);
    children[0].emit("message", {
      kind: "register",
      id: "other.extension.escape",
    });
    assert.equal((await host.list(inputs[0].notebookId))[0].state, "failed");
    assert.equal(await host.execute(inputs[1]), "healthy");
    const listed = await host.list(inputs[1].notebookId);
    listed[0].commands.push({
      id: "anynote.reading-template.injected",
      title: "篡改",
    });
    await assert.rejects(
      host.execute({
        ...inputs[1],
        commandId: "anynote.reading-template.injected",
      }),
      /未声明/,
    );
  } finally {
    host.dispose();
  }
});

test("进程配额拒绝过量请求，停用释放配额", async () => {
  const extension = bundledExtensions[0];
  const host = createProcessExtensionHost({
    extensions: [extension],
    storage: { run: async () => [] },
    timeoutMs: 1000,
    launch() {
      const child = new EventEmitter();
      child.postMessage = (message) => {
        if (message.kind === "activate")
          queueMicrotask(() => {
            child.emit("message", {
              kind: "register",
              id: extension.manifest.commands[0].id,
            });
            child.emit("message", {
              kind: "result",
              id: message.id,
              value: null,
            });
          });
        if (message.kind === "execute")
          queueMicrotask(() =>
            child.emit("message", {
              kind: "result",
              id: message.id,
              value: null,
            }),
          );
        if (message.kind === "dispose") child.emit("exit");
      };
      child.kill = () => child.emit("exit");
      queueMicrotask(() => child.emit("message", { kind: "ready" }));
      return child;
    },
  });
  const inputs = Array.from({ length: 5 }, () => ({
    notebookId: randomUUID(),
    extensionId: extension.manifest.id,
    commandId: extension.manifest.commands[0].id,
  }));
  try {
    for (const input of inputs)
      await host.configure({
        notebookId: input.notebookId,
        extensionId: input.extensionId,
        enabled: true,
      });
    for (const input of inputs.slice(0, 4)) await host.execute(input);
    await assert.rejects(host.execute(inputs[4]), /进程达到上限/);
    await host.configure({
      notebookId: inputs[0].notebookId,
      extensionId: extension.manifest.id,
      enabled: false,
    });
    await host.execute(inputs[4]);
  } finally {
    host.dispose();
  }
});

test("旧会话迟到的 API 序列化失败不能关闭重新授权的新会话", async () => {
  const extension = bundledExtensions[0];
  const children = [];
  let release;
  const host = createProcessExtensionHost({
    extensions: [extension],
    storage: {
      run: async (op) => {
        if (op === "createNode")
          return new Promise((resolve) => {
            release = resolve;
          });
        return [];
      },
    },
    launch() {
      const child = new EventEmitter();
      child.postMessage = (message) => {
        if (message.kind === "activate")
          queueMicrotask(() => {
            child.emit("message", {
              kind: "register",
              id: extension.manifest.commands[0].id,
            });
            child.emit("message", {
              kind: "result",
              id: message.id,
              value: null,
            });
          });
        if (message.kind === "execute")
          queueMicrotask(() =>
            child.emit("message", {
              kind: "result",
              id: message.id,
              value: "new session",
            }),
          );
        if (message.kind === "dispose") child.emit("exit");
      };
      child.kill = () => child.emit("exit");
      children.push(child);
      queueMicrotask(() => child.emit("message", { kind: "ready" }));
      return child;
    },
  });
  const input = {
    notebookId: randomUUID(),
    extensionId: extension.manifest.id,
    commandId: extension.manifest.commands[0].id,
  };
  try {
    await host.configure({
      notebookId: input.notebookId,
      extensionId: input.extensionId,
      enabled: true,
    });
    await host.execute(input);
    children[0].emit("message", {
      kind: "api",
      id: 1,
      method: "notes.create",
      input: { title: "in flight" },
    });
    await host.configure({
      notebookId: input.notebookId,
      extensionId: input.extensionId,
      enabled: false,
    });
    await host.configure({
      notebookId: input.notebookId,
      extensionId: input.extensionId,
      enabled: true,
    });
    assert.equal(await host.execute(input), "new session");
    const circular = {};
    circular.self = circular;
    release(circular);
    await delay(5);
    assert.equal((await host.list(input.notebookId))[0].state, "active");
    assert.equal(await host.execute(input), "new session");
  } finally {
    host.dispose();
  }
});
