import { _electron } from "playwright";
import { expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { appMenu } from "./acceptance/app-menu.mjs";
import { openNotebook } from "./acceptance/open-notebook.mjs";

const output = resolve("tmp/screenshots/management");
mkdirSync(output, { recursive: true });
const root = mkdtempSync(resolve("tmp/management-profile-"));
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
  await page.emulateMedia({ reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openNotebook(page);
  for (const theme of ["light", "dark"]) {
    await appMenu(page, "settings", desktop);
    await page
      .getByRole("button", {
        name: theme === "light" ? "明亮" : "深色",
        exact: true,
      })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 960 });
      for (const [command, title] of [
        ["settings", "设置"],
        ["extensions", "插件与扩展"],
        ["backup", "备份与恢复"],
      ]) {
        await appMenu(page, command, desktop);
        await expect(
          page.getByRole("heading", { name: title, exact: true }),
        ).toBeVisible();
        const surface = page.locator(".management-page");
        await expect(
          surface.getByText("正在加载…", { exact: true }),
        ).toHaveCount(0);
        await page.evaluate(() => document.fonts.ready);
        await page
          .locator(".main-content")
          .evaluate((el) => el.scrollTo({ top: 0, behavior: "instant" }));
        const overflow = await surface.evaluate((el) => {
          const container = el.closest(".main-content");
          return container.scrollWidth - container.clientWidth;
        });
        expect(
          overflow,
          `${command} ${theme} ${width} horizontal overflow`,
        ).toBeLessThanOrEqual(1);
        await page.screenshot({
          path: join(output, `${command}-${theme}-${width}.png`),
        });
        // Element screenshots are clipped by the scroll container; capture each viewport instead.
        const desk = page.locator(".main-content");
        const steps = await desk.evaluate((el) =>
          Math.ceil(
            (el.scrollHeight - el.clientHeight) / (el.clientHeight - 80),
          ),
        );
        for (let step = 1; step <= steps; step++) {
          await desk.evaluate(
            (el, step) =>
              el.scrollTo({
                top: step * (el.clientHeight - 80),
                behavior: "instant",
              }),
            step,
          );
          await page.screenshot({
            path: join(
              output,
              `${command}-${theme}-${width}-scroll-${step}.png`,
            ),
          });
        }
      }
    }
  }
  await appMenu(page, "extensions", desktop);
  const toggle = page.getByRole("switch", {
    name: "白板 · Excalidraw启用",
    exact: true,
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await appMenu(page, "settings", desktop);
  await appMenu(page, "extensions", desktop);
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await appMenu(page, "backup", desktop);
  await page.getByRole("button", { name: "创建快照", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "恢复副本", exact: true }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "添加目标", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "配置备份", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Populate an isolated display fixture; it has no credentials and never runs a remote backup.
  const [book] = await page.evaluate(() =>
    window.anynote.request("listNotebooks", {}),
  );
  const fixtureTarget = {
    id: randomUUID(),
    notebookId: book.id,
    lineageId: randomUUID(),
    deviceId: randomUUID(),
    name: "我的备份",
    endpoint:
      "https://backup-display-fixture.example.invalid/" +
      "long-endpoint-".repeat(8),
    allowInsecure: false,
    credentialsMode: "session-only",
    createdAt: Date.now(),
    lastSuccess: new Date("2026-10-25T13:11:05Z").getTime(),
    autoBackup: false,
  };
  const targetPath = join(root, "notebooks", "_local", "backup-targets.json");
  writeFileSync(targetPath, JSON.stringify([fixtureTarget]));
  for (const theme of ["light", "dark"]) {
    await appMenu(page, "settings", desktop);
    await page
      .getByRole("button", {
        name: theme === "light" ? "明亮" : "深色",
        exact: true,
      })
      .click();
    await appMenu(page, "backup", desktop);
    const remote = page.getByRole("region", { name: "远端备份", exact: true });
    await expect(
      remote.getByRole("article", { name: "我的备份" }),
    ).toBeVisible();
    await remote.locator("summary").click();
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 1100 });
      await remote.scrollIntoViewIfNeeded();
      await expect(
        remote.getByRole("checkbox", { name: "自动备份 · 约每分钟检查变更" }),
      ).not.toBeChecked();
      const battery = remote.getByRole("checkbox", {
        name: "电池供电时暂停自动备份",
      });
      const metered = remote.getByRole("checkbox", {
        name: "计量网络时暂停自动备份",
      });
      if (!(await battery.isChecked())) await battery.click();
      await expect(battery).toBeChecked();
      if (await metered.isChecked()) await metered.click();
      await expect(metered).not.toBeChecked();
      await expect(battery).toBeChecked();
      const rows = await remote
        .locator(".backup-policy .backup-preference")
        .evaluateAll((els) =>
          els.map((el) => {
            const rect = el.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom };
          }),
        );
      expect(rows[1].top - rows[0].bottom).toBeGreaterThanOrEqual(-1);
      expect(
        await remote.evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeLessThanOrEqual(1);
      await remote.screenshot({
        path: join(output, `remote-backup-fixture-${theme}-${width}.png`),
      });
    }
  }
  writeFileSync(
    targetPath,
    JSON.stringify([
      {
        ...fixtureTarget,
        pausedReason: "auth",
        lastError: "凭据已过期，请更新连接配置后重试。",
      },
    ]),
  );
  await appMenu(page, "settings", desktop);
  await appMenu(page, "backup", desktop);
  await expect(page.locator(".remote-target-notices")).toContainText(
    "鉴权失败",
  );
  await page
    .getByRole("region", { name: "远端备份", exact: true })
    .screenshot({ path: join(output, "remote-backup-fixture-error.png") });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(errors).toEqual([]);
  console.log(
    "Management UI passed: 3 pages, 2 themes, 2 widths; theme persistence, extension toggles, snapshot creation, dynamic backup dialog and populated remote-target fixtures.",
  );
} finally {
  await desktop?.close();
  rmSync(root, { recursive: true, force: true });
}
