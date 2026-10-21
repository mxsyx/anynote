import { chromium } from "playwright";
import { expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

// UI-only fixtures; the storage/streaming path is covered by cloud-verification-budget.test.mjs.
const browser = await chromium.launch({
  ...(process.env.ANYNOTE_BROWSER
    ? { executablePath: process.env.ANYNOTE_BROWSER }
    : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const output =
  process.env.ANYNOTE_SCREENSHOTS || "/tmp/anynote-cloud-budget-screenshots";
mkdirSync(output, { recursive: true });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const MiB = 1024 ** 2;
const books = [{ id: "garden", name: "恢复空间测试" }];
const target = {
  target: {
    id: "target",
    providerId: "google-drive",
    deviceSlotId: "slot",
    lastSuccess: Date.now(),
    lastVerification: "accepted-size",
  },
  account: {
    id: "account",
    ref: { displayName: "测试账号", accountId: "test" },
  },
  provider: {
    id: "google-drive",
    title: "Google Drive",
    beta: false,
    installed: true,
  },
  capabilities: { providerChecksum: [] },
  state: "completed",
};
let mode = "low",
  starts = 0,
  cancels = 0,
  completed = false;
const tasks = [
  {
    id: "backup",
    type: "cloud-backup",
    notebookId: "garden",
    status: "completed",
    createdAt: Date.now(),
    report: {
      format: "anynote.cloud-backup-report",
      formatVersion: 1,
      verification: "provider-checksum",
      databaseBytes: 8 * MiB,
      assetBytes: 2 * MiB,
      uploadedBytes: 2 * MiB,
    },
  },
];
await page.route("**/api/rpc", async (route) => {
  const { op, input } = route.request().postDataJSON();
  let result = op.startsWith("list") || op === "getBacklinks" ? [] : null;
  if (op === "listNotebooks") result = books;
  if (op === "listCloudTargets") result = [target];
  if (op === "listCloudDevices")
    result = [
      {
        deviceSlotId: "slot",
        deviceLabel: "测试 Mac",
        databaseBytes: 8 * MiB,
        assetBytes: 2 * MiB,
        completedAt: new Date().toISOString(),
        verification: "accepted-size",
        local: true,
      },
    ];
  if (op === "previewCloudRestore") {
    if (mode === "error")
      return route.fulfill({ json: { error: "清单暂时不可用，请重试" } });
    result = {
      commitId: "preview-commit",
      databaseBytes: 8 * MiB,
      assetBytes: 2 * MiB,
      downloadBytes: 8 * MiB,
      diskBudgetBytes: 27 * MiB,
      availableBytes: (mode === "low" ? 10 : 100) * MiB,
      reservedBytes: 5 * MiB,
      sufficient: mode !== "low",
      verification: "accepted-size",
    };
  }
  if (op === "restoreCloudTargetBackup") {
    expect(input.expectedCommitId).toBe("preview-commit");
    starts++;
    result = { id: "restore" };
    tasks.splice(1, tasks.length, {
      id: "restore",
      type: "cloud-restore",
      notebookId: "garden",
      createdAt: Date.now(),
      status: completed ? "completed" : "running",
      restoredId: completed ? "restored" : undefined,
      progress: completed ? "已恢复为新的 Notebook" : "正在下载并校验云盘备份",
      totalBytes: 8 * MiB,
      diskBudgetBytes: 27 * MiB,
      report: completed
        ? {
            format: "anynote.cloud-restore-report",
            formatVersion: 1,
            verification: "download-sha256",
            databaseBytes: 8 * MiB,
            assetBytes: 2 * MiB,
            downloadBytes: 8 * MiB,
            diskBudgetBytes: 27 * MiB,
          }
        : undefined,
    });
    if (completed) books.push({ id: "restored", name: "恢复的新 Notebook" });
  }
  if (op === "cancelTask") {
    cancels++;
    tasks[1].status = "cancelled";
  }
  if (op === "listTasks") result = tasks;
  await route.fulfill({ json: { result } });
});

try {
  await page.goto(process.env.ANYNOTE_URL || "http://127.0.0.1:5173");
  await page
    .getByRole("button", { name: "打开 Notebook：恢复空间测试", exact: true })
    .click();
  await page.getByTitle("查看备份", { exact: true }).click();
  const card = page
    .locator(".backup-target")
    .filter({ hasText: "Google Drive" });
  await expect(card).toContainText("内容校验始终开启");
  await expect(card).toContainText("额外下载量约等于新上传数据量");
  await expect(card).toContainText("最近备份校验：仅确认大小，未完成内容校验");
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${output}/backup.png` });
  await card.getByRole("button", { name: "恢复", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "从云盘恢复" });
  await dialog.getByRole("button", { name: "选择", exact: true }).click();
  await expect(dialog).toContainText("可用磁盘空间不足");
  await expect(dialog).toContainText("其他恢复任务预算 5.0 MB");
  await expect(
    dialog.getByRole("button", { name: "下载并校验", exact: true }),
  ).toBeDisabled();
  expect(starts).toBe(0);
  await page.screenshot({ path: `${output}/insufficient.png` });
  mode = "error";
  await dialog.getByRole("button", { name: "重新检查空间" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("清单暂时不可用，请重试");
  await expect(
    dialog.getByRole("button", { name: "下载并校验", exact: true }),
  ).toBeDisabled();
  mode = "enough";
  await dialog.getByRole("button", { name: "重新检查空间" }).click();
  await expect(
    dialog.getByRole("button", { name: "下载并校验", exact: true }),
  ).toBeEnabled();
  await expect(dialog).toContainText("恢复所需空间约 27 MB");
  await expect(dialog).toContainText("仅确认大小，未完成内容校验");
  await page.screenshot({ path: `${output}/ready.png` });
  await dialog.getByRole("button", { name: "下载并校验", exact: true }).click();
  await dialog.getByRole("button", { name: "取消恢复" }).click();
  expect(cancels).toBe(1);
  completed = true;
  await dialog.getByRole("button", { name: "下载并校验", exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 6000 });
  expect(starts).toBe(2);
  await page.getByRole("button", { name: "任务中心", exact: true }).click();
  await expect(
    page.locator(".job-card").filter({ hasText: "云盘备份" }),
  ).toContainText("厂商内容校验和已核对");
  await expect(
    page.locator(".job-card").filter({ hasText: "云盘恢复" }),
  ).toContainText("已下载并核对 SHA-256");
  await page.screenshot({ path: `${output}/reports.png` });
  expect(errors).toEqual([]);
  console.log(
    "Cloud budget UI passed: traffic, weak evidence, insufficient space, preview failure/retry, cancel, restore and task reports.",
  );
} catch (error) {
  console.error(errors);
  console.error((await page.locator("body").innerText()).slice(-7000));
  await page.screenshot({ path: `${output}/failure.png` });
  throw error;
} finally {
  await browser.close();
}
