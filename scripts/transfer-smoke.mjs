import { chromium, _electron } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const desktop = process.argv.includes("--desktop");
const root = desktop
  ? mkdtempSync(join(tmpdir(), "anynote-transfer-desktop-"))
  : null;
let app;
const browser = desktop
  ? null
  : await chromium.launch({
      executablePath: process.env.ANYNOTE_BROWSER || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
if (desktop)
  app = await _electron.launch({
    executablePath: resolve(
      process.env.ANYNOTE_EXECUTABLE || "node_modules/electron/dist/electron",
    ),
    args: process.env.ANYNOTE_EXECUTABLE
      ? ["--no-sandbox"]
      : ["--no-sandbox", "."],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "",
      ANYNOTE_DEV: "",
      ANYNOTE_USER_DATA_DIR: root,
    },
  });
const page = desktop
    ? await app.firstWindow()
    : await browser.newPage({ viewport: { width: 1440, height: 960 } }),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const rpc = (op, input = {}) =>
  page.evaluate(
    async ({ op, input }) => {
      if (window.anynote) return window.anynote.request(op, input);
      const r = await (
        await fetch("/api/rpc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ op, input }),
        })
      ).json();
      if (r.error) throw Error(r.error);
      return r.result;
    },
    { op, input },
  );
try {
  if (!desktop) await page.goto("http://127.0.0.1:5173");
  await page.getByRole("textbox", { name: "笔记标题" }).waitFor();
  const suffix = Date.now(),
    a = await rpc("createNotebook", { title: "跨库源 " + suffix }),
    b = await rpc("createNotebook", { title: "跨库目标 " + suffix });
  const f = await rpc("createNode", {
      notebookId: a.id,
      kind: "folder",
      title: "跨库目录 " + suffix,
    }),
    n = await rpc("createNode", {
      notebookId: a.id,
      parentId: f.id,
      title: "跨库正文 " + suffix,
      body: '未知块与原文\n:::anynote{type="future.custom" version="9"}\n{"keep":true}\n:::\n',
    }),
    destFolder = await rpc("createNode", {
      notebookId: b.id,
      kind: "folder",
      title: "接收目录",
    });
  await page.reload();
  await page.locator(".notebook-switch").click();
  await page
    .locator(".book-popover")
    .getByRole("button", { name: a.name, exact: true })
    .click();
  await page
    .getByRole("button", { name: f.title + "操作", exact: true })
    .click();
  await page
    .getByRole("button", { name: "复制到其他 Notebook", exact: true })
    .click();
  let dialog = page.getByRole("dialog", { name: "跨 Notebook 操作" });
  await dialog.getByLabel("目标 Notebook").selectOption(b.id);
  await dialog.getByLabel("目标目录").selectOption(destFolder.id);
  await dialog.getByRole("button", { name: "复制", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  let copied = (await rpc("listNodes", { notebookId: b.id })).find(
    (x) => x.title === f.title,
  );
  assert.equal(copied.parent_id, destFolder.id);
  assert.equal(
    (await rpc("listNodes", { notebookId: a.id })).find((x) => x.id === f.id)
      .deleted_at,
    null,
  );
  if (
    !(await page
      .getByRole("button", { name: n.title, exact: true })
      .isVisible())
  )
    await page.getByRole("button", { name: f.title, exact: true }).click();
  await page.getByRole("button", { name: n.title, exact: true }).click();
  await page.getByRole("button", { name: "源码", exact: true }).click();
  await page.locator(".cm-content").fill("跨库前未保存的最新草稿");
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
  await page
    .getByRole("button", { name: "移动到其他 Notebook", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "跨 Notebook 操作" });
  await dialog.getByLabel("目标 Notebook").selectOption(b.id);
  await dialog.getByRole("button", { name: "移动", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const moved = (await rpc("listNodes", { notebookId: b.id })).find(
    (x) => x.title === n.title && x.parent_id === null,
  );
  assert.ok(moved);
  assert.equal(
    (await rpc("getNote", { notebookId: b.id, id: moved.id })).body,
    "跨库前未保存的最新草稿",
  );
  assert.ok(
    (await rpc("listNodes", { notebookId: a.id })).find((x) => x.id === n.id)
      .deleted_at,
  );
  await rpc("restoreNode", { notebookId: a.id, id: n.id });
  assert.equal(
    (await rpc("getNote", { notebookId: a.id, id: n.id })).body,
    "跨库前未保存的最新草稿",
  );
  assert.deepEqual(errors, []);
  console.log(
    "Cross-Notebook UI passed: folder copy to selected directory, pending editor save, note move and source recycle recovery.",
  );
} finally {
  if (app) await app.close();
  if (browser) await browser.close();
  if (root) rmSync(root, { recursive: true, force: true });
}
