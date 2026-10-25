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

  const menus = await desktop.evaluate(({ Menu }) =>
    Menu.getApplicationMenu().items.map((item) => ({
      label: item.label,
      entries: item.submenu?.items
        .filter((entry) => entry.type !== "separator")
        .map((entry) => entry.label),
    })),
  );
  expect(menus.map((item) => item.label)).toEqual([
    process.platform === "darwin" ? "Anynote" : "应用",
    "编辑",
    "显示",
    "帮助",
  ]);
  expect(menus.find((item) => item.label === "编辑").entries).toEqual([
    "撤销",
    "重做",
    "剪切",
    "复制",
    "粘贴",
    "粘贴并匹配样式",
    "全选",
    "插入内容",
  ]);
  expect(menus.find((item) => item.label === "显示").entries).toEqual([
    "切换深色 / 浅色模式",
  ]);
  expect(menus.find((item) => item.label === "帮助").entries).toEqual([
    "关于 Anynote",
  ]);

  // Check rendered surfaces so later layout rules cannot mask the theme tokens.
  const checkAppearance = async (mode) => {
    const dark = mode === "dark";
    const surface = dark ? "rgb(31, 31, 31)" : "rgb(250, 250, 248)";
    const edge = dark ? "rgb(69, 69, 69)" : "rgb(206, 206, 198)";
    const sidebar = dark ? "rgb(24, 24, 24)" : "rgb(244, 244, 242)";
    const text = dark ? "rgb(204, 204, 204)" : "rgb(36, 36, 36)";
    const secondary = dark ? "rgb(157, 157, 157)" : "rgb(115, 115, 115)";
    const border = dark ? "rgb(43, 43, 43)" : "rgb(232, 232, 229)";
    const accent = dark ? "rgb(0, 120, 212)" : "rgb(99, 134, 117)";

    await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
    await expect(page.locator("html")).toHaveCSS("color-scheme", mode);
    await expect(page.locator(".workspace")).toHaveCSS(
      "background-color",
      surface,
    );
    await expect(page.locator("article.document")).toHaveCSS(
      "background-color",
      surface,
    );
    await expect(page.locator("article.document")).toHaveCSS(
      "border-top-color",
      edge,
    );
    await expect(page.locator(".content-layout > .sidebar")).toHaveCSS(
      "background-color",
      sidebar,
    );
    await expect(page.locator(".content-layout > .sidebar")).toHaveCSS(
      "border-color",
      edge,
    );
    await expect(page.locator(".topbar")).toHaveCSS(
      "background-color",
      sidebar,
    );
    await expect(
      page.getByRole("textbox", { name: "文档内容", exact: true }),
    ).toHaveCSS("color", text);
    await expect(page.locator(".doc-meta")).toHaveCSS("color", secondary);
    await expect(page.locator(".doc-divider")).toHaveCSS(
      "background-color",
      border,
    );
    await expect(page.locator(".doc-eyebrow")).toHaveCSS("color", accent);
  };

  await appMenu(page, "settings", desktop);
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  await page.getByRole("button", { name: "书橱", exact: true }).click();
  await openNotebook(page);
  await expect(page.locator(".content-layout > .sidebar")).toBeVisible();
  await checkAppearance("light");
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
  await appMenu(page, "theme", desktop);
  await checkAppearance("dark");
  await page.screenshot({ path: "/tmp/anynote-appearance-dark.png" });
  await appMenu(page, "settings", desktop);
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  await page.reload();
  await openNotebook(page);
  await checkAppearance("dark");
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await checkAppearance("light");
  await page.reload();
  await openNotebook(page);
  await checkAppearance("light");
  await page.screenshot({ path: "/tmp/anynote-appearance-light.png" });
  await appMenu(page, "extensions", desktop);
  await expect(page.getByRole("heading", { name: "插件与扩展" })).toBeVisible();
  await appMenu(page, "backup", desktop);
  await expect(
    page.getByRole("button", { name: "创建快照", exact: true }),
  ).toBeVisible();
  await appMenu(page, "trash", desktop);
  await expect(page.locator(".collection")).toBeVisible();
  expect(errors).toEqual([]);
  console.log(
    "Native menus passed: appearance colors, mode persistence, settings, extensions, backup, trash, renderer bridge.",
  );
} finally {
  await desktop?.close();
  rmSync(root, { recursive: true, force: true });
}
