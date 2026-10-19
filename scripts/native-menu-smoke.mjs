import { _electron } from "playwright";
import { expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appMenu } from "./acceptance/app-menu.mjs";
import { openNotebook } from "./acceptance/open-notebook.mjs";

const root = mkdtempSync(join(tmpdir(), "anynote-menu-"));
let desktop;
try {
  desktop = await _electron.launch({
    args: [".", "--no-sandbox"],
    env: {
      ...process.env,
      ANYNOTE_USER_DATA_DIR: root,
      ANYNOTE_DEV: "",
      ELECTRON_RUN_AS_NODE: "",
    },
  });
  const page = await desktop.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.locator(".book-volume").first()).toBeVisible();
  await appMenu(page, "settings", desktop);
  await expect(
    page.getByRole("heading", { name: "你的空间，你的习惯" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "书橱", exact: true }).click();
  await openNotebook(page);
  await expect(page.locator(".content-layout > .sidebar")).toBeVisible();
  await page
    .getByRole("textbox", { name: "文档内容", exact: true })
    .fill(
      Array.from(
        { length: 60 },
        (_, index) => `滚动验证第 ${index + 1} 行`,
      ).join("\n"),
    );
  // Verify the shipped CSS: the scrollbar belongs to the desk outside the paper.
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: 600 });
    const paper = page.locator("article.document");
    await expect(paper).toBeVisible();
    const geometry = await page.locator(".main-content").evaluate((desk) => {
      const sheet = desk.querySelector("article.document");
      const deskBox = desk.getBoundingClientRect();
      const paperBox = sheet.getBoundingClientRect();
      return {
        gap: deskBox.left + desk.clientWidth - paperBox.right,
        background: getComputedStyle(desk).backgroundColor,
        paperOverflow: getComputedStyle(sheet).overflowY,
        top: paperBox.top,
      };
    });
    expect(geometry.gap).toBeGreaterThanOrEqual(20);
    expect(geometry.background).toBe("rgba(0, 0, 0, 0)");
    expect(geometry.paperOverflow).toBe("visible");
    await page
      .locator(".main-content")
      .evaluate((desk) => desk.scrollTo({ top: 160, behavior: "instant" }));
    await expect
      .poll(async () => (await paper.boundingBox()).y)
      .toBeLessThan(geometry.top - 100);
    await page.screenshot({ path: `/tmp/anynote-paper-scroll-${width}.png` });
    await page
      .locator(".main-content")
      .evaluate((desk) => desk.scrollTo({ top: 0, behavior: "instant" }));
  }
  await page.setViewportSize({ width: 1440, height: 960 });

  await expect(page.locator(".app-menu")).toHaveCount(0);
  const initialTheme = await page.locator("html").getAttribute("data-theme");
  await appMenu(page, "theme", desktop);
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    initialTheme === "dark" ? "light" : "dark",
  );
  await appMenu(page, "settings", desktop);
  await expect(
    page.getByRole("heading", { name: "你的空间，你的习惯" }),
  ).toBeVisible();
  await appMenu(page, "extensions", desktop);
  await expect(
    page.getByRole("heading", { name: "为你的书桌，添一些可能" }),
  ).toBeVisible();
  await appMenu(page, "backup", desktop);
  await expect(
    page.getByRole("button", { name: "创建快照", exact: true }),
  ).toBeVisible();
  await appMenu(page, "trash", desktop);
  await expect(page.locator(".collection")).toBeVisible();
  expect(errors).toEqual([]);
  console.log(
    "Native menus passed: theme, settings, extensions, backup, trash, renderer bridge.",
  );
} finally {
  await desktop?.close();
  rmSync(root, { recursive: true, force: true });
}
