import { chromium } from "playwright";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  executablePath: process.env.ANYNOTE_BROWSER || "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } }),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const marker = "全局检索" + Date.now();
try {
  await page.goto("http://127.0.0.1:5173");
  await page.getByRole("textbox", { name: "笔记标题" }).waitFor();
  const fixture = await page.evaluate(async (marker) => {
    const rpc = async (op, input = {}) => {
      const response = await fetch("/api/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op, input }),
      });
      const data = await response.json();
      if (data.error) throw Error(data.error);
      return data.result;
    };
    const currentId = localStorage.getItem("anynote-book");
    const other = await rpc("createNotebook", {
      title: "跨库搜索验证" + marker,
    });
    const folder = await rpc("createNode", {
      notebookId: other.id,
      title: "搜索资料",
      kind: "folder",
    });
    const create = async (id, title, parentId = null, tags = []) => {
      const note = await rpc("createNode", {
        notebookId: id,
        title,
        kind: "note",
        parentId,
      });
      return rpc("saveNote", {
        notebookId: id,
        id: note.id,
        expectedRevision: note.revision,
        body: "命中正文：" + marker,
        tags,
      });
    };
    await create(currentId, "当前库结果 " + marker);
    const target = await create(other.id, "外部库结果 " + marker, folder.id, [
      "验证",
    ]);
    await rpc("importFile", {
      notebookId: other.id,
      name: marker + " 图片.png",
      mime: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=",
    });
    return { other, folder, target };
  }, marker);
  await page.reload();
  await page.getByRole("textbox", { name: "笔记标题" }).waitFor();
  await page.getByRole("button", { name: "搜索笔记", exact: true }).click();
  await page.getByPlaceholder("寻找一个想法，或一篇笔记…").fill(marker);
  await page.waitForFunction(
    () => document.querySelectorAll(".command-results > button").length === 1,
  );
  await page.getByLabel("搜索范围", { exact: true }).selectOption("all");
  await page.waitForFunction(
    () => document.querySelectorAll(".command-results > button").length === 3,
  );
  const target = page
    .locator(".command-results > button")
    .filter({ hasText: fixture.target.title });
  assert.ok((await target.innerText()).includes("搜索资料"));
  assert.ok((await target.innerText()).includes("命中正文"));
  await page.screenshot({
    path: "docs/screenshots/search.png",
    fullPage: true,
  });
  await target.click();
  await page.waitForFunction(
    (title) =>
      document.querySelector('input[aria-label="笔记标题"]')?.value === title,
    fixture.target.title,
  );
  await page.getByRole("button", { name: "搜索笔记", exact: true }).click();
  await page
    .getByLabel("搜索范围", { exact: true })
    .selectOption(fixture.other.id);
  await page
    .getByLabel("目录筛选", { exact: true })
    .selectOption(fixture.folder.id);
  await page.getByLabel("标签筛选", { exact: true }).fill("验证");
  await page.getByLabel("更新时间筛选", { exact: true }).selectOption("7");
  await page.waitForFunction(
    () => document.querySelectorAll(".command-results > button").length === 1,
  );
  assert.ok(
    (await page.locator(".command-results > button").innerText()).includes(
      fixture.target.title,
    ),
  );
  await page.getByLabel("目录筛选", { exact: true }).selectOption("");
  await page.getByLabel("标签筛选", { exact: true }).fill("");
  await page.getByLabel("笔记类型筛选", { exact: true }).selectOption("image");
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll(".command-results > button");
    return rows.length === 1 && rows[0].textContent.includes("图片.png");
  });
  await page
    .getByLabel("笔记类型筛选", { exact: true })
    .selectOption("markdown");
  await page
    .getByPlaceholder("寻找一个想法，或一篇笔记…")
    .fill("不会命中的内容");
  await page
    .getByText("没有找到这个想法。换一个关键词试试。", { exact: true })
    .waitFor();
  await page.getByPlaceholder("寻找一个想法，或一篇笔记…").fill(marker);
  await page.waitForFunction(
    () => document.querySelectorAll(".command-results > button").length === 1,
  );
  await page.keyboard.press("Enter");
  await page
    .getByRole("dialog", { name: "搜索笔记", exact: true })
    .waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
  console.log(
    "Search UI passed: global scope, cross-Notebook navigation, path/snippet, directory/tag/type/time filters, empty results and keyboard opening.",
  );
} catch (e) {
  await page.screenshot({
    path: "/tmp/anynote-search-error.png",
    fullPage: true,
  });
  throw e;
} finally {
  await browser.close();
}
