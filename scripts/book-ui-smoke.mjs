import { openNotebook } from "./acceptance/open-notebook.mjs";
import { chromium } from "playwright";
import { expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

// Run against a preview server backed by disposable ANYNOTE_DATA_DIR data.
const browser = await chromium.launch({
  ...(process.env.ANYNOTE_BROWSER
    ? { executablePath: process.env.ANYNOTE_BROWSER }
    : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const output =
  process.env.ANYNOTE_SCREENSHOTS || "/tmp/anynote-book-ui-screenshots";
mkdirSync(output, { recursive: true });

try {
  await page.goto("http://127.0.0.1:5173");
  await openNotebook(page);
  await expect(page.getByRole("textbox", { name: "笔记标题" })).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "文档内容", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: `${output}/light.png` });
  const create = page.getByRole("button", { name: "新建笔记", exact: true });
  await create.click();
  const dialog = page.getByRole("dialog", { name: "写一篇新笔记" });
  await expect(dialog).toBeVisible();
  const name = `装订与编辑验证 ${Date.now()}`;
  await page.getByPlaceholder("输入一个名称…").fill(name);
  // Shift+Tab at the first control wraps to the final action.
  await dialog.getByRole("button", { name: "关闭", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "创建", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "笔记标题" })).toHaveValue(
    name,
  );
  const editor = page.getByRole("textbox", { name: "文档内容", exact: true });
  await editor.fill("这是写在新纸页上的一段文字。");
  await page.getByRole("textbox", { name: "笔记标题" }).click();
  await expect(page.getByText("已保存至本地", { exact: true })).toBeVisible();
  await page.reload();
  await openNotebook(page);
  await page.locator(".tree-main").filter({ hasText: name }).click();
  await expect(editor).toContainText("这是写在新纸页上的一段文字。");
  const search = page.getByRole("button", { name: "搜索笔记", exact: true });
  await search.click();
  await page.getByPlaceholder("寻找一个想法，或一篇笔记…").fill(name);
  await expect(page.locator(".command-results button").first()).toContainText(
    name,
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(search).toBeFocused();
  await create.click();
  await page.keyboard.press("Escape");
  await expect(create).toBeFocused();
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await page.screenshot({ path: `${output}/dark.png` });
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByRole("textbox", { name: "笔记标题" })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: `${output}/${width}.png` });
  }
  expect(errors).toEqual([]);
  console.log(
    "Book UI: create, edit, persistence, search, focus, themes and responsive layout passed.",
  );
} finally {
  await browser.close();
}
