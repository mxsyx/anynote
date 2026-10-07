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
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=",
  "base64",
);
try {
  await page.goto("http://127.0.0.1:5173");
  await page.getByRole("textbox", { name: "笔记标题" }).waitFor();
  await page.getByRole("button", { name: "新建笔记", exact: true }).click();
  await page
    .getByPlaceholder("输入一个名称…")
    .fill("扩展界面验证 " + Date.now());
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page
    .locator(".cm-content")
    .fill(
      '# 内容扩展\n\n保留未知语法。\n\n:::anynote{type="vendor.unknown" version="8" id="original"}\n{"future":"原样保留"}\n:::\n',
    );
  await page.keyboard.press("Control+s");
  await page.getByText("已保存至本地", { exact: true }).waitFor();
  await page
    .locator('input[accept=".png,.jpg,.jpeg,.webp,.svg"]')
    .setInputFiles({
      name: "内联图片.png",
      mimeType: "image/png",
      buffer: png,
    });
  await page.getByRole("button", { name: "阅读", exact: true }).click();
  await page.locator(".markdown-body img").first().waitFor();
  assert.ok(
    await page
      .locator(".markdown-body img")
      .first()
      .evaluate((img) => img.complete && img.naturalWidth > 0),
  );
  await page.getByRole("button", { name: "插入视频", exact: true }).click();
  await page
    .getByPlaceholder("输入一个名称…")
    .fill("https://youtu.be/dQw4w9WgXcQ");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.locator(".video-block").waitFor();
  assert.equal(await page.locator("iframe").count(), 0);
  // A generic video URL is allowed as a plain link card without an embed action.
  await page.getByRole("button", { name: "插入视频", exact: true }).click();
  await page
    .getByPlaceholder("输入一个名称…")
    .fill("https://example.com/talks/local-first");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.locator(".video-block").nth(1).waitFor();
  assert.equal(
    await page
      .locator(".video-block")
      .nth(1)
      .getByRole("button", { name: "嵌入播放", exact: true })
      .count(),
    0,
  );
  // Click-to-play mounts the isolated iframe; closing removes it again.
  await page.getByRole("button", { name: "嵌入播放", exact: true }).click();
  await page.locator(".video-block iframe").waitFor();
  await page.getByRole("button", { name: "关闭播放", exact: true }).click();
  assert.equal(await page.locator(".video-block iframe").count(), 0);
  await page.getByRole("button", { name: "插入白板", exact: true }).click();
  await page.locator(".excalidraw canvas").first().waitFor({ timeout: 45000 });
  // Draw through the canvas, then verify the persisted scene survives reopening.
  const canvas = page.locator(".excalidraw canvas").first(),
    box = await canvas.boundingBox();
  await page.keyboard.press("r");
  await page.mouse.move(box.x + 300, box.y + 250);
  await page.mouse.down();
  await page.mouse.move(box.x + 490, box.y + 365, { steps: 12 });
  await page.mouse.up();
  await page.getByRole("button", { name: "保存白板", exact: true }).click();
  await page
    .getByRole("dialog", { name: "白板编辑器" })
    .waitFor({ state: "hidden", timeout: 20000 });
  await page.locator(".extension-block img").waitFor();
  await page.getByRole("button", { name: "打开白板", exact: true }).click();
  await page.locator(".excalidraw canvas").first().waitFor();
  await page.getByRole("button", { name: "返回笔记", exact: true }).click();
  await page
    .getByRole("button", { name: "网页 / HTML 导入", exact: true })
    .click();
  await page.getByRole("button", { name: "HTML 文件", exact: true }).click();
  await page
    .getByRole("textbox", { name: "HTML 内容" })
    .fill(
      '<html><head><title>网页验证</title></head><body><h1>清洗后的收藏</h1><p>本地可读内容</p><script>window.importExecuted=true</script><img src="data:image/png;base64,' +
        png.toString("base64") +
        '"></body></html>',
    );
  await page.getByRole("button", { name: "开始导入", exact: true }).click();
  await page.getByRole("dialog", { name: "任务中心" }).waitFor();
  await page
    .getByRole("button", { name: "打开笔记", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "阅读", exact: true }).click();
  await page
    .getByRole("heading", { name: "清洗后的收藏", exact: true })
    .waitFor();
  assert.equal(await page.evaluate(() => window.importExecuted), undefined);
  assert.ok(
    await page
      .locator(".markdown-body img")
      .first()
      .evaluate((img) => img.complete && img.naturalWidth > 0),
  );
  await page
    .getByText("导入报告 · 已本地化 1 张图片 · 未下载 0 张", { exact: true })
    .waitFor();
  await page.screenshot({
    path: "docs/screenshots/import.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "Features smoke passed: inline local image, opaque block, generic/click-to-play video cards, Excalidraw save/reopen, sanitized HTML task and localized image.",
  );
} catch (e) {
  await page.screenshot({
    path: "/tmp/anynote-features-error.png",
    fullPage: true,
  });
  console.error(errors);
  throw e;
} finally {
  await browser.close();
}
