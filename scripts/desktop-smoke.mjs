import { _electron } from "playwright";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { DatabaseSync } from "node:sqlite";
const root = mkdtempSync(join(tmpdir(), "anynote-desktop-"));
let electron;
try {
  const source = new Storage(join(root, "external-source"));
  const external = await source.run("createNotebook", {
    title: "原目录知识库",
  });
  const externalNote = await source.run("createNode", {
    notebookId: external.id,
    title: "目录直开验证",
    kind: "note",
  });
  const externalPath = source.directory(external.id);
  source.close();
  electron = await _electron.launch({
    executablePath: process.env.ANYNOTE_EXECUTABLE,
    args: process.env.ANYNOTE_EXECUTABLE
      ? ["--no-sandbox"]
      : [".", "--no-sandbox"],
    env: {
      ...process.env,
      ANYNOTE_USER_DATA_DIR: root,
      ANYNOTE_DEV: "",
      ELECTRON_RUN_AS_NODE: "",
    },
  });
  const page = await electron.firstWindow();
  await page
    .getByRole("textbox", { name: "笔记标题" })
    .waitFor({ timeout: 30000 });
  assert.ok(await page.evaluate(() => !!window.anynote));
  const settings = await electron.evaluate(({ BrowserWindow }) => {
    const p =
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      sandbox: p.sandbox,
      nodeIntegration: p.nodeIntegration,
      contextIsolation: p.contextIsolation,
      node: process.versions.node,
    };
  });
  assert.equal(settings.sandbox, true);
  assert.equal(settings.nodeIntegration, false);
  assert.equal(settings.contextIsolation, true);
  await page.getByRole("button", { name: "新建笔记", exact: true }).click();
  await page.getByPlaceholder("输入一个名称…").fill("真实桌面测试");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page
    .locator(".cm-content")
    .fill("## Electron IPC\n\nSQLite 写入发生在独立存储进程。");
  await page.keyboard.press("Control+s");
  await page.getByText("已保存至本地", { exact: true }).waitFor();
  await page.getByRole("button", { name: "富文本 Beta", exact: true }).click();
  const richBlock = page
    .locator(".rich-block")
    .filter({ hasText: "SQLite 写入" });
  await richBlock.hover();
  await richBlock
    .getByRole("button", { name: "编辑此块", exact: true })
    .click();
  await page.locator(".rich-input").fill("桌面富文本写入独立存储进程。");
  await page.getByRole("button", { name: "完成此块", exact: true }).click();
  await page.keyboard.press("Control+s");
  await page.getByText("已保存至本地", { exact: true }).waitFor();
  const richBody = await page.evaluate(async () => {
    const book = (await window.anynote.request("listNotebooks"))[0];
    const note = (
      await window.anynote.request("listNodes", { notebookId: book.id })
    ).find((n) => n.title === "真实桌面测试");
    return (
      await window.anynote.request("getNote", {
        notebookId: book.id,
        id: note.id,
      })
    ).body;
  });
  assert.equal(richBody, "## Electron IPC\n\n桌面富文本写入独立存储进程。");
  await page
    .getByRole("button", { name: "本地优先，安心记录", exact: false })
    .click();
  await page.getByRole("button", { name: "创建快照", exact: true }).click();
  await page.getByText("本地快照已完成并校验", { exact: true }).waitFor();
  const imported = await page.evaluate(async () => {
    const request = (op, input = {}) => window.anynote.request(op, input);
    const book = (await request("listNotebooks"))[0];
    const task = await request("startImport", {
      notebookId: book.id,
      html: '<html><body><h1>桌面后台导入</h1><p>真实 Utility Process</p><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII="></body></html>',
      mode: "page",
    });
    for (let i = 0; i < 300; i++) {
      const job = (await request("listTasks")).find((j) => j.id === task.id);
      if (job.status === "failed") throw Error(job.error);
      if (job.status === "completed") {
        const assetId = job.note.body.match(
          /anynote-resource:([a-f0-9-]{36})/,
        )[1];
        const asset = await request("getAsset", {
          notebookId: book.id,
          id: assetId,
          noteId: job.note.id,
        });
        return {
          title: job.note.title,
          mime: asset.mime,
          localized: job.report.localized,
        };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error("后台导入超时");
  });
  assert.equal(imported.mime, "image/png");
  assert.equal(imported.localized, 1);
  await page
    .locator(".tree-main")
    .filter({ hasText: "真实桌面测试" })
    .first()
    .click();
  await page.getByRole("button", { name: "阅读", exact: true }).click();
  await page.getByRole("button", { name: "插入白板", exact: true }).click();
  await page.locator(".excalidraw canvas").first().waitFor({ timeout: 45000 });
  const canvasBox = await page
    .locator(".excalidraw canvas")
    .first()
    .boundingBox();
  await page.keyboard.press("r");
  await page.mouse.move(canvasBox.x + 300, canvasBox.y + 250);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 490, canvasBox.y + 365, { steps: 8 });
  await page.mouse.up();
  await page.getByRole("button", { name: "保存白板", exact: true }).click();
  await page
    .getByRole("dialog", { name: "白板编辑器" })
    .waitFor({ state: "hidden", timeout: 20000 });
  await page.getByAltText("白板预览", { exact: true }).waitFor();
  const denied = await page.evaluate(async () => {
    try {
      await window.anynote.request("openNotebookDirectory", { path: "/tmp" });
    } catch (e) {
      return e.message;
    }
  });
  assert.match(denied, /渲染器路径/);
  await electron.evaluate(({ dialog }, path) => {
    // Isolated test fixture supplied by the native-dialog adapter; the renderer
    // never sends a disk path through the public operation.
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, externalPath);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("button", { name: "打开 Notebook 目录", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('input[aria-label="笔记标题"]')?.value ===
      "目录直开验证",
  );
  await page.getByText("外部 Notebook", { exact: true }).first().waitFor();
  await page.getByRole("button", { name: "源码", exact: true }).click();
  await page.locator(".cm-content").fill("# 原目录中的桌面修改");
  await page.keyboard.press("Control+s");
  await page.getByText("已保存至本地", { exact: true }).waitFor();
  assert.equal(existsSync(join(root, "notebooks", external.id)), false);
  const originalDb = new DatabaseSync(join(externalPath, "notebook.sqlite"), {
    readOnly: true,
  });
  try {
    assert.equal(
      originalDb
        .prepare(
          "SELECT r.body FROM notes n JOIN note_revisions r ON r.id=n.head_revision_id WHERE n.node_id=?",
        )
        .get(externalNote.id).body,
      "# 原目录中的桌面修改",
    );
  } finally {
    originalDb.close();
  }
  await page.getByRole("button", { name: "搜索笔记", exact: true }).click();
  await page.getByLabel("搜索范围", { exact: true }).selectOption("all");
  await page.getByPlaceholder("寻找一个想法，或一篇笔记…").fill("桌面富文本");
  await page
    .locator(".command-results > button")
    .filter({ hasText: "真实桌面测试" })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('input[aria-label="笔记标题"]')?.value ===
      "真实桌面测试",
  );
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("button", { name: "移出工作区：原目录知识库", exact: true })
    .click();
  await page.getByText("已移出工作区，原目录保留", { exact: true }).waitFor();
  const reopened = new Storage(join(root, "reopen-check"));
  try {
    assert.equal(
      (await reopened.run("registerNotebookDirectory", { path: externalPath }))
        .id,
      external.id,
    );
  } finally {
    reopened.close();
  }
  console.log(
    "Desktop smoke passed: production assets, sandbox settings, preload API, SQLite Utility Process, rich block editing, save, snapshot, isolated HTML worker, assets, offline whiteboard, authorized directory opening, in-place writes, global search/navigation and detach. Node " +
      settings.node,
  );
} finally {
  await electron?.close();
  rmSync(root, { recursive: true, force: true });
}
