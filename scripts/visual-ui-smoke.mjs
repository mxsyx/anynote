import { writeVisualGallery } from "./acceptance/visual-gallery.mjs";
import { chromium } from "playwright";
import { expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const output = resolve(
  process.env.ANYNOTE_SCREENSHOTS || "docs/screenshots/g20",
);
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.ANYNOTE_BROWSER
    ? { executablePath: process.env.ANYNOTE_BROWSER }
    : {}),
  headless: true,
});
const page = await browser.newPage({ reducedMotion: "reduce" });
const errors = [];
const screenshots = [];
let passed = false;
page.on("pageerror", (error) => errors.push(error.message));
const title =
  "春日阅读手记与那些尚未整理的灵感——超长中文标题用于检查目录、标签和纸张的边界";
const books = [
  { id: "garden", name: title },
  { id: "empty", name: "空白手记" },
];
const folders = Array.from({ length: 40 }, (_, i) => ({
  id: `folder-${i}`,
  parent_id: i ? `folder-${i - 1}` : null,
  title: `第 ${i + 1} 层 · ${title}`,
  kind: "folder",
  revision: 1,
  tags: [],
  deleted_at: null,
}));
const note = {
  id: "note",
  parent_id: "folder-39",
  kind: "note",
  title,
  note_type: "markdown",
  revision: 1,
  tags: ["阅读", "长中文标签与灵感整理"],
  deleted_at: null,
  updated_at: 1792569600000,
  body:
    "# 阅读札记\n\n这是一篇用于检查中文排版和多扩展内容的笔记。\n\n" +
    '```js\nconst longLine = "' +
    "中文与代码边界".repeat(35) +
    '";\n```\n\n' +
    ':::anynote{type="core.video" version="1" id="video"}\n{"url":"https://www.youtube.com/watch?v=WE47_j9fek8","title":"本地保存的视频卡片"}\n:::\n\n' +
    ':::anynote{type="core.whiteboard" version="1" id="board"}\n{"resourceId":"board-resource"}\n:::\n\n' +
    ':::anynote{type="future.node" version="9" id="opaque"}\n{"unknown":"缺少插件时仍保留原始内容"}\n:::\n\n' +
    "![缺失的本地图片](anynote-resource:missing)\n",
};
let releaseLibrary, releaseSearch;
let assetRequests = 0;
let libraryError = true,
  searchError = false;
