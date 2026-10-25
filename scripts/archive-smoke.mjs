import { unzipSync } from "fflate";
import { putAssetFile } from "../.build/packages/storage-sqlite/assets.js";
import { openNotebook } from "./acceptance/open-notebook.mjs";
import { _electron } from "playwright";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  statSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomFillSync, randomUUID } from "node:crypto";
import { Storage } from "../.build/packages/backend/index.js";
const root = mkdtempSync(join(tmpdir(), "anynote-archive-desktop-")),
  archive = join(root, "desktop.anynote");
let app;
try {
  const s = new Storage(join(root, "notebooks")),
    book = await s.run("createNotebook", { title: "桌面流式归档" }),
    note = await s.run("createNode", {
      notebookId: book.id,
      title: "保真正文",
      body: ':::anynote{type="future.custom" version="99"}\n{"keep":true}\n:::\n',
    });
  await s.run("saveNote", {
    notebookId: book.id,
    id: note.id,
    expectedRevision: 1,
    body: note.body + "\n历史与中文资料",
    tags: ["流式"],
    favorite: true,
  });
  const trash = await s.run("createNode", {
    notebookId: book.id,
    title: "归档回收站",
  });
  await s.run("trashNode", { notebookId: book.id, id: trash.id });
  const chunk = Buffer.alloc(64 * 1024),
    digest = createHash("sha256"),
    temp = join(root, "asset.bin"),
    fd = openSync(temp, "w"),
    size = 112 * 1024 ** 2;
  try {
    for (let n = 0; n < size; n += chunk.length) {
      randomFillSync(chunk);
      writeSync(fd, chunk);
      digest.update(chunk);
    }
  } finally {
    closeSync(fd);
  }
  const hash = putAssetFile(s.open(book.id), temp, "application/octet-stream");
  assert.equal(hash, digest.digest("hex"));
  rmSync(temp);
  const resourceId = randomUUID();
  s.open(book.id)
    .prepare("INSERT INTO resources VALUES(?,?,?,1)")
    .run(resourceId, hash, "large.bin");
  await s.run("createNode", {
    notebookId: book.id,
    title: "大附件",
    body: `[附件](anynote-resource:${resourceId})`,
  });
  s.close();
  app = await _electron.launch({
    executablePath: process.env.ANYNOTE_EXECUTABLE
      ? resolve(process.env.ANYNOTE_EXECUTABLE)
      : undefined,
    args: process.env.ANYNOTE_EXECUTABLE
      ? ["--no-sandbox"]
      : [".", "--no-sandbox"],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "",
      ANYNOTE_DEV: "",
      ANYNOTE_USER_DATA_DIR: root,
    },
  });
  const page = await app.firstWindow(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openNotebook(page);
  await page
    .getByRole("textbox", { name: "笔记标题" })
    .waitFor({ timeout: 30000 });
  const rpc = (op, input = {}) =>
    page.evaluate(({ op, input }) => window.anynote.request(op, input), {
      op,
      input,
    });
  await assert.rejects(
    rpc("importArchiveFile", { path: archive }),
    /渲染器路径/,
  );
  await assert.rejects(
    rpc("exportArchiveFile", { notebookId: book.id, path: archive }),
    /请求无效/,
  );
  await assert.rejects(
    rpc("startExportArchiveFile", { notebookId: book.id, path: archive }),
    /未授权/,
  );
  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true });
  });
  assert.equal(await rpc("exportArchiveFile", { notebookId: book.id }), null);
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, archive);
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
  await page
    .getByRole("button", { name: "导出完整 Notebook", exact: true })
    .click();
  let dialog = page.getByRole("dialog", { name: "任务中心" });
  await dialog.waitFor();
  await dialog.getByText("Notebook 归档导出", { exact: true }).waitFor();
  const wait = async (type, id) => {
    for (let n = 0; n < 600; n++) {
      const j = (await rpc("listTasks")).find(
        (j) => j.type === type && (!id || j.id === id),
      );
      if (j && ["completed", "failed", "cancelled"].includes(j.status)) {
        assert.equal(j.status, "completed", j.error);
        return j;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error("归档任务超时");
  };
  const exported = await wait("archive-export");
  assert.ok(exported.totalBytes > 100 * 1024 ** 2);
  assert.ok(statSync(archive).size > 100 * 1024 ** 2);
  await dialog
    .getByText("完整 Notebook 已导出，包含历史与回收站", { exact: true })
    .waitFor();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await assert.rejects(
    rpc("exportMarkdownFile", { notebookId: book.id, path: archive }),
    /请求无效/,
  );
  await assert.rejects(
    rpc("startExportMarkdownFile", { notebookId: book.id, path: archive }),
    /未授权/,
  );
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu().getMenuItemById("settings").click(),
  );
  await page
    .getByRole("button", { name: "导出仅当前内容", exact: true })
    .waitFor();
  await page.getByText("各入口大小限制", { exact: true }).click();
  await page.getByText(/普通单文件导入 50 MiB/).waitFor();
  mkdirSync("tmp/reports", { recursive: true });
  await page.locator(".export-settings").scrollIntoViewIfNeeded();
  await page
    .locator(".export-settings")
    .screenshot({ path: "tmp/reports/g16-export-settings.png" });
  const currentFile = join(root, "current.anynote");
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, currentFile);
  await page
    .getByRole("button", { name: "导出仅当前内容", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "任务中心" });
  await dialog.waitFor();
  const currentJob = (await rpc("listTasks"))
    .filter((j) => j.type === "archive-export")
    .at(-1);
  await wait("archive-export", currentJob.id);
  const currentManifest = JSON.parse(
    Buffer.from(unzipSync(readFileSync(currentFile))["manifest.json"]),
  );
  assert.equal(currentManifest.includesHistory, false);
  assert.equal(currentManifest.includesTrash, false);
  assert.equal(
    (await rpc("history", { notebookId: book.id, id: note.id })).length,
    2,
  );
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  const markdownFile = join(root, "markdown.zip");
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, markdownFile);
  await page
    .getByRole("button", { name: "导出 Markdown ZIP", exact: true })
    .click();
  await dialog.waitFor();
  await wait("archive-markdown");
  assert.ok(statSync(markdownFile).size > 100 * 1024 ** 2);
  await dialog.getByText("Markdown 开放导出", { exact: true }).waitFor();
  await dialog
    .getByText(
      "Markdown 已导出；目录映射与能力损失见 EXPORT-MAP.json / EXPORT-REPORT.txt",
      { exact: true },
    )
    .waitFor();
  await page.screenshot({
    path: "tmp/reports/g16-export-task.png",
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  }, root);
  await page
    .getByRole("button", { name: "导出 Markdown 文件夹", exact: true })
    .click();
  await dialog.waitFor();
  const directoryJob = (await rpc("listTasks"))
    .filter((j) => j.type === "archive-markdown")
    .at(-1);
  await wait("archive-markdown", directoryJob.id);
  const directory = readdirSync(root).find((name) =>
    name.startsWith("Notebook-"),
  );
  assert.ok(
    readFileSync(join(root, directory, "EXPORT-REPORT.txt"), "utf8").includes(
      "future.custom@99",
    ),
  );
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, archive);
  await page.locator(".notebook-switch").click();
  await page
    .getByRole("button", { name: "导入 Notebook", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "任务中心" });
  await dialog.waitFor();
  const imported = await wait("archive-import");
  const restored = await rpc("getNote", {
    notebookId: imported.restoredId,
    id: note.id,
  });
  assert.ok(restored.body.includes('"keep":true'));
  assert.deepEqual(restored.tags, ["流式"]);
  assert.equal(restored.favorite, 1);
  assert.equal(
    (await rpc("history", { notebookId: imported.restoredId, id: note.id }))
      .length,
    2,
  );
  assert.ok(
    (await rpc("listNodes", { notebookId: imported.restoredId })).find(
      (n) => n.id === trash.id,
    ).deleted_at,
  );
  await dialog
    .getByRole("button", { name: "打开导入的 Notebook", exact: true })
    .click();
  await page
    .locator(".notebook-switch")
    .getByText("桌面流式归档（导入）", { exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  mkdirSync("tmp/reports", { recursive: true });
  writeFileSync(
    "tmp/reports/desktop-archive-acceptance.json",
    JSON.stringify(
      {
        format: "anynote.desktop-archive-acceptance.v1",
        checkedAt: new Date().toISOString(),
        status: "passed",
        entry: process.env.ANYNOTE_EXECUTABLE
          ? "linux-packaged"
          : "source-production",
        assetBytes: size,
        archiveBytes: statSync(archive).size,
        checks: [
          "renderer-path-rejection",
          "internal-operation-rejection",
          "native-dialog-cancel",
          "UI-export-over-100MB",
          "task-center-budget-and-completion",
          "UI-current-only-source-unchanged",
          "UI-Markdown-ZIP-over-100MiB",
          "UI-Markdown-directory-report",
          "entry-budget-hint",
          "UI-stream-import",
          "unknown-block-tags-favorite-history-trash",
          "open-imported-notebook",
        ],
        nativeDialogAutomation: "authorized-dialog-adapter",
        electron: await app.evaluate(() => process.versions.electron),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Desktop streaming archive passed: real 112MB export/import, native-dialog authorization bridge, task center, full fidelity and open imported Notebook.",
  );
} finally {
  if (app) await app.close();
  rmSync(root, { recursive: true, force: true });
}
