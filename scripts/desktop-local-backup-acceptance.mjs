import { putAsset } from "../.build/packages/storage-sqlite/assets.js";
import { LocalBackupService } from "../.build/packages/backup-local/index.js";
import { appMenu } from "./acceptance/app-menu.mjs";
import { openNotebook } from "./acceptance/open-notebook.mjs";
import { _electron } from "playwright";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { inspectFilesystem } from "../.build/packages/backup-local/index.js";
const args = process.argv.slice(2);
if (args.includes("--scale")) {
  const { localBackupScale } = await import(
    "./acceptance/local-backup-scale.mjs"
  );
  await localBackupScale(args);
  process.exit(0);
}
const option = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  if (!args[i + 1] || args[i + 1].startsWith("--"))
    throw Error(`${name} 需要参数`);
  return args[i + 1];
};
const root = mkdtempSync(
  join(resolve(option("--base-dir") || tmpdir()), "anynote-local-desktop-"),
);
const disk = join(root, "disk");
mkdirSync(disk);
const checks = [];
let electron, page, filesystem;
const reportPath = resolve(
  option("--report-path") || "artifacts/local-backup-acceptance.json",
);
async function check(name, fn) {
  await fn();
  checks.push(name);
  console.log(`PASS ${name}`);
}
async function request(op, input = {}) {
  return page.evaluate(({ op, input }) => window.anynote.request(op, input), {
    op,
    input,
  });
}
async function eventually(fn, timeout = 30000) {
  const end = Date.now() + timeout;
  do {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < end);
  throw Error("等待验收状态超时");
}
async function job(id) {
  return eventually(async () => {
    const [j] = await request("listTasks", { id });
    return j && !["running", "committing"].includes(j.status) ? j : null;
  });
}
async function dialogs(
  selectionCancelled = false,
  confirmationCancelled = false,
) {
  await electron.evaluate(
    ({ dialog }, fixture) => {
      globalThis.localBackupDialogCalls = [];
      dialog.showOpenDialog = async (_win, options) => {
        globalThis.localBackupDialogCalls.push({ kind: "select", options });
        return {
          canceled: fixture.selectionCancelled,
          filePaths: fixture.selectionCancelled ? [] : [fixture.disk],
        };
      };
      dialog.showMessageBox = async (_win, options) => {
        globalThis.localBackupDialogCalls.push({ kind: "confirm", options });
        return { response: fixture.confirmationCancelled ? 1 : 0 };
      };
    },
    { disk, selectionCancelled, confirmationCancelled },
  );
}
try {
  filesystem = await inspectFilesystem(root);
  if (option("--require-filesystem"))
    assert.equal(filesystem.filesystem, option("--require-filesystem"));
  const storage = new Storage(join(root, "notebooks"));
  const first = await storage.run("createNotebook", { title: "桌面备份主库" });
  const second = await storage.run("createNotebook", { title: "桌面备份次库" });
  const note = await storage.run("createNode", {
    notebookId: first.id,
    kind: "note",
    title: "本地备份验收正文",
    body: "# 备份正文\n\n原始内容",
  });
  const secondSource = storage.directory(second.id);
  for (let i = 0; i < 30; i++) {
    const bytes = randomBytes(256 * 1024),
      db = storage.open(first.id);
    const hash = putAsset(db, bytes, "application/octet-stream");
    db.prepare(
      "INSERT INTO resources(id,asset_hash,original_name) VALUES(?,?,?)",
    ).run(randomUUID(), hash, `attachment-${i}`);
  }
  storage.close();
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
  page = await electron.firstWindow();
  await openNotebook(page);
  page.setDefaultTimeout(20000);
  await page.locator(".notebook-switch").waitFor({ timeout: 30000 });
  const navigateSource = async () => {
    // The Notebook selector is an ordinary visible UI control.
    await page.locator(".notebook-switch").click();
    await page
      .locator(".book-popover")
      .getByRole("button", { name: first.name, exact: true })
      .click();
    await page
      .locator(".tree-main")
      .filter({ hasText: note.title })
      .first()
      .click();
  };
  await navigateSource();
  const backupPage = () => appMenu(page, "backup", electron);
  await backupPage();
  const local = page.getByRole("region", { name: "本地磁盘备份", exact: true });
  const add = local.getByRole("button", { name: "添加目标磁盘", exact: true });
  await check(
    "native-selection-and-confirmation-cancel-without-initializing",
    async () => {
      for (const mode of [
        [true, false],
        [false, true],
      ]) {
        await dialogs(...mode);
        await add.click();
        await eventually(() =>
          electron.evaluate(
            (_electron, expected) =>
              globalThis.localBackupDialogCalls.length === expected,
            mode[0] ? 1 : 2,
          ),
        );
        await eventually(async () => !(await add.isDisabled()));
        assert.equal((await request("listLocalBackupTargets")).length, 0);
        assert.equal(existsSync(join(disk, "AnynoteBackup")), false);
      }
    },
  );
  await check(
    "authorized-native-initialization-and-renderer-path-rejection",
    async () => {
      await dialogs();
      await add.click();
      await eventually(
        async () => (await request("listLocalBackupTargets")).length === 1,
      );
      await local
        .getByRole("button", { name: "立即备份", exact: true })
        .waitFor();
      const calls = await electron.evaluate(
        () => globalThis.localBackupDialogCalls,
      );
      assert.deepEqual(
        calls.map((c) => c.kind),
        ["select", "confirm"],
      );
      assert.match(calls[1].options.detail, /单向更新一份当前副本/);
      assert.match(calls[1].options.detail, /可用空间/);
      await assert.rejects(
        request("configureLocalBackup", { notebookId: first.id, path: disk }),
        /渲染器路径/,
      );
    },
  );
  const target = (
    await request("listLocalBackupTargets", { notebookId: first.id })
  )[0];
  const dest = join(target.path, "notebooks", first.id);
  const tasks = page.getByRole("dialog", { name: "任务中心", exact: true });
  const closeTasks = async () =>
    tasks.getByRole("button", { name: "关闭", exact: true }).click();
  const latest = async (type) =>
    (await request("listTasks")).filter((j) => j.type === type).at(-1);
  await check("first-backup-and-incremental-copy-statistics", async () => {
    await local.getByRole("button", { name: "立即备份", exact: true }).click();
    await tasks.waitFor();
    const initial = await job((await latest("local-backup")).id);
    assert.equal(initial.status, "completed");
    const manifest = JSON.parse(
      readFileSync(join(dest, ".backup/manifest.json")),
    );
    assert.equal(manifest.assets.length, 30);
    assert.equal(initial.backupResult.copiedFiles, manifest.files.length);
    await closeTasks();
    await local.getByRole("button", { name: "立即备份", exact: true }).click();
    await tasks.waitFor();
    const unchanged = await job((await latest("local-backup")).id);
    assert.equal(unchanged.backupResult.copiedBytes, 0);
    assert.equal(unchanged.backupResult.captureSkipped, true);
    await closeTasks();
  });
  await check("composition-guard-and-flush-before-backup", async () => {
    await navigateSource();
    const title = page.getByRole("textbox", { name: "笔记标题" });
    await title.dispatchEvent("compositionstart");
    await backupPage();
    const before = (await request("listTasks")).length;
    await local.getByRole("button", { name: "立即备份", exact: true }).click();
    await local
      .getByRole("alert")
      .filter({ hasText: "请完成当前输入" })
      .waitFor();
    assert.equal((await request("listTasks")).length, before);
    await navigateSource();
    await title.dispatchEvent("compositionend");
    await page.getByRole("textbox", { name: "文档内容", exact: true }).click();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A",
    );
    await page.keyboard.insertText("备份前的新内容");
    await backupPage();
    await local.getByRole("button", { name: "立即备份", exact: true }).click();
    await tasks.waitFor();
    assert.equal(
      (await job((await latest("local-backup")).id)).status,
      "completed",
    );
    const restored = join(root, "check-restore");
    mkdirSync(restored);
    await new LocalBackupService().restore(
      { id: target.diskId, path: target.path },
      first.id,
      restored,
    );
    const db = new DatabaseSync(join(restored, "notebook.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        db
          .prepare(
            "SELECT r.body FROM notes n JOIN note_revisions r ON r.id=n.head_revision_id WHERE n.node_id=?",
          )
          .get(note.id).body,
        "# 备份前的新内容\n\n",
      );
    } finally {
      db.close();
    }
    await closeTasks();
  });
  await check("scope-scheduling-and-partial-group-results", async () => {
    await local.locator(".local-backup-scope summary").click();
    const scope = local.locator(".local-backup-scope");
    await scope
      .getByRole("button", { name: "选择全部可用 Notebook", exact: true })
      .click();
    assert.equal(
      await scope
        .getByRole("button", { name: "备份所选范围", exact: true })
        .isDisabled(),
      true,
    );
    await scope
      .getByRole("button", { name: "保存备份范围", exact: true })
      .click();
    await eventually(
      async () => (await request("listLocalBackupTargets")).length === 2,
    );
    await local.getByLabel("文件复制并发").selectOption("1");
    await eventually(
      async () =>
        (await request("listLocalBackupTargets", { notebookId: first.id }))[0]
          .concurrency === 1,
    );
    const interval = local.getByLabel("自动检查间隔（分钟）", { exact: true });
    await interval.fill("7");
    await interval.press("Tab");
    await eventually(
      async () =>
        (await request("listLocalBackupTargets", { notebookId: first.id }))[0]
          .intervalMinutes === 7,
    );
    renameSync(secondSource, secondSource + "-offline");
    try {
      await scope
        .getByRole("button", { name: "备份所选范围", exact: true })
        .click();
      await tasks.waitFor();
      const group = await job((await latest("local-backup-group")).id);
      assert.equal(group.status, "failed");
      assert.equal(group.notebookResults.length, 2);
      assert.equal(
        group.notebookResults.find((r) => r.notebookId === first.id).status,
        "completed",
      );
      assert.equal(
        group.notebookResults.find((r) => r.notebookId === second.id).status,
        "failed",
      );
      await tasks
        .getByText("查看各 Notebook 结果（2 项）", { exact: true })
        .click();
      await tasks.getByText(/桌面备份主库：已完成/).waitFor();
      const failed = group.notebookResults.find(
        (r) => r.notebookId === second.id,
      );
      await tasks
        .getByText(new RegExp(`${failed.notebookName || second.id}：失败`))
        .waitFor();
    } finally {
      renameSync(secondSource + "-offline", secondSource);
    }
    await closeTasks();
  });
  await check(
    "complete-verification-report-and-restore-navigation",
    async () => {
      await local
        .getByRole("button", { name: "校验备份", exact: true })
        .click();
      await tasks.waitFor();
      assert.equal(
        (await job((await latest("local-verify")).id)).verificationReport
          .status,
        "passed",
      );
      await tasks
        .getByRole("region", { name: "备份校验报告" })
        .getByText(/完整校验通过/)
        .waitFor();
      await closeTasks();
      await local
        .getByRole("button", { name: "恢复当前副本", exact: true })
        .click();
      const restore = page.getByRole("dialog", {
        name: "恢复当前备份",
        exact: true,
      });
      await restore
        .getByText("只有一份当前副本，没有历史版本。", { exact: true })
        .waitFor();
      await restore.getByText(/附件 30 个/).waitFor();
      await page.screenshot({ path: "/tmp/anynote-local-backup-review.png" });
      await restore
        .getByRole("button", { name: "校验并恢复为新 Notebook", exact: true })
        .click();
      await tasks.waitFor();
      const restored = await job((await latest("local-restore")).id);
      assert.equal(restored.status, "completed");
      assert.notEqual(restored.restoredId, first.id);
      await tasks
        .getByRole("button", { name: "打开恢复的 Notebook", exact: true })
        .click();
      await tasks.waitFor({ state: "hidden" });
      await eventually(async () =>
        (await request("listNotebooks")).some(
          (b) => b.id === restored.restoredId,
        ),
      );
      await page.getByRole("textbox", { name: "笔记标题" }).waitFor();
      assert.equal(
        await page.evaluate(() => localStorage.getItem("anynote-book")),
        restored.restoredId,
      );
      assert.equal(
        (
          await request("getNote", {
            notebookId: restored.restoredId,
            id: note.id,
          })
        ).body,
        "# 备份前的新内容\n\n",
      );
    },
  );
  await check("multiple-file-errors-render-and-prevent-restore", async () => {
    await navigateSource();
    await backupPage();
    const chunks = JSON.parse(
      readFileSync(join(dest, ".backup/manifest.json"), "utf8"),
    ).files;
    rmSync(join(dest, chunks[0].path));
    const corrupted = join(dest, chunks[1].path);
    const original = readFileSync(corrupted);
    writeFileSync(corrupted, Buffer.alloc(original.length, 120));
    await local.getByRole("button", { name: "校验备份", exact: true }).click();
    await tasks.waitFor();
    const verified = await job((await latest("local-verify")).id);
    assert.equal(verified.status, "failed");
    assert.equal(verified.verificationReport.complete, true);
    assert.deepEqual(
      verified.verificationReport.issues.map((i) => i.code).sort(),
      ["FILE_MISSING", "HASH_MISMATCH"],
    );
    const card = tasks.locator(".job-card").first();
    await card.getByText(/查看文件异常（2 项）/).click();
    await card.getByText(chunks[0].path, { exact: true }).waitFor();
    await card.getByText(chunks[1].path, { exact: true }).waitFor();
    await closeTasks();
    const before = (await request("listNotebooks")).length;
    await local
      .getByRole("button", { name: "恢复当前副本", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "恢复当前备份", exact: true })
      .getByRole("button", { name: "校验并恢复为新 Notebook", exact: true })
      .click();
    await tasks.waitFor();
    const failed = await job((await latest("local-restore")).id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "BACKUP_INCONSISTENT");
    assert.equal((await request("listNotebooks")).length, before);
    await closeTasks();
    await local.getByRole("button", { name: "立即备份", exact: true }).click();
    await tasks.waitFor();
    assert.equal(
      (await job((await latest("local-backup")).id)).status,
      "completed",
    );
    assert.deepEqual(readFileSync(corrupted), original);
    assert.equal(existsSync(join(dest, chunks[0].path)), true);
    await closeTasks();
  });
  await check("cancel-task-preserves-committed-backup", async () => {
    await navigateSource();
    await backupPage();
    const current = await request("getNote", {
      notebookId: first.id,
      id: note.id,
    });
    await request("saveNote", {
      notebookId: first.id,
      id: note.id,
      expectedRevision: current.revision,
      body: current.body + "\ncancel check",
    });
    const manifest = readFileSync(join(dest, ".backup/manifest.json"), "utf8");
    const active = await request("startLocalBackup", {
      notebookId: first.id,
      targetId: target.id,
    });
    await request("cancelTask", { id: active.id });
    assert.equal((await job(active.id)).status, "cancelled");
    assert.equal(
      readFileSync(join(dest, ".backup/manifest.json"), "utf8"),
      manifest,
    );
  });
  await page.screenshot({ path: "/tmp/anynote-local-backup-final.png" });
  const versions = await electron.evaluate(() => process.versions);
  mkdirSync(join(reportPath, ".."), { recursive: true });
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        passed: true,
        checks,
        platform: process.platform,
        sourceDirectory: join(root, "notebooks"),
        targetDirectory: disk,
        filesystem,
        electron: versions.electron,
        node: versions.node,
        completedAt: new Date().toISOString(),
        boundary:
          "Native dialogs use isolated fixture adapters; no physical disk/power-loss or real IME hardware validation.",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Local backup desktop acceptance passed (${checks.length} checks): ${reportPath}`,
  );
} catch (error) {
  mkdirSync(join(reportPath, ".."), { recursive: true });
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        passed: false,
        checks,
        error: error.message,
        platform: process.platform,
        completedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  console.error("Acceptance failed after:", checks);
  if (page)
    console.error(
      "Visible alerts:",
      await page
        .getByRole("alert")
        .allTextContents()
        .catch(() => []),
    );
  if (electron)
    console.error(
      "Dialog calls:",
      await electron
        .evaluate(() => globalThis.localBackupDialogCalls)
        .catch(() => []),
    );
  throw error;
} finally {
  try {
    await electron?.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
