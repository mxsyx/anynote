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
const suffix = Date.now(),
  name = "富文本验证 " + suffix,
  body =
    '# 标题\n\n这是 **原始段落**。\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n:::anynote{type="future.node" version="9" id="opaque"}\n{"unknown":"原样保留"}\n:::\n\n```js\nconsole.log("代码保持原样");\n```\n';
try {
  await page.goto("http://127.0.0.1:5173");
  await page.getByRole("textbox", { name: "笔记标题" }).waitFor();
  await page.getByRole("button", { name: "新建笔记", exact: true }).click();
  await page.getByPlaceholder("输入一个名称…").fill(name);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.locator(".cm-content").fill(body);
  await page.keyboard.press("Control+s");
  await page.getByText("已保存至本地", { exact: true }).waitFor();
  await page.getByRole("button", { name: "富文本 Beta", exact: true }).click();
  const block = page
    .locator(".rich-block")
    .filter({ hasText: "这是 原始段落" });
  await block.hover();
  await block.getByRole("button", { name: "编辑此块", exact: true }).click();
  await page.locator(".rich-input").waitFor();
  await page.locator(".rich-input").fill("修改后的富文本段落。");
  await page.getByRole("button", { name: "完成此块", exact: true }).click();
  await page.keyboard.press("Control+s");
  await page.getByText("已保存至本地", { exact: true }).waitFor();
  await page.getByRole("button", { name: "源码", exact: true }).click();
  const edited = await page.locator(".cm-content").innerText();
  assert.ok(edited.includes("修改后的富文本段落。"));
  const persisted = await page.evaluate(async (title) => {
    const rpc = async (op, input = {}) =>
      (
        await (
          await fetch("/api/rpc", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ op, input }),
          })
        ).json()
      ).result;
    for (const book of await rpc("listNotebooks")) {
      const note = (await rpc("listNodes", { notebookId: book.id })).find(
        (n) => n.title === title,
      );
      if (note)
        return {
          ...(await rpc("getNote", { notebookId: book.id, id: note.id })),
          notebookId: book.id,
        };
    }
  }, name);
  assert.ok(persisted.body.endsWith(body.slice(body.indexOf("| A"))));
  // Reopen a different block to check editor state does not leak from the previous block.
  await page.getByRole("button", { name: "富文本 Beta", exact: true }).click();
  const heading = page
    .locator(".rich-block")
    .filter({ has: page.getByRole("heading", { name: "标题", exact: true }) });
  await heading.hover();
  await heading.getByRole("button", { name: "编辑此块", exact: true }).click();
  assert.equal(await page.locator(".rich-input").innerText(), "标题");
  await page.locator(".rich-input").fill("新版标题");
  await page.getByRole("button", { name: "完成此块", exact: true }).click();
  await page.keyboard.press("Control+s");
  await page.getByText("已保存至本地", { exact: true }).waitFor();
  await page.getByRole("textbox", { name: "笔记标题" }).fill(name + " 新标题");
  await page.keyboard.press("Control+s");
  await page.getByText("已保存至本地", { exact: true }).waitFor();
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
  await page.getByRole("button", { name: "版本历史", exact: true }).click();
  await page
    .locator(".revision-card")
    .filter({ hasText: "这是 **原始段落**" })
    .first()
    .getByRole("button", { name: "恢复此版本", exact: true })
    .click();
  await page.getByText("已恢复历史版本", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("textbox", { name: "笔记标题" }).inputValue(),
    name,
  );
  await page.getByRole("button", { name: "阅读", exact: true }).click();
  await page.screenshot({
    path: "docs/screenshots/organization.png",
    fullPage: true,
  });
  const nameB = name + " B";
  await page.getByRole("button", { name: "新建笔记", exact: true }).click();
  await page.getByPlaceholder("输入一个名称…").fill(nameB);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  const rowA = page
      .locator(".tree-main")
      .filter({ hasText: new RegExp("^" + name + "$") })
      .locator(".."),
    rowB = page
      .locator(".tree-main")
      .filter({ hasText: new RegExp("^" + nameB + "$") })
      .locator("..");
  await rowB.dragTo(rowA, {
    sourcePosition: { x: 70, y: 18 },
    targetPosition: { x: 70, y: 2 },
  });
  await page.waitForFunction(
    ({ a, b }) => {
      const names = Array.from(document.querySelectorAll(".tree-main")).map(
        (el) => el.textContent,
      );
      return names.indexOf(b) >= 0 && names.indexOf(b) < names.indexOf(a);
    },
    { a: name, b: nameB },
  );
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("button", { name: "创建 Notebook", exact: true })
    .click();
  await page.getByPlaceholder("输入一个名称…").fill("跨库验证 " + suffix);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  const sourceName = "跨库引用 " + suffix;
  await page.getByRole("button", { name: "新建笔记", exact: true }).click();
  await page.getByPlaceholder("输入一个名称…").fill(sourceName);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page
    .locator(".cm-content")
    .fill(
      `[返回原库](anynote://notebook/${persisted.notebookId}/note/${persisted.id})`,
    );
  await page.keyboard.press("Control+s");
  await page.getByText("已保存至本地", { exact: true }).waitFor();
  await page.getByRole("button", { name: "阅读", exact: true }).click();
  await page.getByRole("link", { name: "返回原库", exact: true }).click();
  await page.waitForFunction(
    (title) =>
      document.querySelector('input[aria-label="笔记标题"]')?.value === title,
    name,
  );
  await page.locator(".backlinks summary").click();
  await page
    .locator(".backlinks")
    .getByRole("button", { name: new RegExp(sourceName) })
    .click();
  await page.waitForFunction(
    (title) =>
      document.querySelector('input[aria-label="笔记标题"]')?.value === title,
    sourceName,
  );
  await page
    .getByRole("button", { name: "本地优先，安心记录", exact: false })
    .click();
  await page.getByRole("button", { name: "预览清理", exact: true }).click();
  await page.getByText("将清理 0 个文件", { exact: false }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Organization UI passed: rich block edits, opaque/table/code preservation, different block initialization, title/history restoration, drag sorting, cross-Notebook links/backlinks and cleanup preview.",
  );
} catch (e) {
  await page.screenshot({
    path: "/tmp/anynote-organization-error.png",
    fullPage: true,
  });
  console.error(errors);
  throw e;
} finally {
  await browser.close();
}
