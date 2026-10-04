import { launchDesktop } from "./acceptance/electron-driver.mjs";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const root = mkdtempSync("/tmp/anynote-host-ui-");
const report = {
  format: "anynote.extension-host.v1",
  packaged: !!process.env.ANYNOTE_EXECUTABLE,
  status: "running",
  checks: [],
  accessibility: [],
};
let app, page;
const source = new Storage(join(root, "notebooks"));
const book = await source.run("createNotebook", { title: "扩展宿主验收" });
const other = await source.run("createNotebook", { title: "未授权空间" });
await source.run("createNode", {
  notebookId: book.id,
  title: "原始笔记",
  body: "原始内容",
});
source.close();
const request = (op, input) =>
  page.evaluate(({ op, input }) => window.anynote.request(op, input), {
    op,
    input,
  });
async function check(name, fn) {
  await fn();
  report.checks.push({ name, status: "passed" });
  console.log(name + " — passed");
}
async function scan(name) {
  const result = await new AxeBuilder({ page })
    .setLegacyMode(true)
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  report.accessibility.push({ name, violations: result.violations });
  assert.equal(result.violations.length, 0, JSON.stringify(result.violations));
}
const hostMetrics = () =>
  app.evaluate(({ app }) =>
    app
      .getAppMetrics()
      .filter((m) => m.name === "Anynote Extension Host")
      .map((m) => m.pid),
  );
try {
  ({ app, page } = await launchDesktop(root));
  page.setDefaultTimeout(15000);
  await page.getByRole("button", { name: "扩展", exact: true }).click();
  const panel = page.getByRole("region", { name: "首方扩展宿主", exact: true });
  await check("notebook-grant-and-lazy-activation", async () => {
    await expect(
      panel.getByRole("button", { name: "创建阅读记录", exact: true }),
    ).toBeDisabled();
    await panel
      .getByRole("button", { name: "授权阅读模板", exact: true })
      .click();
    await expect(panel.getByRole("status")).toHaveText("等待命令激活");
    assert.deepEqual(await hostMetrics(), []);
    await scan("Notebook 首方授权");
  });
  await check(
    "real-utility-process-command-creates-and-opens-note",
    async () => {
      await panel
        .getByRole("button", { name: "创建阅读记录", exact: true })
        .click();
      await expect(page.getByRole("textbox", { name: "笔记标题" })).toHaveValue(
        "阅读记录",
      );
      const nodes = await request("listNodes", { notebookId: book.id });
      const note = nodes.find((n) => n.title === "阅读记录");
      assert.ok(note);
      assert.match(
        (await request("getNote", { notebookId: book.id, id: note.id })).body,
        /关键观点/,
      );
      assert.equal((await hostMetrics()).length, 1);
      assert.equal(
        (await request("listNodes", { notebookId: other.id })).length,
        0,
      );
    },
  );
  await check(
    "command-palette-reuses-host-and-keeps-existing-notes",
    async () => {
      const pids = await hostMetrics();
      await page.keyboard.press("Control+k");
      await page
        .locator(".extension-commands button")
        .filter({ hasText: "创建阅读记录" })
        .click();
      await expect(page.getByRole("textbox", { name: "笔记标题" })).toHaveValue(
        "阅读记录",
      );
      await expect
        .poll(
          async () =>
            (await request("listNodes", { notebookId: book.id })).length,
        )
        .toBe(3);
      assert.deepEqual(await hostMetrics(), pids);
    },
  );
  await check(
    "disable-revokes-api-terminates-process-and-retains-notes",
    async () => {
      await page.getByRole("button", { name: "扩展", exact: true }).click();
      await expect(panel.getByRole("status")).toHaveText("运行中");
      await panel
        .getByRole("button", { name: "停用阅读模板", exact: true })
        .click();
      await expect(panel.getByRole("status")).toHaveText("未授权");
      await expect.poll(hostMetrics).toEqual([]);
      await expect(
        panel.getByRole("button", { name: "创建阅读记录", exact: true }),
      ).toBeDisabled();
      await assert.rejects(
        request("executeHostedExtensionCommand", {
          notebookId: book.id,
          extensionId: "anynote.reading-template",
          commandId: "anynote.reading-template.create",
        }),
        /授权/,
      );
      assert.equal(
        (await request("listNodes", { notebookId: book.id })).length,
        3,
      );
      await scan("首方扩展停用");
    },
  );
  await check("grant-does-not-cross-notebook-or-survive-restart", async () => {
    await assert.rejects(
      request("executeHostedExtensionCommand", {
        notebookId: other.id,
        extensionId: "anynote.reading-template",
        commandId: "anynote.reading-template.create",
      }),
      /授权/,
    );
    await panel
      .getByRole("button", { name: "授权阅读模板", exact: true })
      .click();
    await expect(panel.getByRole("status")).toHaveText("等待命令激活");
    await app.close();
    ({ app, page } = await launchDesktop(root));
    const rows = await request("listHostedExtensions", { notebookId: book.id });
    assert.equal(rows[0].enabled, false);
    assert.deepEqual(await hostMetrics(), []);
  });
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  throw error;
} finally {
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    `test-results/extension-host-${report.packaged ? "packaged" : "desktop"}.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
  await app?.close();
  rmSync(root, { recursive: true, force: true });
}