let libraryGate = new Promise((resolve) => {
  releaseLibrary = resolve;
});
let searchGate = Promise.resolve();
await page.route("**/api/rpc", async (route) => {
  const { op, input } = route.request().postDataJSON();
  let result = null,
    error;
  if (op === "listNotebooks") {
    await libraryGate;
    if (libraryError) error = "目录暂时不可用，请检查位置后重试。";
    else result = books;
  }
  if (op === "listNodes")
    result = input.notebookId === "garden" ? [...folders, note] : [];
  if (op === "getNote") result = note;
  if (
    [
      "getBacklinks",
      "listSnapshots",
      "listExtensions",
      "listExtensionCommands",
      "listHostedExtensions",
    ].includes(op)
  )
    result = [];
  if (op === "getExtensionSettings") result = true;
  if (op === "getAsset") {
    assetRequests++;
    error = "本地资源缺失";
  }
  if (op === "searchWorkspace") {
    await searchGate;
    if (searchError) error = "搜索索引暂时不可用。";
    else result = { results: [], warnings: [], truncated: false };
  }
  await route.fulfill({ json: error ? { error } : { result } });
});
async function capture(name) {
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `${output}/${name}.png`,
    animations: "disabled",
  });
  screenshots.push(`${name}.png`);
}
try {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("http://127.0.0.1:5173");
  await expect(page.getByText("正在整理书橱…")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "创建 Notebook", exact: true }),
  ).toBeDisabled();
  await capture("library-loading");
  releaseLibrary();
  await expect(page.getByRole("alert")).toContainText("书橱暂时无法打开");
  await capture("library-error");
  libraryError = false;
  await page.getByRole("button", { name: "重新读取书橱" }).click();
  await expect(page.locator(".book-volume")).toHaveCount(2);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  for (const [width, height] of [
    [1280, 800],
    [1440, 900],
    [1920, 1080],
  ]) {
    await page.setViewportSize({ width, height });
    for (const theme of ["light", "dark"]) {
      if ((await page.locator("html").getAttribute("data-theme")) !== theme)
        await page
          .getByRole("button", { name: "切换主题", exact: true })
          .click();
      await capture(`shelf-${width}-${theme}`);
      await page
        .getByRole("button", { name: `打开 Notebook：${title}`, exact: true })
        .click();
      await expect(
        page.getByRole("textbox", { name: "文档内容", exact: true }),
      ).toBeVisible();
      await expect(
        page.locator('.tree-main[data-node-id="note"]'),
      ).toBeInViewport();
      await expect(page.locator(".chapter-title").last()).toContainText("41层");
      await page.keyboard.press("Tab");
      await page.locator('.tree-main[data-node-id="note"]').focus();
      expect(
        await page
          .locator('.tree-main[data-node-id="note"]')
          .evaluate((el) => getComputedStyle(el).outlineStyle),
      ).not.toBe("none");
      await capture(`document-${width}-${theme}`);
      await page
        .locator(".main-content")
        .evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await expect(page.locator(".video-block")).toBeVisible();
      await expect(page.getByText("资源无法读取：本地资源缺失")).toBeVisible();
      await capture(`extensions-${width}-${theme}`);
      await page.getByRole("button", { name: "我的收藏", exact: true }).click();
      await expect(page.getByText("这里，等待新的想法")).toBeVisible();
      await capture(`empty-${width}-${theme}`);
      await page.getByRole("button", { name: "书橱", exact: true }).click();
    }
  }
  await page
    .getByRole("button", { name: `打开 Notebook：${title}`, exact: true })
    .click();
  const previousRequests = assetRequests;
  await page
    .getByRole("button", { name: "重新读取图片：缺失的本地图片" })
    .click();
  await expect.poll(() => assetRequests).toBeGreaterThan(previousRequests);
  await expect(page.getByText("资源无法读取：本地资源缺失")).toBeVisible();
  searchGate = new Promise((resolve) => {
    releaseSearch = resolve;
  });
  searchError = true;
  await page.getByRole("button", { name: "搜索笔记", exact: true }).click();
  await expect(
    page
      .locator(".view-state[data-kind=loading]")
      .filter({ hasText: "正在搜索" }),
  ).toContainText("正在搜索");
  await capture("search-loading");
  releaseSearch();
  await expect(page.getByText("搜索未完成")).toBeVisible();
  await expect(page.getByText("没有找到这个想法", { exact: true })).toHaveCount(
    0,
  );
  await capture("search-error");
  searchError = false;
  await page.getByRole("button", { name: "重试搜索" }).click();
  await expect(
    page.getByText("没有找到这个想法", { exact: true }),
  ).toBeVisible();
  await capture("search-empty");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "搜索笔记", exact: true }),
  ).toBeFocused();

  for (const [width, height] of [
    [1280, 800],
    [1440, 900],
    [1920, 1080],
  ]) {
    await page.setViewportSize({ width, height });
    for (const theme of ["light", "dark"]) {
      for (const sample of ["components", "ai"]) {
        await page.goto(
          `http://127.0.0.1:5173/design.html${sample === "ai" ? "?ai" : ""}`,
        );
        await page.locator(".design-preview").waitFor();
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        await capture(`${sample}-${width}-${theme}`);
        if (sample === "components") {
          const trigger = page.getByRole("button", { name: "打开样张对话框" });
          await trigger.click();
          await expect(page.getByRole("dialog")).toBeVisible();
          expect(
            await page
              .getByRole("dialog")
              .evaluate((element) => getComputedStyle(element).backgroundColor),
          ).not.toBe("rgba(0, 0, 0, 0)");
          await expect(
            page.getByRole("textbox", { name: "名称", exact: true }),
          ).toBeFocused();
          await capture(`dialog-${width}-${theme}`);
          await page.keyboard.press("Escape");
          await expect(page.getByRole("dialog")).toHaveCount(0);
        }
      }
    }
  }
  expect(errors).toEqual([]);
  passed = true;
  console.log(
    `Visual UI passed: ${screenshots.length} screenshots, three windows, both themes, 40 nested folders, long Chinese text, extension blocks, loading/error/retry, focus and dynamic dialogs.`,
  );
} finally {
  writeFileSync(
    `${output}/report.json`,
    JSON.stringify(
      {
        status: passed ? "passed" : "failed",
        screenshots,
        errors,
        browser: browser.version(),
        fixture: "mocked RPC; not real storage",
        windows: [
          [1280, 800],
          [1440, 900],
          [1920, 1080],
        ],
      },
      null,
      2,
    ),
  );
  writeVisualGallery(output);
  await browser.close();
}
