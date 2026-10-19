import { chromium } from "playwright";
import { expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

// A deterministic UI integration test; the RPC boundary uses isolated fixtures.
const browser = await chromium.launch({
  ...(process.env.ANYNOTE_BROWSER
    ? { executablePath: process.env.ANYNOTE_BROWSER }
    : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const books = [
  { id: "garden", name: "日常与灵感" },
  { id: "reading", name: "阅读手记" },
  { id: "external", name: "远方来信", external: true },
  { id: "lost", name: "待修复的旧藏", unavailable: true },
];
const nodes = [
  {
    id: "chapter",
    parent_id: null,
    kind: "folder",
    title: "第一章 · 日常",
    revision: 1,
    tags: [],
    deleted_at: null,
  },
  {
    id: "note",
    parent_id: "chapter",
    kind: "note",
    title: "午后的光",
    note_type: "markdown",
    body: "# 午后的光\n\n记下一点微小的快乐。",
    revision: 1,
    tags: [],
    deleted_at: null,
    updated_at: Date.now(),
  },
];
await page.route("**/api/rpc", async (route) => {
  const { op, input } = route.request().postDataJSON();
  let result = null;
  if (op === "listNotebooks") result = books;
  if (op === "listNodes") result = input.notebookId === "garden" ? nodes : [];
  if (op === "getNote") result = nodes[1];
  if (op === "createNotebook") {
    result = { id: "new", name: input.title };
    books.push(result);
  }
  if (op === "getBacklinks") result = [];
  await route.fulfill({ json: { result } });
});
const output =
  process.env.ANYNOTE_SCREENSHOTS || "/tmp/anynote-bookshelf-screenshots";
mkdirSync(output, { recursive: true });

try {
  await page.goto("http://127.0.0.1:5173");
  await expect(page.locator(".book-volume")).toHaveCount(4);
  await expect(page.locator(".sidebar")).toHaveCount(0);
  const bindings = await page.locator(".book-volume").evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();

      return { width: box.width, height: box.height, bottom: box.bottom };
    }),
  );
  expect(bindings.every((box) => box.height > box.width * 2)).toBe(true);
  expect(new Set(bindings.map((box) => Math.round(box.bottom))).size).toBe(1);
  await page.screenshot({ path: `${output}/bookshelf.png` });
  await page
    .getByRole("button", { name: "打开 Notebook：日常与灵感", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "笔记标题" })).toHaveValue(
    "午后的光",
  );
  await expect(page.locator(".chapter-number")).toHaveText(["01", "01.1"]);
  await page.locator(".tree-main").first().click();
  await expect(page.locator(".chapter-number")).toHaveText(["01"]);
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".chapter-number")).toHaveText(["01", "01.1"]);
  await page.keyboard.press("ArrowDown");
  await expect(page.locator('.tree-main[data-node-id="note"]')).toBeFocused();
  await expect(
    page.getByRole("textbox", { name: "文档内容", exact: true }),
  ).toContainText("记下一点微小的快乐。");
  await page.screenshot({ path: `${output}/contents.png` });
  await page.getByRole("button", { name: "← 返回书橱", exact: true }).click();
  await expect(page.locator(".book-volume")).toHaveCount(4);
  await page
    .getByRole("button", { name: "打开 Notebook：阅读手记", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "翻开新的一页" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "书橱", exact: true }).click();
  await page
    .getByRole("button", { name: "创建 Notebook", exact: true })
    .click();
  await page.getByPlaceholder("输入一个名称…").fill("新的篇章");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "翻开新的一页" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "书橱", exact: true }).click();
  await expect(page.locator(".book-volume")).toHaveCount(5);
  await page.reload();
  await expect(page.locator(".book-volume")).toHaveCount(5);
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await page.screenshot({ path: `${output}/bookshelf-dark.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await page.screenshot({ path: `${output}/bookshelf-mobile.png` });
  await page
    .getByRole("button", { name: "打开 Notebook：日常与灵感", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "笔记标题" })).toBeVisible();
  await page.getByRole("button", { name: "书橱", exact: true }).click();
  await expect(page.locator(".book-volume")).toHaveCount(5);
  expect(errors).toEqual([]);
  console.log(
    "Bookshelf UI passed: startup, all volumes, open, empty Notebook, create, return, reload, chapter numbering, keyboard, themes, mobile.",
  );
} catch (error) {
  console.error(errors);
  console.error((await page.locator("body").innerText()).slice(0, 3000));
  await page.screenshot({ path: `${output}/failure.png` });
  throw error;
} finally {
  await browser.close();
}
