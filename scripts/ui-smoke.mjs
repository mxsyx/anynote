import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
const browser = await chromium.launch({
  executablePath: process.env.ANYNOTE_BROWSER || "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox"],
});
const testName = "界面验证笔记 " + Date.now();
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } }),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto("http://127.0.0.1:5173");
  await page
    .getByRole("textbox", { name: "笔记标题" })
    .waitFor({ timeout: 20000 });
  await page
    .getByRole("button", { name: "切换主题", exact: true })
    .evaluate((el) => {
      if (document.documentElement.dataset.theme === "dark") el.click();
    });
  await page
    .locator(".tree-main")
    .filter({ hasText: "欢迎来到 Anynote" })
    .first()
    .click();
  await page.getByRole("textbox", { name: "笔记标题" }).waitFor();
  mkdirSync("docs/screenshots", { recursive: true });
  await page.screenshot({ path: "docs/screenshots/light.png", fullPage: true });
  await page.getByRole("button", { name: "新建笔记", exact: true }).click();
  await page.getByPlaceholder("输入一个名称…").fill(testName);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("textbox", { name: "笔记标题" }).waitFor();
  await page
    .locator(".cm-content")
    .fill("## 持久化验证\n\n这是一篇中文测试笔记。\n\n- [ ] 自动保存\n");
  await page.keyboard.press("Control+s");
  await page.getByText("已保存至本地", { exact: true }).waitFor();
  await page.reload();
  await page.getByRole("textbox", { name: "笔记标题" }).waitFor();
  await page.getByRole("button", { name: "搜索笔记" }).click();
  await page.getByPlaceholder("寻找一个想法，或一篇笔记…").fill(testName);
  await page.locator(".command-results button").first().click();
  await page.getByRole("button", { name: "阅读", exact: true }).click();
  await page
    .getByRole("heading", { name: "持久化验证", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "收藏笔记", exact: true }).click();
  await page.keyboard.press("Control+s");
  await page.getByText("已保存至本地", { exact: true }).waitFor();
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
  await page.getByRole("button", { name: "移入回收站", exact: true }).click();
  await page.getByText("已移入回收站，可随时恢复", { exact: true }).waitFor();
  await page.locator(".sidebar-bottom > button").first().click();
  await page.getByRole("button", { name: "恢复", exact: true }).first().click();
  await page.getByText("笔记已恢复", { exact: true }).waitFor();
  await page
    .locator(".tree-main")
    .filter({ hasText: "欢迎来到 Anynote" })
    .first()
    .click();
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await page.screenshot({ path: "docs/screenshots/dark.png", fullPage: true });
  await page
    .getByRole("button", { name: "本地优先，安心记录", exact: false })
    .click();
  await page.getByRole("button", { name: "创建快照", exact: true }).click();
  await page.getByText("本地快照已完成并校验", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "恢复副本", exact: true })
    .first()
    .click();
  await page.getByText("快照已恢复为新的 Notebook", { exact: true }).waitFor();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=",
    "base64",
  );
  await page
    .locator('input[accept=".md,.txt,.pdf,.png,.jpg,.jpeg,.webp,.svg"]')
    .setInputFiles({
      name: "验证图片.png",
      mimeType: "image/png",
      buffer: png,
    });
  await page.locator(".image-canvas img").waitFor();
  assert.equal(
    await page
      .locator(".image-canvas img")
      .evaluate((el) => el.complete && el.naturalWidth > 0),
    true,
  );
  // The image reader exposes actual size, rotation (view-only), EXIF and a
  // caption stored in the note body.
  const reader = page.locator(".image-reader");
  await reader.getByRole("button", { name: "实际尺寸", exact: true }).click();
  await reader
    .getByRole("button", { name: "顺时针旋转 90°", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector(".image-rotator")
      ?.getAttribute("style")
      ?.includes("rotate(90deg)"),
  );
  await reader.getByRole("button", { name: "适应窗口", exact: true }).click();
  await reader.getByLabel("图片说明", { exact: true }).fill("验收说明");
  await reader.getByRole("button", { name: "保存说明", exact: true }).click();
  await page.waitForFunction(() => {
    const root = document.querySelector(".image-reader"),
      button =
        root &&
        [...root.querySelectorAll("button")].find((item) =>
          item.textContent?.includes("保存说明"),
        );
    return !!button && button.disabled;
  });
  await reader.getByRole("button", { name: "信息", exact: true }).click();
  await page.getByText(/尺寸 1 × 1 像素/).waitFor();
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length 37 >>\nstream\nBT /F1 18 Tf 40 200 Td (Anynote) Tj ET\nendstream",
  ];
  let pdf = "%PDF-1.4\n",
    offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += i + 1 + " 0 obj\n" + o + "\nendobj\n";
  });
  const xref = Buffer.byteLength(pdf);
  pdf +=
    "xref\n0 6\n0000000000 65535 f \n" +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
      .join("") +
    "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" +
    xref +
    "\n%%EOF";
  await page
    .locator('input[accept=".md,.txt,.pdf,.png,.jpg,.jpeg,.webp,.svg"]')
    .setInputFiles({
      name: "验证文档.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(pdf),
    });
  await page.locator(".pdf-reader canvas").waitFor();
  await page.waitForFunction(
    () => document.querySelector(".pdf-reader canvas")?.width > 0,
  );
  await page.locator(".textLayer span").first().waitFor();
  await page.getByRole("textbox", { name: "PDF 文内搜索" }).fill("Anynote");
  await page.getByRole("button", { name: "查找", exact: true }).click();
  await page.getByText("1 页匹配", { exact: false }).waitFor();
  await page
    .locator(".textLayer span")
    .first()
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
  await page
    .getByRole("textbox", { name: "批注正文" })
    .fill("桌面阅读批注测试");
  await page
    .getByRole("button", { name: "保存高亮与批注", exact: true })
    .click();
  await page.getByText("桌面阅读批注测试", { exact: true }).waitFor();
  await page.locator(".pdf-highlight").first().waitFor();
  await page.screenshot({ path: "docs/screenshots/pdf.png", fullPage: true });
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
  await page
    .getByRole("button", { name: "导出完整 Notebook", exact: true })
    .click();
  const file = await downloaded;
  const exportPath = await file.path();
  assert.ok(exportPath);
  const zip = readFileSync(exportPath);
  assert.equal(zip.subarray(0, 2).toString(), "PK");
  await page.locator('input[accept=".anynote"]').setInputFiles({
    name: "验证导出.anynote",
    mimeType: "application/octet-stream",
    buffer: zip,
  });
  await page.getByText("Notebook 已验证并导入", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "UI smoke passed: create, autosave, reload, search, favorite, trash/restore, themes, snapshot/restore, image/PDF readers, full archive round-trip.",
  );
} catch (e) {
  console.log((await page.locator("body").innerText()).slice(0, 6000));
  await page.screenshot({
    path: "docs/screenshots/ui-failure.png",
    fullPage: true,
  });
  throw e;
} finally {
  await browser.close();
}
