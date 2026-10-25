import { readSelection } from "../apps/browser-extension/src/selection.js";
import { readChatGPT } from "../apps/browser-extension/src/chatgpt-page.js";
import { conversationMarkdown } from "../.build/packages/capture/chatgpt.js";
import { convertComponents } from "../.build/packages/capture/chatgpt-components.js";
import { flow, group } from "../tests/fixtures/chatgpt-components.mjs";
import { unzipSync } from "fflate";
/* global chrome */
import { chromium } from "playwright";
import { expect } from "@playwright/test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  cpSync,
} from "node:fs";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";

const output = resolve("tmp/browser-capture");
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(join(output, "profile-")),
  extension = mkdtempSync(join(output, "extension-"));
cpSync(resolve("apps/browser-extension/dist"), extension, { recursive: true });
const manifest = JSON.parse(
  readFileSync(join(extension, "manifest.json"), "utf8"),
);
// Pregrant only the synthetic media origin in the disposable test build.
manifest.host_permissions.push("https://images.example.com/*");
writeFileSync(join(extension, "manifest.json"), JSON.stringify(manifest));
const browser = await chromium.launchPersistentContext(profile, {
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions"],
  channel: "chromium",
  executablePath: process.env.CAPTURE_CHROMIUM || undefined,
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
  ],
  viewport: { width: 440, height: 980 },
});
try {
  const worker =
      browser.serviceWorkers()[0] ||
      (await browser.waitForEvent("serviceworker")),
    id = new URL(worker.url()).host;
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("worker", (w) => w.on("console", (m) => console.log(m.text())));
  page.on("console", (m) => {
    if (m.type() === "error") console.error(m.text());
  });
  await page.goto(`chrome-extension://${id}/index.html`);
  await expect(
    page.getByRole("button", { name: "设置", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#settings-page")).toBeHidden();
  assert.equal(
    await page
      .locator(".brand img")
      .evaluate((img) => img.complete && img.naturalWidth > 0),
    true,
  );
  const source = await browser.newPage();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const imageResponse = (route) =>
    route.fulfill({ contentType: "image/png", body: png });
  await source.route("https://images.example.com/**", imageResponse);
  await page.route("https://images.example.com/**", imageResponse);
  await source.route("https://example.com/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: '<title>网页采集验收</title><article><h1>浏览器采集</h1><p>保留 <strong>格式</strong> 与 <a href="/next">链接</a>。</p><pre><code class="language-js">const answer = 42;</code></pre></article>',
    }),
  );
  await source.goto("https://example.com/article");
  await source.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("article"));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  const selection = await source.evaluate(readSelection);
  await worker.evaluate(async (input) => {
    await chrome.storage.session.set({
      "capture.pending": { ...input, id: crypto.randomUUID() },
    });
  }, selection);
  await source.route("https://chatgpt.com/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session")
      return route.fulfill({ json: { accessToken: "fixture-session-secret" } });
    if (path.startsWith("/backend-api/conversation/")) {
      assert.equal(
        route.request().headers().authorization,
        "Bearer fixture-session-secret",
      );
      const message = (parent, role, text) => ({
        parent,
        message: { author: { role }, content: { parts: [text] } },
      });
      return route.fulfill({
        json: {
          title: "Synthetic API history",
          current_node: "other",
          mapping: {
            root: message(null, "system", "hidden instruction"),
            question: message("root", "user", "Question"),
            answer: message(
              "question",
              "assistant",
              `Selected answer\n\n${group}\n\n${flow}`,
            ),
            other: message("question", "assistant", "Other branch"),
          },
        },
      });
    }
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: '<div data-dil-message-id="answer">Selected answer<div data-d-component="row"><div class="group/search-image"><img alt="Fixture image" src="https://images.example.com/fixture.png?purpose=inline"></div></div></div>',
    });
  });
  await source.goto("https://chatgpt.com/c/fixture-conversation");
  await expect(source.locator("#anynote-capture-button")).toBeVisible();
  await source.reload();
  await expect(source.locator("#anynote-capture-button")).toHaveCount(1);
  const history = await source.evaluate(readChatGPT);
  assert.equal(history.currentNode, "answer");
  assert.equal(history.nodes.find((n) => n.id === "root").message, null);
  assert.ok(!JSON.stringify(history).includes("fixture-session-secret"));
  assert.equal(
    history.nodes.find((n) => n.id === "answer").message.imageGroups[0].images
      .length,
    1,
  );
  await expect(page.locator("#title")).toHaveValue("网页采集验收");
  const body = await page.locator("#body").inputValue();
  assert.ok(body.includes("**格式**"));
  assert.ok(body.includes("https://example.com/next"));
  assert.ok(body.includes("const answer = 42"));
  const download = page.waitForEvent("download", { timeout: 8000 });
  await page.getByRole("button", { name: "导出 .anyclip" }).click();
  const file = await download.catch(async (error) => {
    console.error(await page.locator("#status").innerText(), errors);
    await page.screenshot({
      path: join(output, "failure.png"),
      fullPage: true,
    });
    throw error;
  });
  await file.saveAs(join(output, "fixture.anyclip"));
  await page.screenshot({ path: join(output, "panel.png"), fullPage: true });
  await page.setViewportSize({ width: 320, height: 900 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: join(output, "panel-narrow.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 440, height: 980 });
  await page.reload();
  await expect(page.locator("#title")).toHaveValue("网页采集验收");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.locator("#capture-page")).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Cloudflare 笔记" }),
  ).toBeVisible();
  await page.locator("#cloud-endpoint").fill("https://fixture.example.com");
  await page.screenshot({ path: join(output, "settings.png"), fullPage: true });
  await page.setViewportSize({ width: 320, height: 900 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: join(output, "settings-narrow.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 440, height: 980 });
  await page.getByRole("button", { name: "返回采集" }).click();
  await expect(page.locator("#title")).toHaveValue("网页采集验收");
  await expect(page.locator("#body")).toHaveValue(body);
  await page.getByRole("button", { name: "导入云端" }).click();
  await expect(page.locator("#settings-page")).toBeVisible();
  await expect(page.locator("#cloud-endpoint")).toHaveValue(
    "https://fixture.example.com",
  );
  await expect(page.locator("#status")).toContainText("设置中配对");
  // Exercise the real manifest content script and background MAIN-world adapter.
  await source.locator("#anynote-capture-button").click();
  await expect(page.locator("#capture-page")).toBeVisible();
  await expect(page.locator("#title")).toHaveValue("Synthetic API history");
  await expect(page.locator("#body")).toHaveValue(/Selected answer/);
  await expect(page.locator("#body")).toHaveValue(/data-anynote-card/);
  await page.getByRole("button", { name: "下载媒体" }).click();
  await expect(page.locator("#media")).toContainText("已保存");
  const richDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 .anyclip" }).click();
  const richFile = join(output, "rich.anyclip");
  await (await richDownload).saveAs(richFile);
  const richZip = unzipSync(readFileSync(richFile)),
    richManifest = JSON.parse(
      new TextDecoder().decode(richZip["manifest.json"]),
    );
  assert.equal(richManifest.assets.length, 1);
  assert.equal(richManifest.complete, true);
  assert.ok(
    new TextDecoder()
      .decode(richZip["content.md"])
      .includes("data-anynote-card"),
  );
  assert.deepEqual(Buffer.from(richZip[richManifest.assets[0].path]), png);
  const preview = await browser.newPage();
  await preview.setContent(
    `<html lang="zh-CN"><body style="margin:24px;font:14px system-ui;background:white"><h2>采集卡片预览</h2>${convertComponents(flow).body}</body></html>`,
  );
  await preview.screenshot({
    path: join(output, "card-preview.png"),
    fullPage: true,
  });
  await preview.close();
  await source.close();
  await worker.evaluate(
    async (input) => {
      await chrome.storage.session.set({
        "capture.pending": { ...input, id: crypto.randomUUID() },
      });
    },
    {
      ...conversationMarkdown(history),
      kind: "chatgpt",
      url: "https://chatgpt.com/c/fixture-conversation",
      capturedAt: new Date().toISOString(),
      missing: [{ name: "真实媒体占位测试", reason: "尚未解析的图片" }],
    },
  );
  await expect(page.locator("#title")).toHaveValue("Synthetic API history");
  await expect(page.locator("#media")).toContainText("真实媒体占位测试");
  await page.getByRole("button", { name: "导出 .anyclip" }).click();
  await expect(page.locator("#capture-status")).toContainText("勾选");
  await expect(page.locator("#allow-missing")).toBeFocused();
  await page.locator("#allow-missing").check();
  const partialDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 .anyclip" }).click();
  await (await partialDownload).saveAs(join(output, "partial.anyclip"));
  await expect(page.locator("#capture-status")).toContainText("已导出");
  await page.locator("#allow-missing").uncheck();
  await page.getByRole("button", { name: "导出 .anyclip" }).click();
  await expect(page.locator("#capture-status")).toContainText("勾选");
  await page.screenshot({
    path: join(output, "missing-feedback.png"),
    fullPage: true,
  });
  await page.goto(`chrome-extension://${id}/index.html#settings`);
  await expect(page.locator("#settings-page")).toBeVisible();
  await expect(page.locator("#capture-page")).toBeHidden();
  await page.getByRole("button", { name: "返回采集" }).click();
  await expect(page.locator("#title")).toHaveValue("Synthetic API history");
  assert.deepEqual(errors, []);
  writeFileSync(
    join(output, "result.json"),
    JSON.stringify(
      {
        passed: true,
        browser: browser.browser().version(),
        checks: [
          "extension service worker",
          "selection Range conversion",
          "ChatGPT API fixture and selected branch (not live verification)",
          "archive download",
          "persistent draft",
          "settings navigation preserves capture and connection form",
          "automatic ChatGPT button after navigation and reload; real capture message flow",
          "rendered image group mapping, image download bytes, inline card and complete rich archive",
          "visible missing-content feedback and explicit partial export consent",
          "no horizontal overflow",
          "no page errors",
        ],
      },
      null,
      2,
    ),
  );
  console.log("Browser capture smoke passed; artifacts: tmp/browser-capture");
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
  rmSync(extension, { recursive: true, force: true });
}
