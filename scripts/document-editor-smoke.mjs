import { openNotebook } from "./acceptance/open-notebook.mjs";
import { _electron } from "playwright";
import { expect } from "@playwright/test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const root = mkdtempSync(join(tmpdir(), "anynote-document-"));
const app = await _electron.launch({
  args: [".", "--no-sandbox"],
  env: {
    ...process.env,
    ANYNOTE_USER_DATA_DIR: root,
    ANYNOTE_DEV: "",
    ELECTRON_RUN_AS_NODE: "",
  },
});

try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openNotebook(page);
  await page
    .getByRole("textbox", { name: "笔记标题" })
    .waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "新建笔记", exact: true }).click();
  await page.getByPlaceholder("输入一个名称…").fill("统一文档验收");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  const input = page.getByRole("textbox", { name: "文档内容", exact: true });
  await input.click();
  await expect(page.locator(".mode-switch")).toHaveCount(0);
  await page.keyboard.type("## ");
  await page.keyboard.insertText("连续编辑标题");
  await expect(input.locator("h2")).toHaveText("连续编辑标题");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("正文第一段");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/task");
  await expect(page.getByRole("menu", { name: "插入内容" })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("待办事项");
  await expect(input.locator('[data-type="taskItem"]')).toContainText(
    "待办事项",
  );
  await input.locator('input[type="checkbox"]').check();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/table");
  await page.getByRole("menuitem", { name: "表格", exact: true }).click();
  await expect(input.locator("table")).toHaveCount(1);
  await page.getByRole("button", { name: "增加表格行", exact: true }).click();
  await expect(input.locator("tr")).toHaveCount(4);

  const read = () =>
    page.evaluate(async () => {
      const book = (await window.anynote.request("listNotebooks"))[0];
      const note = (
        await window.anynote.request("listNodes", { notebookId: book.id })
      ).find((item) => item.title === "统一文档验收");
      return window.anynote.request("getNote", {
        notebookId: book.id,
        id: note.id,
      });
    });
  await expect.poll(async () => (await read()).body).toContain("待办事项");
  const body = (await read()).body;
  assert.match(body, /## 连续编辑标题/);
  assert.match(body, /\[x\] 待办事项/);
  assert.ok(!body.includes("/task") && !body.includes("/table"));

  // Load a fixture through storage to exercise the actual Markdown hydration path.
  const opaque =
    ':::anynote{type="future.node" version="9" id="opaque"}\n{"unknown":"保留字段"}\n:::';
  await page.evaluate(
    async ({ opaque }) => {
      const book = (await window.anynote.request("listNotebooks"))[0];
      const note = (
        await window.anynote.request("listNodes", { notebookId: book.id })
      ).find((item) => item.title === "统一文档验收");
      const fresh = await window.anynote.request("getNote", {
        notebookId: book.id,
        id: note.id,
      });
      await window.anynote.request("saveNote", {
        notebookId: book.id,
        id: note.id,
        expectedRevision: fresh.revision,
        body: "# 原有标题\n\n原有 __格式__\n\n" + opaque + "\n\n末尾段落",
      });
    },
    { opaque },
  );
  await page.reload();
  await openNotebook(page);
  await page
    .locator(".tree-main")
    .filter({ hasText: "统一文档验收" })
    .first()
    .click();
  await expect(input).toContainText("末尾段落");
  await expect(input.locator("pre")).toHaveCount(0);
  await input.locator("p").filter({ hasText: "末尾段落" }).click();
  await page.keyboard.press("End");
  await page.keyboard.insertText("追加文字");
  await expect.poll(async () => (await read()).body).toContain("追加文字");
  const preserved = (await read()).body;
  assert.ok(preserved.includes(opaque));
  assert.ok(preserved.includes("原有 __格式__"));

  // IME composition does not publish partial text; final text is saved afterwards.
  await input.dispatchEvent("compositionstart", { data: "中文" });
  await page.keyboard.insertText("组合输入");
  await input.dispatchEvent("compositionend", { data: "组合输入" });
  await expect.poll(async () => (await read()).body).toContain("组合输入");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "插入内容" })).toHaveCount(0);
  await page.keyboard.press("Backspace");
  await page.keyboard.type("> ");
  await page.keyboard.insertText("引用内容");
  await expect(input.locator("blockquote")).toContainText("引用内容");
  await expect.poll(async () => (await read()).body).toContain("引用内容");
  await page.getByText("已保存至本地", { exact: true }).waitFor();
  mkdirSync("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/document-editor.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: unified document, Markdown shortcuts, slash keyboard/click, tables, tasks, persistence, opaque preservation, IME completion",
  );
} finally {
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
