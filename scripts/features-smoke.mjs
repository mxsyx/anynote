import { appMenu } from "./acceptance/app-menu.mjs";
import { openNotebook } from "./acceptance/open-notebook.mjs";
import { _electron } from "playwright";
import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated real Electron/SQLite run; only the native picker result is substituted.
const root = mkdtempSync(join(tmpdir(), "anynote-features-"));
const adjacent = join(root, "adjacent");
mkdirSync(adjacent);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=",
  "base64",
);
writeFileSync(join(adjacent, "picture.png"), png);
const app = await _electron.launch({
  args: [".", "--no-sandbox"],
  env: {
    ...process.env,
    ANYNOTE_USER_DATA_DIR: root,
    ANYNOTE_DEV: "",
    ELECTRON_RUN_AS_NODE: "",
  },
});
let page;
try {
  page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openNotebook(page);
  await page.getByRole("textbox", { name: "笔记标题" }).waitFor();
  await page.getByRole("button", { name: "新建笔记", exact: true }).click();
  await page.getByPlaceholder("输入一个名称…").fill("扩展界面验证");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "文档内容", exact: true });
  await editor.fill("内容扩展验证");
  await page.keyboard.press("ControlOrMeta+s");
  await page.getByText("已保存至本地", { exact: true }).waitFor();
  const imagePicker = page.waitForEvent("filechooser");
  await appMenu(page, "insert.image", app);
  await (
    await imagePicker
  ).setFiles({ name: "内联图片.png", mimeType: "image/png", buffer: png });
  await expect(editor.locator("img").first()).toBeVisible();
  await expect
    .poll(() =>
      editor
        .locator("img")
        .first()
        .evaluate((img) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true);

  await appMenu(page, "insert.video", app);
  await page
    .getByPlaceholder("输入一个名称…")
    .fill("https://youtu.be/dQw4w9WgXcQ");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.locator(".video-block").waitFor();
  assert.equal(await page.locator("iframe").count(), 0);
  await expect(async () => {
    if (!(await page.locator(".video-block iframe").count()))
      await page.getByRole("button", { name: "嵌入播放", exact: true }).click();
    await expect(page.locator(".video-block iframe")).toHaveCount(1, {
      timeout: 1000,
    });
  }).toPass({ timeout: 10000 });
  await page.getByRole("button", { name: "关闭播放", exact: true }).click();
  assert.equal(await page.locator("iframe").count(), 0);
  await appMenu(page, "insert.video", app);
  await page
    .getByPlaceholder("输入一个名称…")
    .fill("https://example.com/talks/local-first");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.locator(".video-block")).toHaveCount(2);
  assert.equal(
    await page
      .locator(".video-block")
      .nth(1)
      .getByRole("button", { name: "嵌入播放", exact: true })
      .count(),
    0,
  );

  await appMenu(page, "insert.whiteboard", app);
  const canvas = page.locator(".excalidraw canvas").first();
  await canvas.waitFor({ timeout: 45000 });
  const box = await canvas.boundingBox();
  await page.keyboard.press("r");
  await page.mouse.move(box.x + 300, box.y + 250);
  await page.mouse.down();
  await page.mouse.move(box.x + 490, box.y + 365, { steps: 12 });
  await page.mouse.up();
  await page.getByRole("button", { name: "保存白板", exact: true }).click();
  await page
    .getByRole("dialog", { name: "白板编辑器" })
    .waitFor({ state: "hidden", timeout: 20000 });
  await page.getByAltText("白板预览", { exact: true }).waitFor();
  await page.getByRole("button", { name: "打开白板", exact: true }).click();
  await canvas.waitFor();
  await page.getByRole("button", { name: "返回笔记", exact: true }).click();

  const notebookId = await page.evaluate(
    async () => (await window.anynote.request("listNotebooks"))[0].id,
  );
  const request = (op, input = {}) =>
    page.evaluate(({ op, input }) => window.anynote.request(op, input), {
      op,
      input: { notebookId, ...input },
    });
  await assert.rejects(
    request("chooseImportDirectory", { path: adjacent }),
    /渲染器路径/,
  );
  await assert.rejects(
    request("registerImportDirectory", { path: adjacent }),
    /未授权/,
  );
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, adjacent);

  const openImport = async () => {
    await page
      .getByRole("button", { name: "网页 / HTML 导入", exact: true })
      .click();
    await page.getByRole("button", { name: "HTML 文件", exact: true }).click();
  };
  await openImport();
  await page
    .getByRole("textbox", { name: "HTML 内容" })
    .fill(
      '<title>网页验证</title><h1>清洗后的收藏</h1><p>本地可读内容</p><script>window.importExecuted=true</script><img src="picture.png"><img src="retry.png">',
    );
  await page
    .getByRole("button", { name: "授权相邻资源目录", exact: true })
    .click();
  await page
    .getByRole("button", { name: "资源目录：adjacent", exact: true })
    .waitFor();
  await page.getByText("导入预算", { exact: true }).click();
  await page
    .getByRole("spinbutton", { name: "同时下载数", exact: true })
    .fill("2");
  await page
    .getByRole("spinbutton", { name: "总量上限（MB）", exact: true })
    .fill("4");
  await page.getByRole("checkbox", { name: /保存原始 HTML/ }).check();
  mkdirSync("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/web-import-budget.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "预览转换结果", exact: true }).click();
  await page.getByRole("button", { name: "确认导入", exact: true }).waitFor();
  await expect(page.locator(".import-preview")).toContainText(
    "已本地化 1 / 2 项",
  );
  await expect(page.locator(".import-preview")).toContainText("4.0 MB");
  assert.equal(
    (await request("listNodes")).some((note) => note.title === "网页验证"),
    false,
  );
  await page.screenshot({
    path: "test-results/web-import-preview.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  await page
    .getByRole("dialog", { name: "导入网页", exact: true })
    .waitFor({ state: "hidden" });
  let imported = (await request("listNodes")).find(
    (note) => note.title === "网页验证",
  );
  assert.ok(imported);
  let report = await request("getImportReport", { id: imported.id });
  assert.equal(report.localized, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.budget.concurrency, 2);
  const localized = report.media.find((item) => item.status === "localized");
  assert.equal(
    (
      await request("getAsset", {
        id: localized.resourceId,
        noteId: imported.id,
      })
    ).data,
    png.toString("base64"),
  );
  assert.equal(await page.evaluate(() => window.importExecuted), undefined);

  // Reopen through current navigation, authorize again, and retry the missing file.
  writeFileSync(join(adjacent, "retry.png"), png);
  await page.reload();
  await openNotebook(page);
  await page.getByRole("button", { name: "网页验证", exact: true }).click();
  await page.locator(".import-report > summary").click();
  await page.getByRole("button", { name: "重试全部", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await request("getImportReport", { id: imported.id })).localized,
    )
    .toBe(2);
  await expect
    .poll(() => readdirSync(join(root, "notebooks/_local/import-jobs")).length)
    .toBe(0);

  // Returning to the form discards the first prepared snapshot; closing discards the next.
  await openImport();
  await page
    .getByRole("textbox", { name: "HTML 内容" })
    .fill("<title>放弃预览</title><p>不保存</p>");
  await page.getByRole("button", { name: "预览转换结果", exact: true }).click();
  await page.getByRole("button", { name: "返回修改", exact: true }).click();
  await expect
    .poll(() => readdirSync(join(root, "notebooks/_local/import-jobs")).length)
    .toBe(0);
  await page.getByRole("button", { name: "预览转换结果", exact: true }).click();
  await page.getByRole("button", { name: "确认导入", exact: true }).waitFor();
  await page
    .getByRole("dialog", { name: "导入网页", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await expect
    .poll(() => readdirSync(join(root, "notebooks/_local/import-jobs")).length)
    .toBe(0);
  assert.equal(
    (await request("listNodes")).some((note) => note.title === "放弃预览"),
    false,
  );
  await openImport();
  await page
    .getByRole("textbox", { name: "HTML 内容" })
    .fill("<title>取消导入</title>" + '<img src="missing.png">'.repeat(200));
  await page.getByRole("button", { name: "预览转换结果", exact: true }).click();
  await page.getByRole("button", { name: "取消预览", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "预览转换结果", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "导入网页", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await expect
    .poll(() => readdirSync(join(root, "notebooks/_local/import-jobs")).length)
    .toBe(0);
  assert.equal(
    (await request("listNodes")).some((note) => note.title === "取消导入"),
    false,
  );
  await page.screenshot({
    path: "test-results/web-import-result.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Electron real storage, inline media/video/whiteboard, native grant boundary, budget UI, import preview/commit/discard, sanitized HTML, directory media retry and staging cleanup.",
  );
} catch (error) {
  mkdirSync("test-results", { recursive: true });
  await page?.screenshot({
    path: "test-results/features-error.png",
    fullPage: true,
  });
  throw error;
} finally {
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
