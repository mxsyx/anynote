import { DatabaseSync } from "node:sqlite";
import { expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { installableManifestSchema } from "../.build/packages/storage-sqlite/extension-catalog.js";
import { generateKeyPairSync } from "node:crypto";
import { signExtensionPackage } from "../.build/packages/storage-sqlite/extension-signature.js";
import { launchDesktop } from "./acceptance/electron-driver.mjs";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import assert from "node:assert/strict";
import AxeBuilder from "@axe-core/playwright";
import { join } from "node:path";
const root = mkdtempSync("/tmp/anynote-editor-ui-"),
  report = {
    format: "anynote.editor-ecosystem.v1",
    status: "running",
    startedAt: new Date().toISOString(),
    packaged: Boolean(process.env.ANYNOTE_EXECUTABLE),
    accessibility: [],
    checks: [],
  };
let app, page;
const opaque =
  ':::anynote{type="future.node" version="9" id="opaque" custom="retain"}\n{"unknown":"原样保留"}\n:::\n';
const body =
  "# 原始标题\n\n前文保留 **粗体**。\n\n| 列一 | 列二 |\n| --- | --- |\n| 甲 | 乙 |\n\n- [ ] 任务一\n- [x] 任务二\n\n" +
  opaque;
const s = new Storage(join(root, "notebooks")),
  book = await s.run("createNotebook", { title: "编辑与生态" }),
  note = await s.run("createNode", {
    notebookId: book.id,
    title: "编辑器验收",
    body,
  });
s.close();
const request = (op, input = {}) =>
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
async function saved() {
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(100);
  return request("getNote", { notebookId: book.id, id: note.id });
}
try {
  ({ app, page } = await launchDesktop(root));
  page.setDefaultTimeout(15000);
  mkdirSync("docs/screenshots/editor", { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  if (
    !(await page
      .getByRole("button", { name: "新建笔记", exact: true })
      .isVisible())
  )
    await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
  await check(
    "GFM-table-local-patch-preserves-opaque-and-untouched-regions",
    async () => {
      await page
        .getByRole("button", { name: "富文本 Beta", exact: true })
        .click();
      await page
        .locator(".rich-block")
        .filter({ hasText: "列一" })
        .getByRole("button", { name: "编辑此块", exact: true })
        .click();
      await scan("GFM-table-editor");
      await page.screenshot({ path: "docs/screenshots/editor/gfm-table.png" });
      const cell = page.locator(".rich-input td").first();
      await cell.click();
      await cell.evaluate((el) =>
        getSelection().selectAllChildren(el.querySelector("p")),
      );
      await page.keyboard.insertText("已改");
      await page.keyboard.press("Shift+Home");
      await page.getByRole("button", { name: "插入链接", exact: true }).click();
      await page
        .getByLabel("链接地址", { exact: true })
        .fill("https://example.com/editor");
      await page.getByRole("button", { name: "应用链接", exact: true }).click();
      await page.getByRole("button", { name: "完成此块", exact: true }).click();
      const n = await saved();
      assert.ok(n.body.includes("已改"));
      assert.ok(n.body.includes("https://example.com/editor"));
      assert.ok(n.body.startsWith("# 原始标题\n\n前文保留 **粗体**。\n\n"));
      assert.ok(n.body.endsWith(opaque));
    },
  );
  await check("GFM-tasks-checkbox-and-undo-redo", async () => {
    await page
      .locator(".rich-block")
      .filter({ hasText: "任务一" })
      .getByRole("button", { name: "编辑此块", exact: true })
      .click();
    await scan("GFM-task-editor");
    await page.locator('.rich-input input[type="checkbox"]').first().check();
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    assert.equal(
      await page
        .locator('.rich-input input[type="checkbox"]')
        .first()
        .isChecked(),
      false,
    );
    await page.getByRole("button", { name: "重做", exact: true }).click();
    assert.equal(
      await page
        .locator('.rich-input input[type="checkbox"]')
        .first()
        .isChecked(),
      true,
    );
    await page.getByRole("button", { name: "完成此块", exact: true }).click();
    assert.ok((await saved()).body.includes("- [x] 任务一"));
  });
  await check("source-search-replace-and-formatting", async () => {
    await page.getByRole("button", { name: "源码", exact: true }).click();
    await page.getByRole("button", { name: "搜索与替换", exact: true }).click();
    await page.locator(".cm-search").waitFor();
    const input = page.locator('.cm-search input[name="search"]');
    await input.fill("前文保留");
    await page.locator('.cm-search input[name="replace"]').fill("源码替换");
    await page.locator('.cm-search button[name="replaceAll"]').click();
    assert.ok((await saved()).body.includes("源码替换"));
    await input.fill("源码替换");
    await page.locator('.cm-search button[name="next"]').click();
    await page.locator('.cm-search button[name="close"]').click();
    await page.getByRole("button", { name: "加粗", exact: true }).click();
    assert.ok((await saved()).body.includes("**源码替换**"));
  });
  await check("block-move-slash-menu-and-composition-mode-guard", async () => {
    await page
      .getByRole("button", { name: "富文本 Beta", exact: true })
      .click();
    let block = page.locator(".rich-block").filter({ hasText: "源码替换" });
    await block.getByRole("button", { name: "上移此块", exact: true }).click();
    assert.ok((await saved()).body.startsWith("**源码替换**"));
    block = page.locator(".rich-block").filter({ hasText: "源码替换" });
    await block.getByRole("button", { name: "下移此块", exact: true }).click();
    await block.getByRole("button", { name: "编辑此块", exact: true }).click();
    const editor = page.locator(".rich-input");
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type("/");
    await page
      .getByRole("group", { name: "插入块", exact: true })
      .getByRole("button", { name: "代码块", exact: true })
      .click();
    await editor.dispatchEvent("compositionstart");
    await page.getByRole("button", { name: "源码", exact: true }).click();
    assert.equal(await editor.isVisible(), true);
    await editor.dispatchEvent("compositionend");
    await page.getByRole("button", { name: "源码", exact: true }).click();
    await page.locator(".cm-editor").waitFor();
    const n = await saved();
    assert.ok(n.body.includes("```"));
    assert.ok(n.body.endsWith(opaque));
  });
  await check("install-review-notebook-grant-and-command-panel", async () => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "扩展", exact: true }).click();
    await page
      .locator('.extension-install input[type="file"]')
      .setInputFiles("packages/plugin-sdk/src/examples/reading-callout.json");
    await scan("extension-install-review");
    await page.screenshot({
      path: "docs/screenshots/editor/extension-install.png",
    });
    await page
      .getByRole("button", { name: "确认安装扩展", exact: true })
      .click();
    await page
      .getByRole("button", { name: "授权当前 Notebook", exact: true })
      .click();
    await page.getByText("当前 Notebook 已授权", { exact: false }).waitFor();
    await page.keyboard.press("Control+k");
    await page
      .locator(".extension-commands button")
      .filter({ hasText: "插入阅读卡片" })
      .click();
    await page.getByRole("button", { name: "阅读", exact: true }).click();
    await page
      .locator(".plugin-block")
      .filter({ hasText: "记录值得留下的文字" })
      .waitFor();
    assert.ok((await saved()).body.includes("garden.reading.card"));
  });
  await check("declarative-node-edit-preserves-unknown-fields", async () => {
    const n = await request("getNote", { notebookId: book.id, id: note.id });
    await request("saveNote", {
      notebookId: book.id,
      id: note.id,
      expectedRevision: n.revision,
      body: n.body.replace(
        '"thought":"我的理解"',
        '"thought":"我的理解","future":"keep"',
      ),
    });
    await page.keyboard.press("Control+k");
    await page.getByPlaceholder("寻找一个想法，或一篇笔记…").fill(note.title);
    await page
      .locator(".command-results button")
      .filter({ hasText: note.title })
      .first()
      .click();
    await page
      .getByRole("button", { name: "富文本 Beta", exact: true })
      .click();
    await page
      .locator(".rich-block")
      .filter({ hasText: "记录值得留下的文字" })
      .getByRole("button", { name: "编辑此块", exact: true })
      .click();
    await scan("declarative-node-editor");
    await page.screenshot({
      path: "docs/screenshots/editor/extension-node.png",
    });
    await page.getByLabel("思考", { exact: true }).fill("新的理解");
    await page.getByRole("button", { name: "完成此块", exact: true }).click();
    const savedNote = await saved();
    assert.ok(savedNote.body.includes("新的理解"));
    assert.ok(savedNote.body.includes('"future":"keep"'));
    assert.ok(savedNote.body.includes(opaque));
  });
  await check(
    "disable-and-uninstall-fallback-retains-original-data",
    async () => {
      await page.getByRole("button", { name: "扩展", exact: true }).click();
      await page.getByRole("button", { name: "此库停用", exact: true }).click();
      await page.keyboard.press("Control+k");
      assert.equal(await page.locator(".extension-commands button").count(), 0);
      await page.keyboard.press("Escape");
      await page
        .getByRole("button", { name: "卸载并保留数据", exact: true })
        .click();
      await page.keyboard.press("Control+k");
      await page.getByPlaceholder("寻找一个想法，或一篇笔记…").fill(note.title);
      await page
        .locator(".command-results button")
        .filter({ hasText: note.title })
        .first()
        .click();
      await page.getByRole("button", { name: "阅读", exact: true }).click();
      await page
        .locator(".opaque-block")
        .filter({ hasText: "garden.reading.card" })
        .waitFor();
      assert.ok((await saved()).body.includes("新的理解"));
      await page.screenshot({
        path: "docs/screenshots/editor/extension-fallback.png",
      });
    },
  );
  await check("native-block-drag-preserves-opaque-source", async () => {
    await page
      .getByRole("button", { name: "富文本 Beta", exact: true })
      .click();
    const block = page
      .locator(".rich-block")
      .filter({ hasText: "future.node" });
    const target = page.locator(".rich-block").filter({ hasText: "原始标题" });
    await page.evaluate(() => {
      window.__dragEvents = [];
      for (const name of ["dragstart", "dragover", "drop", "dragend"])
        document.addEventListener(
          name,
          (e) =>
            window.__dragEvents.push({
              name,
              types: [...e.dataTransfer.types],
              tag: e.target.tagName,
            }),
          { capture: true },
        );
    });
    const handle = block.getByRole("button", { name: "拖动此块", exact: true });
    await handle.scrollIntoViewIfNeeded();
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 20, box.y + box.height / 2, {
      steps: 5,
    });
    await target.scrollIntoViewIfNeeded();
    const dest = await target.boundingBox();
    await page.mouse.move(dest.x + 20, dest.y + 10, { steps: 15 });
    await page.mouse.move(dest.x + 21, dest.y + 10);
    await page.mouse.up();
    const n = await saved();
    assert.ok(
      n.body.startsWith(opaque),
      JSON.stringify({
        body: n.body.slice(0, 200),
        events: await page.evaluate(() => window.__dragEvents),
      }),
    );
    const data = await page.evaluateHandle(() => {
      const d = new DataTransfer();
      d.setData("application/x-anynote-block", "foreign");
      return d;
    });
    await target.dispatchEvent("drop", { dataTransfer: data });
    await data.dispose();
    assert.equal((await saved()).body, n.body);
  });
  await check("image-width-persists-and-renders-in-reading-mode", async () => {
    const n = await request("getNote", { notebookId: book.id, id: note.id });
    await request("addResource", {
      notebookId: book.id,
      id: note.id,
      expectedRevision: n.revision,
      name: "尺寸验收.png",
      mime: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=",
    });
    await page.keyboard.press("Control+k");
    await page.getByPlaceholder("寻找一个想法，或一篇笔记…").fill(note.title);
    await page
      .locator(".command-results button")
      .filter({ hasText: note.title })
      .first()
      .click();
    await page
      .getByRole("button", { name: "富文本 Beta", exact: true })
      .click();
    const block = page.locator(".rich-block").filter({
      has: page.getByRole("img", { name: "尺寸验收.png", exact: true }),
    });
    await block.getByRole("button", { name: "编辑此块", exact: true }).click();
    await page.getByLabel("图片宽度（像素）", { exact: true }).fill("320");
    await page
      .getByRole("button", { name: "应用图片尺寸", exact: true })
      .click();
    assert.ok((await saved()).body.includes('"width":320'));
    await scan("image-width-editor");
    await page
      .getByLabel("图片宽度（像素）", { exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: "docs/screenshots/editor/image-width.png" });
    await page.getByRole("button", { name: "完成此块", exact: true }).click();
    await page.getByRole("button", { name: "阅读", exact: true }).click();
    const img = page.getByRole("img", { name: "尺寸验收.png", exact: true });
    await page.locator(".rich-document").waitFor({ state: "hidden" });
    await img.waitFor();
    assert.equal(Math.round((await img.boundingBox()).width), 320);
    await page
      .getByRole("button", { name: "富文本 Beta", exact: true })
      .click();
    await page
      .locator(".rich-block")
      .filter({ has: img })
      .getByRole("button", { name: "编辑此块", exact: true })
      .click();
    await page.getByRole("button", { name: "自适应宽度", exact: true }).click();
    assert.ok(!(await saved()).body.includes('"width":320'));
    await page.getByRole("button", { name: "完成此块", exact: true }).click();
  });
  await check("script-install-review-grant-transform-and-revoke", async () => {
    await page.getByRole("button", { name: "扩展", exact: true }).click();
    const invalid = join(root, "invalid-extension.json");
    writeFileSync(
      invalid,
      JSON.stringify({
        name: { toString: null },
        version: "0.1.0",
        runtime: "quickjs-transform",
        permissions: [],
      }),
    );
    await page
      .locator('.extension-install input[type="file"]')
      .setInputFiles(invalid);
    await page.getByRole("alert").filter({ hasText: "格式无效" }).waitFor();
    await page
      .locator('.extension-install input[type="file"]')
      .setInputFiles("packages/plugin-sdk/src/examples/reading-transform.json");
    await page.getByText("此扩展包含脚本：", { exact: false }).waitFor();
    await scan("script-install-review");
    await page
      .getByRole("button", { name: "确认安装扩展", exact: true })
      .click();
    await page
      .getByRole("button", { name: "授权当前 Notebook", exact: true })
      .click();
    await page.getByText("当前 Notebook 已授权", { exact: false }).waitFor();
    await page.keyboard.press("Control+k");
    await page
      .locator(".extension-commands button")
      .filter({ hasText: "追加阅读字数摘要" })
      .click();
    await page.getByRole("button", { name: "阅读", exact: true }).click();
    await page
      .getByRole("heading", { name: "阅读统计", exact: true })
      .waitFor();
    const n = await saved();
    assert.ok(n.body.includes("正文字符数"));
    assert.ok(n.body.includes(opaque));
    await page.getByRole("button", { name: "扩展", exact: true }).click();
    await page
      .getByRole("button", { name: "撤销当前 Notebook 授权", exact: true })
      .click();
    await page.getByText("当前 Notebook 未授权", { exact: false }).waitFor();
    await page.keyboard.press("Control+k");
    assert.equal(await page.locator(".extension-commands button").count(), 0);
    await page.keyboard.press("Escape");
    await page.screenshot({
      path: "docs/screenshots/editor/script-revoked.png",
    });
    assert.equal((await saved()).body, n.body);
  });
  await check(
    "script-budget-failure-keeps-body-and-service-responsive",
    async () => {
      const loop = JSON.parse(
        readFileSync(
          "packages/plugin-sdk/src/examples/reading-transform.json",
          "utf8",
        ),
      );
      loop.id = "garden.loop";
      loop.name = "循环预算验收";
      loop.contributes.commands[0].id = "garden.loop.test";
      loop.contributes.commands[0].title = "运行循环预算验收";
      loop.contributes.commands[0].action.script = "()=>{while(true){}}";
      const fixture = join(root, "loop-extension.json");
      writeFileSync(fixture, JSON.stringify(loop));
      await page.getByRole("button", { name: "扩展", exact: true }).click();
      await page
        .locator('.extension-install input[type="file"]')
        .setInputFiles(fixture);
      await page
        .getByRole("button", { name: "确认安装扩展", exact: true })
        .click();
      const card = page
        .locator(".installed-extension")
        .filter({ hasText: "循环预算验收" });
      await card
        .getByRole("button", { name: "授权当前 Notebook", exact: true })
        .click();
      await card.getByText("当前 Notebook 已授权", { exact: false }).waitFor();
      const before = await saved();
      await page.keyboard.press("Control+k");
      await page
        .locator(".extension-commands button")
        .filter({ hasText: "运行循环预算验收" })
        .click();
      await page.waitForTimeout(50);
      const started = performance.now();
      const current = await request("getNote", {
        notebookId: book.id,
        id: note.id,
      });
      report.scriptReadMs = +(performance.now() - started).toFixed(2);
      assert.ok(report.scriptReadMs < 150, "读取不应等待脚本执行结束");
      assert.equal(current.body, before.body);
      await page
        .locator(".extension-commands")
        .getByRole("alert")
        .filter({ hasText: "脚本" })
        .waitFor();
      await page.keyboard.press("Escape");
      await card
        .getByRole("button", { name: "卸载并保留数据", exact: true })
        .click();
      assert.equal((await saved()).body, before.body);
    },
  );
  await check("签名包审核、独立信任、Notebook 授权与撤销来源", async () => {
    const manifest = JSON.parse(
      readFileSync("packages/plugin-sdk/src/examples/reading-transform.json"),
    );
    manifest.id = "garden.signed";
    manifest.name = "签名扩展验收";
    manifest.contributes.commands[0].id = "garden.signed.run";
    const pack = signExtensionPackage(
      manifest,
      "验收发布者",
      generateKeyPairSync("ed25519").privateKey,
    );
    const fixture = join(root, "signed-extension.json");
    writeFileSync(fixture, JSON.stringify(pack));
    await page.getByRole("button", { name: "扩展", exact: true }).click();
    await page
      .locator('.extension-install input[type="file"]')
      .setInputFiles(fixture);
    await page.getByText("尚未信任", { exact: false }).waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "确认安装扩展", exact: true })
        .isDisabled(),
      true,
    );
    await scan("签名扩展审核与公钥指纹");
    await page
      .getByRole("button", { name: "已核对指纹，信任发布者", exact: true })
      .click();
    await page
      .getByRole("button", { name: "确认安装扩展", exact: true })
      .click();
    const card = page
      .locator(".installed-extension")
      .filter({ hasText: "签名扩展验收" });
    await card.getByText("当前 Notebook 未授权", { exact: false }).waitFor();
    await card
      .getByRole("button", { name: "授权当前 Notebook", exact: true })
      .click();
    await card.getByText("当前 Notebook 已授权", { exact: false }).waitFor();
    await page
      .getByRole("button", { name: "撤销发布者信任", exact: true })
      .click();
    await card.getByText("信任已撤销", { exact: false }).waitFor();
    assert.equal(
      await card
        .getByRole("button", { name: "授权当前 Notebook", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      (await request("listExtensionCommands", { notebookId: book.id })).some(
        (c) => c.extensionId === manifest.id,
      ),
      false,
    );
    await scan("撤销发布者信任后的扩展状态");
    await card
      .getByRole("button", { name: "卸载并保留数据", exact: true })
      .click();
  });
  await check("远程签名下载、取消与手动更新审核", async () => {
    const manifest = JSON.parse(
      readFileSync("packages/plugin-sdk/src/examples/reading-transform.json"),
    );
    manifest.id = "garden.remote";
    manifest.name = "远程扩展验收";
    manifest.contributes.commands[0].id = "garden.remote.run";
    const key = generateKeyPairSync("ed25519").privateKey;
    const initial = signExtensionPackage(manifest, "远程界面验收发布者", key);
    const update = signExtensionPackage(
      { ...manifest, version: "0.1.1" },
      "远程界面验收发布者",
      key,
    );
    report.remoteTransport =
      "controlled HTTPS response fixture in the actual Storage utility process";
    // Controlled transport fixture in the test inspector only; production builds contain no test network bypass.
    await app.evaluateStorage((_electron, payload) => {
      const https = process.getBuiltinModule("node:https");
      const { EventEmitter } = process.getBuiltinModule("node:events");
      const { Readable } = process.getBuiltinModule("node:stream");
      globalThis.__remoteOriginalGet = https.get;
      globalThis.__remotePayload = payload;
      globalThis.__remoteStalled = true;
      https.get = (url, options, callback) => {
        if (url.href !== "https://8.8.8.8/extension.json")
          return globalThis.__remoteOriginalGet(url, options, callback);
        const req = new EventEmitter();
        req.destroy = (error) => {
          queueMicrotask(() => req.emit("error", error));
          return req;
        };
        options.signal.addEventListener(
          "abort",
          () => req.destroy(Error("fixture request cancelled")),
          { once: true },
        );
        if (!globalThis.__remoteStalled)
          queueMicrotask(() => {
            const res = Readable.from([
              Buffer.from(globalThis.__remotePayload),
            ]);
            res.statusCode = 200;
            res.headers = { "content-type": "application/json" };
            callback(res);
          });
        return req;
      };
    }, JSON.stringify(initial));
    try {
      await page.getByRole("button", { name: "扩展", exact: true }).click();
      await page
        .getByRole("textbox", { name: "签名扩展 HTTPS 地址", exact: true })
        .fill("https://8.8.8.8/extension.json");
      await page
        .getByRole("button", { name: "下载并审核扩展", exact: true })
        .click();
      await page
        .getByRole("button", { name: "取消扩展下载", exact: true })
        .waitFor();
      const before = performance.now();
      await request("getNote", { notebookId: book.id, id: note.id });
      report.downloadReadMs = +(performance.now() - before).toFixed(2);
      assert.ok(report.downloadReadMs < 150, "下载不能阻塞笔记读取");
      await page
        .getByRole("button", { name: "取消扩展下载", exact: true })
        .click();
      await page
        .getByRole("alert")
        .filter({ hasText: "扩展下载已取消" })
        .waitFor();
      await app.evaluateStorage(() => {
        globalThis.__remoteStalled = false;
      });
      await page
        .getByRole("button", { name: "下载并审核扩展", exact: true })
        .click();
      await page
        .locator(".extension-review")
        .getByText("下载来源：", { exact: false })
        .waitFor();
      await scan("远程签名包下载来源审核");
      await page.screenshot({
        path: "docs/screenshots/editor/remote-extension-review.png",
      });
      await page
        .getByRole("button", { name: "已核对指纹，信任发布者", exact: true })
        .click();
      await page
        .getByRole("button", { name: "确认安装扩展", exact: true })
        .click();
      const card = page
        .locator(".installed-extension")
        .filter({ hasText: "远程扩展验收" });
      await card
        .getByRole("button", { name: "授权当前 Notebook", exact: true })
        .click();
      await card.getByText("当前 Notebook 已授权", { exact: false }).waitFor();
      await card
        .getByRole("button", { name: "检查扩展更新", exact: true })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "已是最新版本" })
        .waitFor();
      await card.getByText("当前 Notebook 已授权", { exact: false }).waitFor();
      await app.evaluateStorage((_electron, payload) => {
        globalThis.__remotePayload = payload;
      }, JSON.stringify(update));
      await card
        .getByRole("button", { name: "检查扩展更新", exact: true })
        .click();
      await page
        .locator(".extension-review")
        .getByText("版本 0.1.1", { exact: false })
        .waitFor();
      await scan("远程更新审核与重新授权提示");
      await page
        .getByRole("button", { name: "确认安装扩展", exact: true })
        .click();
      await card.getByText("当前 Notebook 未授权", { exact: false }).waitFor();
      await card.getByText("0.1.1", { exact: false }).waitFor();
      await card
        .getByRole("button", { name: "卸载并保留数据", exact: true })
        .click();
    } finally {
      await app.evaluateStorage(() => {
        process.getBuiltinModule("node:https").get =
          globalThis.__remoteOriginalGet;
      });
    }
  });
  await check("扩展目录配置、搜索、签名核对与独立授权", async () => {
    const manifest = JSON.parse(
      readFileSync("packages/plugin-sdk/src/examples/reading-transform.json"),
    );
    manifest.id = "garden.directory";
    manifest.name = "目录阅读扩展";
    manifest.contributes.commands[0].id = "garden.directory.run";
    const pack = signExtensionPackage(
      manifest,
      "目录界面验收发布者",
      generateKeyPairSync("ed25519").privateKey,
    );
    const normalized = installableManifestSchema.parse(manifest);
    const entry = {
      id: normalized.id,
      name: normalized.name,
      version: normalized.version,
      runtime: normalized.runtime,
      description: normalized.description,
      permissions: normalized.permissions,
      url: "https://8.8.8.8/directory-plugin.json",
      checksum: createHash("sha256")
        .update(JSON.stringify(normalized))
        .digest("hex"),
      fingerprint: (await request("previewExtension", { package: pack })).source
        .fingerprint,
    };
    const listing = {
      format: "anynote.extension-directory.v1",
      name: "阅读扩展目录",
      entries: [entry],
    };
    await app.evaluateStorage(
      (_electron, payload) => {
        const https = process.getBuiltinModule("node:https"),
          { Readable } = process.getBuiltinModule("node:stream"),
          { EventEmitter } = process.getBuiltinModule("node:events");
        globalThis.__directoryOriginalGet = https.get;
        https.get = (url, options, callback) => {
          const body =
            url.href === "https://8.8.8.8/directory.json"
              ? payload.index
              : url.href === "https://8.8.8.8/directory-plugin.json"
                ? payload.package
                : null;
          if (!body)
            return globalThis.__directoryOriginalGet(url, options, callback);
          const req = new EventEmitter();
          req.destroy = (error) => {
            queueMicrotask(() => req.emit("error", error));
            return req;
          };
          options.signal.addEventListener(
            "abort",
            () => req.destroy(Error("cancelled")),
            { once: true },
          );
          queueMicrotask(() => {
            const res = Readable.from([Buffer.from(body)]);
            res.statusCode = 200;
            res.headers = { "content-type": "application/json" };
            callback(res);
          });
          return req;
        };
      },
      { index: JSON.stringify(listing), package: JSON.stringify(pack) },
    );
    try {
      await page.getByRole("button", { name: "扩展", exact: true }).click();
      const section = page.getByRole("region", {
        name: "扩展目录",
        exact: true,
      });
      await section
        .getByRole("textbox", { name: "目录名称", exact: true })
        .fill("我的阅读目录");
      await section
        .getByRole("textbox", { name: "目录 HTTPS 地址", exact: true })
        .fill("https://8.8.8.8/directory.json");
      await section
        .getByRole("button", { name: "保存扩展目录", exact: true })
        .click();
      await section
        .getByRole("button", { name: "刷新目录", exact: true })
        .click();
      await section
        .getByRole("status")
        .filter({ hasText: "找到 1 个扩展" })
        .waitFor();
      await scan("目录来源、条目与搜索");
      await section
        .getByRole("searchbox", { name: "搜索目录扩展", exact: true })
        .fill("找不到");
      await section
        .getByRole("status")
        .filter({ hasText: "找到 0 个扩展" })
        .waitFor();
      await section
        .getByRole("searchbox", { name: "搜索目录扩展", exact: true })
        .fill("阅读");
      await section
        .getByRole("button", { name: "下载目录扩展并审核", exact: true })
        .click();
      const review = page.locator(".extension-review");
      await review
        .getByText("检查扩展：目录阅读扩展", { exact: true })
        .waitFor();
      assert.equal(
        await review
          .getByRole("button", { name: "确认安装扩展", exact: true })
          .isDisabled(),
        true,
      );
      await scan("目录下载后的独立签名审核");
      await review.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: "docs/screenshots/editor/directory-extension-review.png",
      });
      await review
        .getByRole("button", { name: "已核对指纹，信任发布者", exact: true })
        .click();
      await review
        .getByRole("button", { name: "确认安装扩展", exact: true })
        .click();
      const card = page
        .locator(".installed-extension")
        .filter({ hasText: "目录阅读扩展" });
      await card.getByText("当前 Notebook 未授权", { exact: false }).waitFor();
      await card
        .getByRole("button", { name: "授权当前 Notebook", exact: true })
        .click();
      await card.getByText("当前 Notebook 已授权", { exact: false }).waitFor();
      await section
        .getByRole("button", { name: "移除目录", exact: true })
        .click();
      await section.getByText("尚未添加扩展目录。", { exact: true }).waitFor();
      await card.getByText("当前 Notebook 已授权", { exact: false }).waitFor();
      await card
        .getByRole("button", { name: "卸载并保留数据", exact: true })
        .click();
    } finally {
      await app.evaluateStorage(() => {
        process.getBuiltinModule("node:https").get =
          globalThis.__directoryOriginalGet;
      });
    }
  });
  await check("有状态脚本授权、重复执行与卸载保留数据", async () => {
    const readState = () => {
      const db = new DatabaseSync(
        join(root, "notebooks", book.id, "notebook.sqlite"),
        { readOnly: true },
      );
      try {
        return JSON.parse(
          db
            .prepare(
              "SELECT value_json FROM extension_data WHERE extension_id='garden.session' AND key='script:state'",
            )
            .get()?.value_json || "null",
        );
      } finally {
        db.close();
      }
    };
    await assert.rejects(
      request("extensionGetState", {
        notebookId: book.id,
        extensionId: "garden.session",
        key: "script:state",
      }),
      /未授权请求/,
    );
    await page
      .locator('.extension-install input[type="file"]')
      .setInputFiles("packages/plugin-sdk/src/examples/reading-session.json");
    const review = page.locator(".extension-review");
    await review
      .locator("p")
      .filter({ hasText: "请求权限：" })
      .filter({ hasText: "settings:read" })
      .waitFor();
    await review.getByText("正文与状态同时提交", { exact: false }).waitFor();
    await scan("有状态脚本权限审核");
    await page
      .getByRole("button", { name: "确认安装扩展", exact: true })
      .click();
    const card = () =>
      page.locator(".installed-extension").filter({ hasText: "阅读整理记录" });
    await card()
      .getByRole("button", { name: "授权当前 Notebook", exact: true })
      .click();
    for (let runs = 1; runs <= 2; runs++) {
      await page.keyboard.press("Control+k");
      await page
        .locator(".extension-commands button")
        .filter({ hasText: "记录一次阅读整理" })
        .click();
      await page.getByRole("button", { name: "阅读", exact: true }).click();
      await page
        .getByText(`本 Notebook 第 ${runs} 次整理。`, { exact: false })
        .waitFor();
      const state = readState();
      assert.equal(state.runs, runs);
      assert.equal(state.lastTitle, "编辑器验收");
      assert.ok((await saved()).body.includes(opaque));
    }
    await scan("有状态脚本运行结果");
    await page
      .getByText("本 Notebook 第 2 次整理。", { exact: false })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: "docs/screenshots/editor/stateful-script.png",
    });
    await page.getByRole("button", { name: "扩展", exact: true }).click();
    await card()
      .getByRole("button", { name: "撤销当前 Notebook 授权", exact: true })
      .click();
    await card().getByText("当前 Notebook 未授权", { exact: false }).waitFor();
    await card()
      .getByRole("button", { name: "卸载并保留数据", exact: true })
      .click();
    assert.equal(readState().runs, 2);
  });
  await check("声明式设置授权、冲突、保存与脚本应用", async () => {
    await page
      .locator('.extension-install input[type="file"]')
      .setInputFiles(
        "packages/plugin-sdk/src/examples/reading-preferences.json",
      );
    await page
      .locator(".extension-review")
      .getByRole("heading", { name: "检查扩展：可配置阅读摘要", exact: true })
      .waitFor();
    await scan("设置贡献安装审核");
    await page
      .getByRole("button", { name: "确认安装扩展", exact: true })
      .click();
    const card = () =>
      page
        .locator(".installed-extension")
        .filter({ hasText: "可配置阅读摘要" });
    assert.equal(
      await card().getByRole("form", { name: "当前 Notebook 设置" }).count(),
      0,
    );
    const entry = (
      await request("listExtensions", { notebookId: book.id })
    ).find((e) => e.manifest.id === "garden.preferences");
    const base = {
      notebookId: book.id,
      extensionId: entry.manifest.id,
      checksum: entry.checksum,
    };
    await assert.rejects(
      request("getInstalledExtensionSettings", base),
      /未授权/,
    );
    await card()
      .getByRole("button", { name: "授权当前 Notebook", exact: true })
      .click();
    const form = () =>
      card().getByRole("form", { name: "当前 Notebook 设置", exact: true });
    const heading = () =>
      form().getByRole("textbox", { name: "摘要标题", exact: true });
    const target = () =>
      form().getByRole("spinbutton", { name: "目标篇数", exact: true });
    const enabled = () =>
      form().getByRole("checkbox", { name: "追加整理摘要", exact: true });
    await heading().waitFor();
    await expect(heading()).toHaveValue("阅读目标");
    await heading().fill("草稿设置");
    await target().fill("7");
    await enabled().uncheck();
    await form()
      .getByRole("button", { name: "保存扩展设置", exact: true })
      .click();
    await form()
      .getByRole("status")
      .filter({ hasText: "已保存当前 Notebook 设置" })
      .waitFor();
    const saved = await request("getInstalledExtensionSettings", base);
    assert.equal(saved.values.enabled, false);
    await request("saveInstalledExtensionSettings", {
      ...base,
      expectedRevision: saved.revision,
      values: { heading: "外部更新", target: 9, enabled: false },
    });
    await heading().fill("自定义阅读目标");
    await target().fill("7");
    await enabled().check();
    await form()
      .getByRole("button", { name: "保存扩展设置", exact: true })
      .click();
    await form()
      .getByRole("alert")
      .filter({ hasText: "设置版本冲突" })
      .waitFor();
    await scan("设置冲突提示与重新加载");
    await form()
      .getByRole("button", { name: "重新加载设置", exact: true })
      .click();
    await expect(target()).toHaveValue("9");
    await heading().fill("自定义阅读目标");
    await target().fill("7");
    await enabled().check();
    await form()
      .getByRole("button", { name: "保存扩展设置", exact: true })
      .click();
    await form()
      .getByRole("status")
      .filter({ hasText: "已保存当前 Notebook 设置" })
      .waitFor();
    await scan("当前 Notebook 扩展设置表单");
    await form().scrollIntoViewIfNeeded();
    await page.screenshot({
      path: "docs/screenshots/editor/extension-settings.png",
    });
    await page.keyboard.press("Control+k");
    await page
      .locator(".extension-commands button")
      .filter({ hasText: "按设置追加阅读目标" })
      .click();
    await page.getByRole("button", { name: "阅读", exact: true }).click();
    await page
      .getByRole("heading", { name: "自定义阅读目标", exact: true })
      .waitFor();
    await page.getByText("目标：7 篇。", { exact: true }).waitFor();
    assert.ok(
      (
        await request("getNote", { notebookId: book.id, id: note.id })
      ).body.includes(opaque),
    );
    await page.getByRole("button", { name: "扩展", exact: true }).click();
    await card()
      .getByRole("button", { name: "撤销当前 Notebook 授权", exact: true })
      .click();
    await card().getByText("当前 Notebook 未授权", { exact: false }).waitFor();
    assert.equal(
      await card().getByRole("form", { name: "当前 Notebook 设置" }).count(),
      0,
    );
    await assert.rejects(
      request("getInstalledExtensionSettings", base),
      /未授权/,
    );
    await card()
      .getByRole("button", { name: "卸载并保留数据", exact: true })
      .click();
  });
  await check("扩展数据迁移预览、原子备份与恢复后再次迁移", async () => {
    const readData = (extensionId, key) => {
      const db = new DatabaseSync(
        join(root, "notebooks", book.id, "notebook.sqlite"),
        { readOnly: true },
      );
      try {
        return {
          ...db
            .prepare(
              "SELECT value_json,schema_version,revision FROM extension_data WHERE extension_id=? AND key=?",
            )
            .get(extensionId, key),
        };
      } finally {
        db.close();
      }
    };
    const install = async (name, title) => {
      await page
        .locator('.extension-install input[type="file"]')
        .setInputFiles(
          `packages/plugin-sdk/src/examples/reading-${name}-v2.json`,
        );
      await page
        .locator(".extension-review")
        .getByText(title, { exact: false })
        .first()
        .waitFor();
      await page
        .getByRole("button", { name: "确认安装扩展", exact: true })
        .click();
      const card = page
        .locator(".installed-extension")
        .filter({ hasText: title });
      await card
        .getByRole("button", { name: "授权当前 Notebook", exact: true })
        .click();
      await card
        .getByRole("region", { name: "扩展数据迁移与恢复", exact: true })
        .waitFor();
      return card;
    };
    const initialSettings = readData("garden.preferences", "settings:form");
    const card = await install("preferences", "可配置阅读摘要");
    const form = () =>
      card.getByRole("form", { name: "当前 Notebook 设置", exact: true });
    const controls = () =>
      card.getByRole("region", { name: "扩展数据迁移与恢复", exact: true });
    const migration = () =>
      card.getByRole("button", {
        name: "预览迁移：阅读目标字段升级",
        exact: true,
      });
    await form().getByRole("alert").filter({ hasText: "需先迁移" }).waitFor();
    await migration().click();
    await expect(
      controls().getByLabel("修改前数据", { exact: true }),
    ).toContainText('"target":7');
    await expect(
      controls().getByLabel("修改后数据", { exact: true }),
    ).toContainText('"goal":7');
    assert.deepEqual(
      readData("garden.preferences", "settings:form"),
      initialSettings,
    );
    await scan("扩展设置迁移预览");
    await controls().locator(".extension-data-review").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: "docs/screenshots/editor/extension-data-migration.png",
    });
    await controls()
      .getByRole("button", { name: "取消预览", exact: true })
      .click();
    assert.deepEqual(
      readData("garden.preferences", "settings:form"),
      initialSettings,
    );
    await migration().click();
    await controls()
      .getByRole("button", { name: "确认迁移并备份", exact: true })
      .click();
    await expect(
      form().getByRole("spinbutton", { name: "每周目标篇数", exact: true }),
    ).toHaveValue("7");
    await expect(card.locator(".extension-data-backup")).toHaveCount(1);
    await card.getByRole("button", { name: "预览恢复", exact: true }).click();
    await expect(
      controls().getByLabel("修改后数据", { exact: true }),
    ).toHaveText(initialSettings.value_json);
    await scan("扩展数据恢复预览");
    await controls()
      .getByRole("button", { name: "确认恢复并备份", exact: true })
      .click();
    await form().getByRole("alert").filter({ hasText: "需先迁移" }).waitFor();
    assert.equal(
      readData("garden.preferences", "settings:form").value_json,
      initialSettings.value_json,
    );
    await expect(card.locator(".extension-data-backup")).toHaveCount(2);
    await migration().click();
    await controls()
      .getByRole("button", { name: "确认迁移并备份", exact: true })
      .click();
    await expect(
      form().getByRole("spinbutton", { name: "每周目标篇数", exact: true }),
    ).toHaveValue("7");
    await expect(card.locator(".extension-data-backup")).toHaveCount(3);
    const stateCard = await install("session", "阅读整理记录");
    const stateControls = () =>
      stateCard.getByRole("region", {
        name: "扩展数据迁移与恢复",
        exact: true,
      });
    await stateCard
      .getByRole("button", { name: "预览迁移：整理次数升级", exact: true })
      .click();
    await expect(
      stateControls().getByLabel("修改后数据", { exact: true }),
    ).toContainText('"visits":2');
    await scan("脚本状态版本迁移预览");
    await stateControls()
      .getByRole("button", { name: "确认迁移并备份", exact: true })
      .click();
    await expect(stateCard.locator(".extension-data-backup")).toHaveCount(1);
    assert.equal(readData("garden.session", "script:state").schema_version, 2);
    await page.keyboard.press("Control+k");
    await page
      .locator(".extension-commands button")
      .filter({ hasText: "记录一次阅读整理" })
      .click();
    await page.getByRole("button", { name: "阅读", exact: true }).click();
    await page
      .getByText("本 Notebook 第 3 次整理。", { exact: false })
      .waitFor();
    assert.equal(
      JSON.parse(readData("garden.session", "script:state").value_json).visits,
      3,
    );
    assert.ok((await saved()).body.includes(opaque));
    await page.getByRole("button", { name: "扩展", exact: true }).click();
    await stateCard
      .getByRole("button", { name: "预览恢复", exact: true })
      .click();
    await stateControls()
      .getByRole("button", { name: "确认恢复并备份", exact: true })
      .click();
    await expect(stateCard.locator(".extension-data-backup")).toHaveCount(2);
    assert.equal(readData("garden.session", "script:state").schema_version, 1);
    assert.equal(
      JSON.parse(readData("garden.session", "script:state").value_json).runs,
      2,
    );
    await stateCard
      .getByRole("button", { name: "预览迁移：整理次数升级", exact: true })
      .click();
    await stateControls()
      .getByRole("button", { name: "确认迁移并备份", exact: true })
      .click();
    await expect(stateCard.locator(".extension-data-backup")).toHaveCount(3);
    assert.equal(readData("garden.session", "script:state").schema_version, 2);
  });
  await check("迁移备份选择清理、输入确认与卸载后完整清理", async () => {
    const cleanup = () =>
      page.getByRole("region", { name: "插件数据清理", exact: true });
    const entry = () =>
      cleanup().getByRole("article", {
        name: "garden.preferences",
        exact: true,
      });
    const card = () =>
      page
        .locator(".installed-extension")
        .filter({ hasText: "可配置阅读摘要" });
    const before = await request("getNote", {
      notebookId: book.id,
      id: note.id,
    });
    const countRows = () => {
      const db = new DatabaseSync(
        join(root, "notebooks", book.id, "notebook.sqlite"),
        { readOnly: true },
      );
      try {
        return db
          .prepare(
            "SELECT count(*) n FROM extension_data WHERE extension_id='garden.preferences'",
          )
          .get().n;
      } finally {
        db.close();
      }
    };
    await cleanup()
      .getByRole("button", { name: "刷新清理列表", exact: true })
      .click();
    await expect(entry().getByRole("checkbox")).toHaveCount(3);
    await expect(
      entry().getByRole("button", {
        name: "预览清理全部留存数据",
        exact: true,
      }),
    ).toBeDisabled();
    await entry().getByRole("checkbox").first().check();
    const initial = countRows();
    await entry()
      .getByRole("button", { name: "预览删除所选备份", exact: true })
      .click();
    const review = () =>
      cleanup().getByRole("region", { name: "插件数据清理预览", exact: true });
    await review()
      .getByRole("heading", { name: "确认数据清理", exact: true })
      .waitFor();
    assert.equal(countRows(), initial);
    await review()
      .getByRole("button", { name: "取消清理预览", exact: true })
      .click();
    assert.equal(countRows(), initial);
    await entry()
      .getByRole("button", { name: "预览删除所选备份", exact: true })
      .click();
    await expect(
      review().getByRole("button", { name: "确认永久清理", exact: true }),
    ).toBeDisabled();
    await review()
      .getByRole("textbox", { name: "输入扩展 ID 确认", exact: true })
      .fill("wrong");
    await expect(
      review().getByRole("button", { name: "确认永久清理", exact: true }),
    ).toBeDisabled();
    await review()
      .getByRole("textbox", { name: "输入扩展 ID 确认", exact: true })
      .fill("garden.preferences");
    await scan("迁移备份清理预览与输入确认");
    await review().scrollIntoViewIfNeeded();
    await page.screenshot({
      path: "docs/screenshots/editor/extension-cleanup.png",
    });
    await review()
      .getByRole("button", { name: "确认永久清理", exact: true })
      .click();
    await cleanup()
      .getByRole("status")
      .filter({ hasText: "已清理 garden.preferences 的 1 条数据" })
      .waitFor();
    assert.equal(countRows(), initial - 1);
    await expect(card().locator(".extension-data-backup")).toHaveCount(2);
    await expect(
      card().getByRole("spinbutton", { name: "每周目标篇数", exact: true }),
    ).toHaveValue("7");
    await card()
      .getByRole("button", { name: "卸载并保留数据", exact: true })
      .click();
    await entry()
      .getByText("garden.preferences · 已卸载，留存数据", { exact: false })
      .waitFor();
    assert.equal(countRows(), initial - 1);
    await entry()
      .getByRole("button", { name: "预览清理全部留存数据", exact: true })
      .click();
    await review()
      .getByRole("textbox", { name: "输入扩展 ID 确认", exact: true })
      .fill("garden.preferences");
    await scan("卸载后插件数据清理预览");
    await review()
      .getByRole("button", { name: "确认永久清理", exact: true })
      .click();
    await cleanup()
      .getByRole("status")
      .filter({ hasText: "已清理 garden.preferences" })
      .waitFor();
    await expect(entry()).toHaveCount(0);
    assert.equal(countRows(), 0);
    const after = await request("getNote", {
      notebookId: book.id,
      id: note.id,
    });
    assert.equal(after.body, before.body);
    assert.equal(after.revision, before.revision);
    assert.ok(after.body.includes(opaque));
    const session = (
      await request("listExtensions", { notebookId: book.id })
    ).find((e) => e.manifest.id === "garden.session");
    assert.equal(
      (
        await request("getExtensionDataOverview", {
          notebookId: book.id,
          extensionId: session.manifest.id,
          checksum: session.checksum,
        })
      ).backups.length,
      3,
    );
  });
  await check("声明式搜索范围审核、当前库授权与只读上下文命令", async () => {
    const source = await request("createNode", {
      notebookId: book.id,
      title: "阅读记录本地资料",
      body: "阅读记录：当前库专属摘要。",
    });
    const other = await request("createNotebook", { title: "搜索隔离验收" });
    await request("createNode", {
      notebookId: other.id,
      title: "阅读记录跨库秘密",
      body: "阅读记录：跨库不应出现。",
    });
    await page
      .locator('.extension-install input[type="file"]')
      .setInputFiles("packages/plugin-sdk/src/examples/reading-related.json");
    const review = page.locator(".extension-review");
    await review
      .getByRole("heading", { name: "当前 Notebook 搜索上下文", exact: true })
      .waitFor();
    await expect(
      review.getByRole("region", { name: "脚本搜索范围", exact: true }),
    ).toContainText("查询「阅读记录」，最多 5 条");
    await scan("声明式脚本搜索范围安装审核");
    await review
      .getByRole("region", { name: "脚本搜索范围", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: "docs/screenshots/editor/extension-search-context.png",
    });
    await page
      .getByRole("button", { name: "确认安装扩展", exact: true })
      .click();
    const card = page
      .locator(".installed-extension")
      .filter({ hasText: "相关阅读索引" });
    await expect(card).toContainText("search:read");
    await card
      .getByRole("button", { name: "授权当前 Notebook", exact: true })
      .click();
    await page.keyboard.press("Control+k");
    await page
      .locator(".extension-commands button")
      .filter({ hasText: "追加相关阅读索引" })
      .click();
    await page.getByRole("button", { name: "阅读", exact: true }).click();
    await page
      .getByRole("heading", { name: "相关阅读索引", exact: true })
      .waitFor();
    const result = await request("getNote", {
      notebookId: book.id,
      id: note.id,
    });
    assert.ok(result.body.includes("阅读记录本地资料"));
    assert.ok(result.body.includes("当前库专属摘要"));
    assert.ok(!result.body.includes("阅读记录跨库秘密"));
    assert.ok(!result.body.includes("跨库不应出现"));
    assert.ok(result.body.includes(opaque));
    assert.equal(
      (await request("getNote", { notebookId: book.id, id: source.id })).body,
      source.body,
    );
    await scan("搜索上下文命令结果");
    await page.getByRole("button", { name: "扩展", exact: true }).click();
    await card
      .getByRole("button", { name: "撤销当前 Notebook 授权", exact: true })
      .click();
    await page.keyboard.press("Control+k");
    await expect(
      page
        .locator(".extension-commands button")
        .filter({ hasText: "追加相关阅读索引" }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
  });
  await check("异步宿主查询范围审核、等待结果与撤销授权", async () => {
    await page
      .locator('.extension-install input[type="file"]')
      .setInputFiles(
        "packages/plugin-sdk/src/examples/reading-async-related.json",
      );
    const review = page.locator(".extension-review");
    await review
      .getByRole("region", { name: "脚本搜索范围", exact: true })
      .waitFor();
    await expect(review).toContainText(
      "异步查询 reading「阅读记录」，最多 5 条",
    );
    await expect(review).toContainText("每次执行最多 4 次调用");
    await scan("异步宿主查询范围审核");
    await review
      .getByRole("region", { name: "脚本搜索范围", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: "docs/screenshots/editor/extension-async-search.png",
    });
    await page
      .getByRole("button", { name: "确认安装扩展", exact: true })
      .click();
    const card = page
      .locator(".installed-extension")
      .filter({ hasText: "异步相关阅读索引" });
    await card
      .getByRole("button", { name: "授权当前 Notebook", exact: true })
      .click();
    await page.keyboard.press("Control+k");
    await page
      .locator(".extension-commands button")
      .filter({ hasText: "追加异步相关阅读索引" })
      .click();
    await page.getByRole("button", { name: "阅读", exact: true }).click();
    await page
      .getByRole("heading", { name: "异步相关阅读索引", exact: true })
      .waitFor();
    const result = await request("getNote", {
      notebookId: book.id,
      id: note.id,
    });
    assert.ok(result.body.includes("阅读记录本地资料"));
    assert.ok(result.body.includes(opaque));
    assert.ok(!result.body.includes("阅读记录跨库秘密"));
    await scan("异步宿主查询命令结果");
    await page.getByRole("button", { name: "扩展", exact: true }).click();
    await card
      .getByRole("button", { name: "撤销当前 Notebook 授权", exact: true })
      .click();
    await page.keyboard.press("Control+k");
    await expect(
      page
        .locator(".extension-commands button")
        .filter({ hasText: "追加异步相关阅读索引" }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
  });
  await check("插件网络域名审核、授权请求与撤销边界", async () => {
    report.pluginNetworkTransport =
      "controlled DNS and HTTPS response in actual Storage process";
    await app.evaluateStorage(() => {
      const https = process.getBuiltinModule("node:https"),
        dns = process.getBuiltinModule("node:dns/promises");
      const { EventEmitter } = process.getBuiltinModule("node:events"),
        { Readable } = process.getBuiltinModule("node:stream");
      globalThis.__pluginNetworkOriginalGet = https.get;
      globalThis.__pluginNetworkOriginalLookup = dns.lookup;
      globalThis.__pluginNetworkCalls = [];
      dns.lookup = async (host, options) =>
        host === "example.com"
          ? [{ address: "8.8.8.8", family: 4 }]
          : globalThis.__pluginNetworkOriginalLookup(host, options);
      process.getBuiltinModule("node:module").syncBuiltinESMExports();
      https.get = (url, options, callback) => {
        if (url.href !== "https://example.com/anynote-demo.txt")
          return globalThis.__pluginNetworkOriginalGet(url, options, callback);
        globalThis.__pluginNetworkCalls.push({
          url: url.href,
          agent: options.agent,
          rejectUnauthorized: options.rejectUnauthorized,
          headers: options.headers,
        });
        const req = new EventEmitter();
        req.destroy = (error) => {
          queueMicrotask(() => req.emit("error", error));
          return req;
        };
        options.signal.addEventListener(
          "abort",
          () => req.destroy(Error("fixture cancelled")),
          { once: true },
        );
        queueMicrotask(() => {
          const res = Readable.from([
            Buffer.from("公开网络资料：仅固定地址返回的内容。"),
          ]);
          res.statusCode = 200;
          res.headers = { "content-type": "text/plain; charset=utf-8" };
          callback(res);
        });
        return req;
      };
    });
    try {
      await page
        .locator('.extension-install input[type="file"]')
        .setInputFiles("packages/plugin-sdk/src/examples/reading-network.json");
      const review = page.locator(".extension-review"),
        scope = review.getByRole("region", {
          name: "插件网络访问范围",
          exact: true,
        });
      await scope.waitFor();
      await expect(scope).toContainText("域名：example.com");
      await expect(scope).toContainText(
        "GET https://example.com/anynote-demo.txt",
      );
      await expect(scope).toContainText("已发送的请求无法撤回");
      await scan("插件网络访问范围审核");
      await scope.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: "docs/screenshots/editor/extension-network.png",
      });
      await page
        .getByRole("button", { name: "确认安装扩展", exact: true })
        .click();
      const card = page
        .locator(".installed-extension")
        .filter({ hasText: "公开资料摘要" });
      await expect(card).toContainText("network");
      await card
        .getByRole("button", { name: "授权当前 Notebook", exact: true })
        .click();
      await page.keyboard.press("Control+k");
      await page
        .locator(".extension-commands button")
        .filter({ hasText: "追加公开资料摘要" })
        .click();
      await page.getByRole("button", { name: "阅读", exact: true }).click();
      await page
        .getByRole("heading", { name: "公开资料摘要", exact: true })
        .waitFor();
      const result = await request("getNote", {
        notebookId: book.id,
        id: note.id,
      });
      assert.ok(result.body.includes("公开网络资料"));
      assert.ok(result.body.includes(opaque));
      const calls = await app.evaluateStorage(
        () => globalThis.__pluginNetworkCalls,
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0].agent, false);
      assert.equal(calls[0].rejectUnauthorized, true);
      assert.deepEqual(Object.keys(calls[0].headers).sort(), [
        "Accept",
        "User-Agent",
      ]);
      await scan("插件网络响应命令结果");
      await page.getByRole("button", { name: "扩展", exact: true }).click();
      await card
        .getByRole("button", { name: "撤销当前 Notebook 授权", exact: true })
        .click();
      await page.keyboard.press("Control+k");
      await expect(
        page
          .locator(".extension-commands button")
          .filter({ hasText: "追加公开资料摘要" }),
      ).toHaveCount(0);
      await page.keyboard.press("Escape");
      assert.equal(
        (await app.evaluateStorage(() => globalThis.__pluginNetworkCalls))
          .length,
        1,
      );
    } finally {
      await app.evaluateStorage(() => {
        process.getBuiltinModule("node:https").get =
          globalThis.__pluginNetworkOriginalGet;
        process.getBuiltinModule("node:dns/promises").lookup =
          globalThis.__pluginNetworkOriginalLookup;
        process.getBuiltinModule("node:module").syncBuiltinESMExports();
      });
    }
  });
  await check("自动更新检查提示、审核与重新授权", async () => {
    const manifest = JSON.parse(
      readFileSync("packages/plugin-sdk/src/examples/reading-transform.json"),
    );
    manifest.id = "garden.updates";
    manifest.name = "更新检查验收";
    manifest.contributes.commands[0].id = "garden.updates.run";
    const key = generateKeyPairSync("ed25519").privateKey,
      initial = signExtensionPackage(manifest, "自动检查验收发布者", key),
      update = signExtensionPackage(
        { ...manifest, version: "0.1.1" },
        "自动检查验收发布者",
        key,
      );
    await app.evaluateStorage((_electron, payload) => {
      const https = process.getBuiltinModule("node:https"),
        { Readable } = process.getBuiltinModule("node:stream"),
        { EventEmitter } = process.getBuiltinModule("node:events");
      globalThis.__updateOriginalGet = https.get;
      globalThis.__updatePayload = payload;
      https.get = (url, options, callback) => {
        if (url.href !== "https://8.8.8.8/autoupdate.json")
          return globalThis.__updateOriginalGet(url, options, callback);
        const req = new EventEmitter();
        req.destroy = (error) => {
          queueMicrotask(() => req.emit("error", error));
          return req;
        };
        options.signal.addEventListener(
          "abort",
          () => req.destroy(Error("cancelled")),
          { once: true },
        );
        queueMicrotask(() => {
          const res = Readable.from([Buffer.from(globalThis.__updatePayload)]);
          res.statusCode = 200;
          res.headers = {};
          callback(res);
        });
        return req;
      };
    }, JSON.stringify(initial));
    try {
      const preview = await request("previewExtension", { package: initial });
      await request("configurePublisher", {
        package: initial,
        fingerprint: preview.source.fingerprint,
        trusted: true,
      });
      const downloaded = await request("downloadExtension", {
          url: "https://8.8.8.8/autoupdate.json",
        }),
        installed = await request("installDownloadedExtension", {
          reviewId: downloaded.reviewId,
        });
      await request("configureExtension", {
        notebookId: book.id,
        extensionId: manifest.id,
        checksum: installed.checksum,
        permissions: manifest.permissions,
      });
      // Reload this page's device settings and installed metadata using the normal navigation.
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: "扩展", exact: true }).click();
      const section = page.getByRole("region", {
          name: "扩展更新检查",
          exact: true,
        }),
        toggle = section.getByRole("switch", {
          name: "自动检查扩展更新",
          exact: true,
        });
      assert.equal(await toggle.getAttribute("aria-checked"), "false");
      await section
        .getByRole("spinbutton", { name: "检查间隔（小时）", exact: true })
        .fill("1");
      await toggle.click();
      await page.waitForTimeout(200);
      assert.equal(await toggle.getAttribute("aria-checked"), "true");
      await app.evaluateStorage((_electron, payload) => {
        globalThis.__updatePayload = payload;
      }, JSON.stringify(update));
      // Wait for the application-owned 60-second scheduler, not an injected test tick.
      await section
        .getByRole("status")
        .filter({ hasText: "发现新版 0.1.1，等待审核" })
        .waitFor({ timeout: 75_000 });
      report.automaticUpdateScheduler = "real application timer";
      const entry = (
        await request("listExtensions", { notebookId: book.id })
      ).find((e) => e.manifest.id === manifest.id);
      assert.equal(entry.manifest.version, "0.1.0");
      assert.equal(entry.granted, true);
      await scan("自动更新检查提示与设备开关");
      await page.screenshot({
        path: "docs/screenshots/editor/automatic-update-check.png",
      });
      await section
        .getByRole("button", { name: "审核扩展更新", exact: true })
        .click();
      await page
        .locator(".extension-review")
        .getByText("版本 0.1.1", { exact: false })
        .waitFor();
      await page
        .getByRole("button", { name: "确认安装扩展", exact: true })
        .click();
      const card = page
        .locator(".installed-extension")
        .filter({ hasText: "更新检查验收" });
      await card.getByText("当前 Notebook 未授权", { exact: false }).waitFor();
      await toggle.click();
      await page.waitForTimeout(200);
      assert.equal(await toggle.getAttribute("aria-checked"), "false");
      await card
        .getByRole("button", { name: "卸载并保留数据", exact: true })
        .click();
    } finally {
      await request("configureExtensionUpdates", {
        enabled: false,
        intervalHours: 24,
      }).catch(() => {});
      await app.evaluateStorage(() => {
        process.getBuiltinModule("node:https").get =
          globalThis.__updateOriginalGet;
      });
    }
  });
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = { message: e.message, stack: e.stack };
  process.exitCode = 1;
  console.error(e);
  await page
    ?.screenshot({ path: "/tmp/anynote-editor-failure.png" })
    .catch(() => {});
} finally {
  await app?.close();
  rmSync(root, { recursive: true, force: true });
  mkdirSync("test-results", { recursive: true });
  const file = process.env.ANYNOTE_EXECUTABLE
    ? "test-results/editor-ecosystem-packaged.json"
    : "test-results/editor-ecosystem.json";
  report.finishedAt = new Date().toISOString();
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  console.log(report.status + ": " + file);
}
