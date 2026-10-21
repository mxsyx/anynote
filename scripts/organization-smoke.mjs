import { multiPagePdf } from "./acceptance/pdf-fixture.mjs";
import { openNotebook } from "./acceptance/open-notebook.mjs";
import { chromium } from "playwright";
import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";

const browser = await chromium.launch({
  executablePath: process.env.ANYNOTE_BROWSER || "/usr/bin/google-chrome",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const output =
  process.env.ANYNOTE_SCREENSHOTS || "/tmp/anynote-g14-screenshots";
mkdirSync(output, { recursive: true });
try {
  await page.goto("http://127.0.0.1:5173");
  await openNotebook(page);
  const fixture = await page.evaluate(
    async (pdfData) => {
      const rpc = async (op, input = {}) => {
        const data = await (
          await fetch("/api/rpc", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ op, input }),
          })
        ).json();
        if (data.error) throw Error(data.error);
        return data.result;
      };
      const book = await rpc("createNotebook", {
        title: "G14 导航验收 " + Date.now(),
        icon: "✦",
        coverColor: "#663b36",
      });
      let parentId = null;
      for (let i = 0; i < 35; i++)
        parentId = (
          await rpc("createNode", {
            notebookId: book.id,
            title: `第 ${i} 层长标题目录`,
            kind: "folder",
            parentId,
          })
        ).id;
      const note = await rpc("createNode", {
        notebookId: book.id,
        title: "搜索定位长标题".repeat(12),
        parentId,
      });
      const target = await rpc("saveNote", {
        notebookId: book.id,
        id: note.id,
        expectedRevision: note.revision,
        body:
          "# 深目录笔记\n\n" +
          "普通段落。\n\n".repeat(100) +
          "这里是导航定位唯一标记。\n",
      });
      const source = await rpc("createNode", {
        notebookId: book.id,
        title: "失效链接来源",
      });
      const href = `anynote://notebook/${book.id}/note/${crypto.randomUUID()}`;
      await rpc("saveNote", {
        notebookId: book.id,
        id: source.id,
        expectedRevision: source.revision,
        body: `[坏链接](${href})\n\n原标签需要保留。`,
      });
      const other = await rpc("createNotebook", { title: "G14 跨库" });
      const otherNote = await rpc("createNode", {
        notebookId: other.id,
        title: "跨库导航目标",
      });
      const pdf = await rpc("importFile", {
        notebookId: book.id,
        name: "G14.pdf",
        mime: "application/pdf",
        data: pdfData,
      });
      const asset = await rpc("getAssetInfo", {
        notebookId: book.id,
        id: pdf.primary_resource_id,
        noteId: pdf.id,
      });
      await rpc("indexPdf", {
        notebookId: book.id,
        id: pdf.id,
        assetHash: asset.hash,
        body: "\n[第 1 页]\nAnynote page 1\n[第 2 页]\nAnynote page 2",
      });
      const annotation = await rpc("addAnnotation", {
        notebookId: book.id,
        id: pdf.id,
        assetHash: asset.hash,
        page: 2,
        quote: "page 2",
        body: "G14批注定位",
        selector: [{ x: 0.12, y: 0.25, width: 0.5, height: 0.1 }],
      });
      return { book, target, source, other, otherNote, pdf, annotation };
    },
    Buffer.from(multiPagePdf(2)).toString("base64"),
  );
  await page.reload();
  await page
    .getByRole("button", {
      name: `打开 Notebook：${fixture.book.name}`,
      exact: true,
    })
    .last()
    .click();
  const search = async (query) => {
    await page.getByRole("button", { name: "搜索笔记", exact: true }).click();
    await page
      .getByLabel("搜索范围", { exact: true })
      .selectOption(fixture.book.id);
    await page.getByPlaceholder("寻找一个想法，或一篇笔记…").fill(query);
    await expect(page.locator(".command-results > button")).toHaveCount(1);
  };

  await search("导航定位唯一标记");
  await expect(page.getByRole("region", { name: "选择预览" })).toContainText(
    "导航定位唯一标记",
  );
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "笔记标题" })).toHaveValue(
    fixture.target.title,
  );
  await page.waitForFunction(
    () => window.getSelection()?.toString() === "导航定位唯一标记",
  );
  await page.waitForFunction(() => {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return false;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    return rect.top > 90 && rect.bottom < innerHeight - 40;
  });
  await page.screenshot({ path: `${output}/search-location.png` });
  await search("失效链接来源");
  await page.keyboard.press("Enter");
  await page
    .getByRole("link", { name: "坏链接" })
    .click({ modifiers: ["ControlOrMeta"] });
  await expect(page.getByText("修复失效链接", { exact: true })).toBeVisible();
  await page
    .getByLabel("搜索范围", { exact: true })
    .selectOption(fixture.book.id);
  await page
    .getByPlaceholder("寻找一个想法，或一篇笔记…")
    .fill("导航定位唯一标记");
  await expect(page.locator(".command-results > button")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("link", { name: "坏链接" })).toHaveAttribute(
    "href",
    `anynote://notebook/${fixture.book.id}/note/${fixture.target.id}`,
  );
  await page
    .getByRole("link", { name: "坏链接" })
    .click({ modifiers: ["ControlOrMeta"] });
  await expect(page.getByRole("textbox", { name: "笔记标题" })).toHaveValue(
    fixture.target.title,
  );
  await page.getByRole("button", { name: "后退", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "笔记标题" })).toHaveValue(
    "失效链接来源",
  );
  await page.getByRole("button", { name: "前进", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "笔记标题" })).toHaveValue(
    fixture.target.title,
  );
  await page.getByRole("button", { name: "搜索笔记", exact: true }).click();
  await page
    .getByLabel("搜索范围", { exact: true })
    .selectOption(fixture.other.id);
  await page.getByPlaceholder("寻找一个想法，或一篇笔记…").fill("跨库导航目标");
  await expect(page.locator(".command-results > button")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "笔记标题" })).toHaveValue(
    "跨库导航目标",
  );
  await page.getByRole("button", { name: "后退", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "笔记标题" })).toHaveValue(
    fixture.target.title,
  );
  await search("Anynote page 2");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("PDF 页码", { exact: true })).toHaveValue("2");
  await search("G14批注定位");
  await page.keyboard.press("Enter");
  await expect(page.locator(".pdf-highlight.search-hit")).toHaveCount(1);
  await expect(page.locator(".annotation-card.search-hit")).toContainText(
    "G14批注定位",
  );
  await page.screenshot({ path: `${output}/pdf-annotation.png` });
  await page
    .getByRole("button", { name: "关闭标签：G14.pdf", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "G14.pdf", exact: true }),
  ).toHaveCount(0);

  await page
    .getByRole("tab", { name: fixture.target.title, exact: true })
    .click();
  const sourceRow = page
    .locator(`.tree-main[data-node-id="${fixture.source.id}"]`)
    .locator("..");
  const pdfRow = page
    .locator(`.tree-main[data-node-id="${fixture.pdf.id}"]`)
    .locator("..");
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/rpc") &&
        response.request().postDataJSON()?.op === "placeNode",
    ),
    pdfRow.dragTo(sourceRow, {
      sourcePosition: { x: 60, y: 18 },
      targetPosition: { x: 60, y: 2 },
    }),
  ]);
  await page.waitForFunction(
    ({ source, pdf }) => {
      const ids = Array.from(document.querySelectorAll(".tree-main")).map(
        (n) => n.dataset.nodeId,
      );
      return ids.indexOf(pdf) >= 0 && ids.indexOf(pdf) < ids.indexOf(source);
    },
    { source: fixture.source.id, pdf: fixture.pdf.id },
  );
  await expect(page.getByRole("tablist", { name: "打开的文档" })).toBeVisible();
  await page
    .getByRole("button", { name: "显示文档标签页", exact: true })
    .click();
  await expect(page.getByRole("tablist", { name: "打开的文档" })).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "显示文档标签页", exact: true })
    .click();
  if (
    !(await page.getByRole("button", { name: "属性", exact: true }).isVisible())
  )
    await page
      .getByRole("button", { name: "切换辅助面板", exact: true })
      .click();
  await page.getByRole("button", { name: "属性", exact: true }).click();
  await expect(page.locator(".note-properties")).toContainText("G14 导航验收");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/narrow-properties.png` });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.getByRole("button", { name: "关闭辅助面板", exact: true }).click();
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await page.screenshot({ path: `${output}/narrow-dark.png` });
  await page.getByRole("button", { name: "书橱", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "最近 Notebook" }),
  ).toContainText("本地快照");
  await page.screenshot({ path: `${output}/recent-books.png` });
  await page
    .getByRole("button", { name: "创建 Notebook", exact: true })
    .click();
  const createdName = "G14 新封面 " + Date.now();
  await page.getByPlaceholder("输入一个名称…").fill(createdName);
  await page.getByLabel("Notebook 图标", { exact: true }).fill("☘");
  await page.getByLabel("Notebook 封面色", { exact: true }).fill("#35483d");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("button", { name: "书橱", exact: true }).click();
  const created = page.getByRole("button", {
    name: `打开 Notebook：${createdName}`,
    exact: true,
  });
  await expect(created.locator(".spine-ornament")).toHaveText("☘");
  await expect(created).toHaveCSS("--binding", "#35483d");
  assert.deepEqual(errors, []);
  console.log(
    "Organization/G14 passed: real storage, 35-level tree, long titles, text/PDF/annotation location, preview, link repair, cross-book back/forward, tabs, properties, narrow/dark and recent paths/snapshots.",
  );
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` });
  throw error;
} finally {
  await browser.close();
}
