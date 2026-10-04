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
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomFillSync } from "node:crypto";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
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
  const hash = digest.digest("hex"),
    path = `assets/sha256/${hash.slice(0, 2)}/${hash}.bin`;
  mkdirSync(dirname(s.notebookPath(book.id, path)), { recursive: true });
  const { renameSync } = await import("node:fs");
  renameSync(temp, s.notebookPath(book.id, path));
  s.open(book.id)
    .prepare("INSERT INTO assets VALUES(?,?,?,?)")
    .run(hash, size, "application/octet-stream", path);
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
  const wait = async (type) => {
    for (let n = 0; n < 600; n++) {
      const j = (await rpc("listTasks")).find((j) => j.type === type);
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
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/desktop-archive-acceptance.json",
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
