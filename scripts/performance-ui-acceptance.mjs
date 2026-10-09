import { launchDesktop } from "./acceptance/electron-driver.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, cpus, totalmem, platform, arch } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./acceptance/performance-fixture.mjs";
import { createServer } from "node:http";
import { D1, R2 } from "../tests/helpers/cloud-adapters.mjs";
import worker from "../.build/apps/cloudflare-backup/src/index.js";
if (
  process.platform === "linux" &&
  !process.env.ANYNOTE_ACCEPTANCE_KEYRING_ROOT
) {
  const keyRoot = mkdtempSync(join(tmpdir(), "anynote-performance-keyring-")),
    env = { ...process.env, ANYNOTE_ACCEPTANCE_KEYRING_ROOT: keyRoot };
  for (const [key, name] of Object.entries({
    XDG_CONFIG_HOME: "config",
    XDG_DATA_HOME: "data",
    XDG_CACHE_HOME: "cache",
  })) {
    env[key] = join(keyRoot, name);
    mkdirSync(env[key], { recursive: true, mode: 0o700 });
  }
  mkdirSync(join(keyRoot, "control"), { recursive: true, mode: 0o700 });
  try {
    const child = spawn(
      "dbus-run-session",
      ["--", process.execPath, fileURLToPath(import.meta.url)],
      { env, stdio: "inherit" },
    );
    const [code] = await once(child, "close");
    process.exitCode = code ?? 1;
  } finally {
    rmSync(keyRoot, { recursive: true, force: true });
  }
} else {
  const root = mkdtempSync(join(tmpdir(), "anynote-performance-ui-"));
  const report = {
    format: "anynote.performance-ui-acceptance.v1",
    startedAt: new Date().toISOString(),
    status: "running",
    environment: {
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
      platform: platform(),
      arch: arch(),
      node: process.versions.node,
      packaged: !!process.env.ANYNOTE_EXECUTABLE,
    },
    measurements: {},
    checks: [],
    accessibility: [],
    screenshots: [],
    limitations: [
      "Fresh application processes with OS filesystem cache retained; no system cache purge or power-loss claim.",
      "Synthetic corpus and local Cloudflare Worker adapter; cloud reliability and full-load throughput are covered separately.",
      "Automated WCAG 2.2 AA checks plus keyboard/zoom checks do not replace human screen reader review.",
      "Screenshot CSS viewports are pinned through CDP because the host window manager can constrain native window sizes.",
      "Foreground scheduling flags prevent test-window occlusion throttling; startup measurements retain the OS file cache.",
    ],
  };
  let app, page, server, daemon;
  const output = resolve(
    process.env.ANYNOTE_EXECUTABLE
      ? "test-results/performance-ui-packaged-acceptance.json"
      : "test-results/performance-ui-acceptance.json",
  );
  const save = () => {
    mkdirSync(join(output, ".."), { recursive: true });
    writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  };
  const rpc = (op, input = {}) =>
    page.evaluate(({ op, input }) => window.anynote.request(op, input), {
      op,
      input,
    });
  async function launch() {
    const started = performance.now();
    ({ app, page } = await launchDesktop(root));
    await page.getByRole("button", { name: "切换侧栏", exact: true }).waitFor();
    return performance.now() - started;
  }
  const stats = (values) => {
    const v = [...values].sort((a, b) => a - b);
    return {
      runs: v.length,
      medianMs: +v[Math.floor(v.length / 2)].toFixed(2),
      p95Ms: +v[Math.ceil(v.length * 0.95) - 1].toFixed(2),
      maxMs: +v.at(-1).toFixed(2),
    };
  };
  async function check(name, fn) {
    const item = { name, status: "running" };
    report.checks.push(item);
    save();
    const begin = performance.now();
    try {
      await fn();
      item.status = "passed";
    } catch (e) {
      item.status = "failed";
      item.error = e.message;
      throw e;
    } finally {
      item.durationMs = +(performance.now() - begin).toFixed(2);
      save();
      console.log(name + " — " + item.status);
    }
  }
  async function open(title) {
    await page.keyboard.press("Control+k");
    const input = page.getByPlaceholder("寻找一个想法，或一篇笔记…");
    await input.fill(title);
    const result = page
      .locator(".command-results button")
      .filter({ hasText: title })
      .first();
    await result.waitFor();
    await result.click();
    await page.getByRole("textbox", { name: "笔记标题" }).waitFor();
    await page.waitForFunction(
      (title) =>
        document.querySelector('[aria-label="笔记标题"]')?.value === title,
      title,
    );
  }
  async function waitPdfPaint(pageNumber) {
    await page.waitForFunction((pageNumber) => {
      const text = document.querySelector(".textLayer");
      const canvas = document.querySelector(".pdf-page canvas");
      if (
        !text?.textContent.includes(`Anynote performance page ${pageNumber}`) ||
        !canvas?.width ||
        !canvas?.height
      )
        return false;
      const pixels = canvas
        .getContext("2d")
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (
          pixels[i + 3] > 0 &&
          pixels[i] < 128 &&
          pixels[i + 1] < 128 &&
          pixels[i + 2] < 128 &&
          ++ink > 25
        )
          return true;
      return false;
    }, pageNumber);
  }
  async function resize(width, height) {
    await app.evaluate(
      ({ BrowserWindow }, { width, height }) =>
        BrowserWindow.getAllWindows()[0].setContentSize(width, height),
      { width, height },
    );
    // A window manager may constrain a native window to its work area. Pin the
    // Chromium viewport so each screenshot really uses the requested CSS size.
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => innerWidth), width);
    assert.equal(await page.evaluate(() => innerHeight), height);
  }
  async function audit(name) {
    const r = await new AxeBuilder({ page })
      .setLegacyMode(true)
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    report.accessibility.push({
      name,
      passes: r.passes.length,
      incomplete: r.incomplete.map((x) => ({
        id: x.id,
        targets: x.nodes.map((n) => n.target),
      })),
      violations: r.violations.map((x) => ({
        id: x.id,
        impact: x.impact,
        help: x.help,
        nodes: x.nodes.map((n) => ({
          target: n.target,
          summary: n.failureSummary,
        })),
      })),
    });
    save();
  }
  try {
    if (process.env.ANYNOTE_ACCEPTANCE_KEYRING_ROOT) {
      mkdirSync(
        join(process.env.ANYNOTE_ACCEPTANCE_KEYRING_ROOT, "data/keyrings"),
        { recursive: true, mode: 0o700 },
      );
      daemon = spawn(
        "gnome-keyring-daemon",
        [
          "--foreground",
          "--unlock",
          "--components=secrets",
          "--control-directory",
          join(process.env.ANYNOTE_ACCEPTANCE_KEYRING_ROOT, "control"),
        ],
        { stdio: ["pipe", "ignore", "ignore"] },
      );
      daemon.stdin.end(randomBytes(32).toString("hex"));
      await new Promise((r) => setTimeout(r, 1000));
    }
    const f = await fixture(root);
    report.fixture = {
      notebooks: 1,
      nodes: f.nodes,
      markdownNotes: 10002,
      nestingDepth: 1000,
      ordinaryMarkdownBytes: f.markdownBytes,
      largeMarkdownBytes: f.largeMarkdownBytes,
      pdfBytes: f.pdfBytes,
      pdfPages: f.pages,
    };
    assert.ok(
      f.markdownBytes >= 50 * 1024,
      "ordinary Markdown fixture must contain at least 50KiB",
    );
    const starts = [];
    await check("fresh-process-startup-under-3s", async () => {
      for (let i = 0; i < 5; i++) {
        starts.push(await launch());
        if (i < 4) await app.close();
      }
      report.measurements.startup = stats(starts);
      assert.ok(
        report.measurements.startup.p95Ms < 3000,
        JSON.stringify(report.measurements.startup),
      );
    });
    await resize(1280, 800);
    if (
      !(await page
        .getByRole("button", { name: "搜索笔记", exact: true })
        .isVisible())
    ) {
      await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
    }
    const runtime = await app.evaluate(({ safeStorage }) => ({
      electron: process.versions.electron,
      node: process.versions.node,
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      storageBackend: safeStorage.getSelectedStorageBackend(),
    }));
    Object.assign(report.environment, runtime);
    report.memory = {
      afterStartup: await app.evaluate(({ app }) =>
        app.getAppMetrics().map((p) => ({
          type: p.type,
          workingSetKiB: p.memory.workingSetSize,
        })),
      ),
    };
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await check("10000-node-tree-window-and-last-node-navigation", async () => {
      assert.ok((await page.locator(".tree-row").count()) < 100);
      await open("观测笔记 09999");
      await page.locator(".tree-row.active").waitFor();
      assert.ok(
        (await page.locator(".tree-row.active").innerText()).includes("09999"),
      );
      const times = [];
      for (let i = 0; i < 7; i++) {
        const t = performance.now();
        await page.locator(".tree").evaluate((el, i) => {
          el.scrollTop = i % 2 ? 0 : el.scrollHeight;
        }, i);
        await page.evaluate(
          () =>
            new Promise((r) =>
              requestAnimationFrame(() => requestAnimationFrame(r)),
            ),
        );
        times.push(performance.now() - t);
      }
      report.measurements.treeScroll = stats(times);
      assert.ok(report.measurements.treeScroll.p95Ms < 150);
      assert.ok((await page.locator(".tree-row").count()) < 100);
    });
    await check("indexed-search-10000-notes-p95-under-500ms", async () => {
      const times = [];
      for (let i = 0; i < 20; i++) {
        const t = performance.now();
        const r = await rpc("searchWorkspace", {
          requestId: randomUUID(),
          notebookIds: [f.book.id],
          query: "验收唯一目标 9999",
        });
        times.push(performance.now() - t);
        assert.equal(r.results[0].id, f.ids[9999]);
      }
      report.measurements.search = stats(times);
      assert.ok(report.measurements.search.p95Ms < 500);
    });
    await open("观测笔记 00000");
    await check("first-source-editor-load-under-300ms", async () => {
      report.measurements.firstSourceEditorMs = await page
        .getByRole("button", { name: "源码", exact: true })
        .evaluate(async (el) => {
          const begin = performance.now();
          el.click();
          while (!document.querySelector(".cm-content"))
            await new Promise((r) => requestAnimationFrame(r));
          return +(performance.now() - begin).toFixed(2);
        });
      report.measurements.firstEditorDOMLines = await page
        .locator(".cm-line")
        .count();
      assert.ok(
        report.measurements.firstSourceEditorMs < 300,
        JSON.stringify(report.measurements),
      );
    });
    await check("50KB-markdown-editable-open-under-300ms", async () => {
      const times = [];
      for (let i = 0; i < 10; i++) {
        await open("观测笔记 00001");
        await page.keyboard.press("Control+k");
        await page
          .getByPlaceholder("寻找一个想法，或一篇笔记…")
          .fill("观测笔记 00000");
        const result = page
          .locator(".command-results button")
          .filter({ hasText: "观测笔记 00000" })
          .first();
        await result.waitFor();
        const elapsed = await result.evaluate(async (el) => {
          const t = performance.now();
          performance.clearMeasures("anynote:rpc");
          el.click();
          while (
            !document
              .querySelector(".cm-content")
              ?.textContent.includes("普通文档")
          )
            await new Promise((r) => requestAnimationFrame(r));
          return performance.now() - t;
        });
        times.push(elapsed);
      }
      report.measurements.openMarkdown = stats(times);
      assert.ok(
        report.measurements.openMarkdown.p95Ms < 300,
        JSON.stringify(report.measurements.openMarkdown),
      );
    });
    await check("50KB-local-save-p95-under-150ms", async () => {
      const times = [];
      for (let i = 0; i < 20; i++) {
        const n = await rpc("getNote", { notebookId: f.book.id, id: f.ids[0] });
        const t = performance.now();
        await rpc("saveNote", {
          notebookId: f.book.id,
          id: n.id,
          expectedRevision: n.revision,
          body: n.body + "\n保存 " + i,
        });
        times.push(performance.now() - t);
      }
      report.measurements.saveCommit = stats(times);
      report.measurements.autosaveDebounceMs = 650;
      assert.ok(
        report.measurements.saveCommit.p95Ms < 150,
        JSON.stringify(report.measurements.saveCommit),
      );
    });
    await check(
      "1MB-markdown-source-policy-and-bounded-editor-DOM",
      async () => {
        await open(f.large.title);
        await page
          .getByText("文档超过 1MB，已使用源码模式以保持编辑流畅。")
          .waitFor();
        await page.locator(".cm-content").waitFor();
        assert.ok((await page.locator(".cm-line").count()) < 300);
        assert.equal(await page.locator(".markdown-body").count(), 0);
      },
    );
    await check(
      "100MiB-PDF-range-load-single-page-and-navigation",
      async () => {
        await page.evaluate(() => performance.clearMeasures("anynote:rpc"));
        await open(f.pdf.title);
        await page
          .locator(".textLayer span")
          .first()
          .waitFor({ timeout: 20000 });
        assert.equal(await page.locator(".pdf-reader canvas").count(), 1);
        await page.getByRole("button", { name: "下一页", exact: true }).click();
        await page.waitForFunction(
          () => document.querySelector('[aria-label="PDF 页码"]').value === "2",
        );
        await waitPdfPaint(2);
        report.measurements.pdf = await page.evaluate(() => ({
          rangeBytes: performance
            .getEntriesByName("anynote:rpc")
            .filter((x) => x.detail.operation === "getAssetRange")
            .reduce((sum, x) => sum + x.detail.bytes, 0),
          fullAssetReads: performance
            .getEntriesByName("anynote:rpc")
            .filter((x) => x.detail.operation === "getAsset").length,
          canvases: document.querySelectorAll(".pdf-reader canvas").length,
        }));
        assert.equal(report.measurements.pdf.fullAssetReads, 0);
        assert.ok(report.measurements.pdf.rangeBytes < f.pdfBytes / 4);
        assert.equal(report.measurements.pdf.canvases, 1);
        report.memory.afterPdf = await app.evaluate(({ app }) =>
          app.getAppMetrics().map((p) => ({
            type: p.type,
            workingSetKiB: p.memory.workingSetSize,
          })),
        );
        await page
          .getByRole("button", { name: "为大 PDF 建立全文索引", exact: true })
          .waitFor();
      },
    );
    await check("UI-responsive-during-streamed-100MiB-backup", async () => {
      // A local Cloudflare Worker (D1/R2 adapters) backs the streamed upload so
      // the UI responsiveness measurement does not depend on a real cloud.
      const env = { DB: new D1(), BUCKET: new R2(), APP_TOKEN: randomUUID() },
        uploads = [];
      const bridge = createServer(async (req, res) => {
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = chunks.length ? Buffer.concat(chunks) : undefined;
          if (req.method === "PUT" && body) uploads.push(body.length);
          const response = await worker.fetch(
            new Request("https://backup.test" + req.url, {
              method: req.method,
              headers: req.headers,
              ...(body ? { body } : {}),
            }),
            env,
          );
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (e) {
          res.writeHead(500);
          res.end(e.message);
        }
      });
      await new Promise((r) => bridge.listen(0, "127.0.0.1", r));
      server = {
        close: async () => {
          bridge.closeAllConnections();
          await new Promise((r) => bridge.close(r));
          env.DB.db.close();
        },
      };
      const target = await rpc("configureBackup", {
        notebookId: f.book.id,
        name: "本地性能验收",
        endpoint: `http://127.0.0.1:${bridge.address().port}`,
        allowInsecure: true,
        token: env.APP_TOKEN,
      });
      const job = await rpc("startBackup", {
        notebookId: f.book.id,
        targetId: target.id,
      });
      const times = [];
      let done = false;
      for (let i = 0; i < 180; i++) {
        const t = performance.now();
        await page
          .getByRole("button", { name: "切换主题", exact: true })
          .evaluate((el) => el.click());
        await page.evaluate(
          () =>
            new Promise((r) =>
              requestAnimationFrame(() => requestAnimationFrame(r)),
            ),
        );
        times.push(performance.now() - t);
        const task = (await rpc("listTasks")).find((x) => x.id === job.id);
        if (task.status === "failed") throw Error(task.error);
        if (task.status === "completed") {
          done = true;
          break;
        }
        await page.waitForTimeout(100);
      }
      assert.ok(done, "backup must complete");
      report.measurements.backupUI = stats(times);
      assert.ok(report.measurements.backupUI.p95Ms < 150);
      assert.ok(
        uploads.some((size) => size === 16 * 1024 ** 2),
        "the 100MiB asset must stream in 16MiB chunks",
      );
      report.memory.afterBackup = await app.evaluate(({ app }) =>
        app.getAppMetrics().map((p) => ({
          type: p.type,
          workingSetKiB: p.memory.workingSetSize,
        })),
      );
    });
    await check(
      "themes-three-window-sizes-long-Chinese-deep-tree-missing-media-plugins",
      async () => {
        await open(f.complex.title);
        await page.getByRole("button", { name: "阅读", exact: true }).click();
        await page.locator(".missing-image").waitFor();
        mkdirSync("docs/screenshots/acceptance", { recursive: true });
        for (const theme of ["light", "dark"]) {
          await page
            .getByRole("button", { name: "切换主题", exact: true })
            .evaluate((el, theme) => {
              if (document.documentElement.dataset.theme !== theme) el.click();
            }, theme);
          for (const [width, height] of [
            [1280, 800],
            [1440, 900],
            [1920, 1080],
          ]) {
            await resize(width, height);
            await page.waitForTimeout(100);
            assert.equal(
              await page.evaluate(
                () => document.documentElement.scrollWidth > innerWidth,
              ),
              false,
            );
            const path = `docs/screenshots/acceptance/${theme}-${width}x${height}.png`;
            await page.screenshot({ path, animations: "disabled" });
            report.screenshots.push(path);
            await audit(`editor-${theme}-${width}`);
          }
        }
      },
    );
    await check(
      "keyboard-search-dialog-focus-return-and-tree-controls",
      async () => {
        await page
          .getByRole("button", { name: "搜索笔记", exact: true })
          .focus();
        await page.keyboard.press("Control+k");
        const search = page.getByPlaceholder("寻找一个想法，或一篇笔记…");
        await search.fill("观测笔记 00001");
        await page.locator(".command-results button").first().waitFor();
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        await page.getByRole("textbox", { name: "笔记标题" }).waitFor();
        await page.waitForFunction(
          () =>
            document.querySelector('[aria-label="笔记标题"]')?.value ===
            "观测笔记 00001",
        );
        await page.locator(".tree-row.active .tree-main").focus();
        await page.keyboard.press("Home");
        await page.waitForFunction(
          (id) => document.activeElement?.getAttribute("data-node-id") === id,
          f.folders[0],
        );
        await page.keyboard.press("ArrowLeft");
        await page.waitForFunction(
          (id) =>
            document
              .querySelector(`[data-node-id="${id}"]`)
              ?.getAttribute("aria-expanded") === "false",
          f.folders[0],
        );
        await page.keyboard.press("ArrowRight");
        await page.waitForFunction(
          (id) =>
            document
              .querySelector(`[data-node-id="${id}"]`)
              ?.getAttribute("aria-expanded") === "true",
          f.folders[0],
        );
        await page.keyboard.press("ArrowDown");
        await page.waitForFunction(
          (id) => document.activeElement?.getAttribute("data-node-id") === id,
          f.folders[1],
        );
        await page.keyboard.press("End");
        await page.waitForFunction(
          (id) => document.activeElement?.getAttribute("data-node-id") === id,
          f.pdf.id,
        );

        await page
          .getByRole("button", { name: "新建笔记", exact: true })
          .focus();
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog");
        await dialog.waitFor();
        await audit("create-dialog");
        await page.keyboard.press("Shift+Tab");
        assert.ok(
          await dialog.evaluate((el) => el.contains(document.activeElement)),
        );
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        assert.equal(
          await page.evaluate(() =>
            document.activeElement?.getAttribute("aria-label"),
          ),
          "新建笔记",
        );
      },
    );
    await check("core-pages-WCAG-AA-light-dark", async () => {
      for (const theme of ["light", "dark"]) {
        await page
          .getByRole("button", { name: "切换主题", exact: true })
          .evaluate((el, theme) => {
            if (document.documentElement.dataset.theme !== theme) el.click();
          }, theme);
        for (const [name, button] of [
          ["backup", "本地优先，安心记录"],
          ["extensions", "扩展"],
          ["settings", "设置"],
        ]) {
          await page
            .getByRole("button", { name: button, exact: name !== "backup" })
            .click();
          await page.waitForTimeout(150);
          for (const [width, height] of [
            [1280, 800],
            [1440, 900],
            [1920, 1080],
          ]) {
            await resize(width, height);
            await page.waitForTimeout(100);
            assert.equal(
              await page.evaluate(
                () => document.documentElement.scrollWidth > innerWidth,
              ),
              false,
            );
            const path = `docs/screenshots/acceptance/${name}-${theme}-${width}x${height}.png`;
            await page.screenshot({ path, animations: "disabled" });
            report.screenshots.push(path);
            await audit(`${name}-${theme}-${width}`);
          }
        }
        await page
          .getByRole("button", { name: "网页 / HTML 导入", exact: true })
          .click();
        await page.getByRole("dialog").waitFor();
        await audit("import-" + theme);
        await page.getByRole("button", { name: "关闭", exact: true }).click();
      }
    });
    await check("PDF-and-source-editor-WCAG-AA-light-dark", async () => {
      for (const theme of ["light", "dark"]) {
        await page
          .getByRole("button", { name: "切换主题", exact: true })
          .evaluate((el, theme) => {
            if (document.documentElement.dataset.theme !== theme) el.click();
          }, theme);
        await open(f.pdf.title);
        await page.locator(".pdf-page canvas").waitFor();
        await waitPdfPaint(2);
        for (const [width, height] of [
          [1280, 800],
          [1440, 900],
          [1920, 1080],
        ]) {
          await resize(width, height);
          await page.waitForTimeout(100);
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth,
            ),
            false,
          );
          const path = `docs/screenshots/acceptance/pdf-${theme}-${width}x${height}.png`;
          await page.screenshot({ path, animations: "disabled" });
          report.screenshots.push(path);
          await audit(`pdf-${theme}-${width}`);
        }
        await open("观测笔记 00000");
        await page.getByRole("button", { name: "源码", exact: true }).click();
        await page.locator(".cm-content").waitFor();
        await audit(`source-${theme}`);
        const path = `docs/screenshots/acceptance/source-${theme}.png`;
        await page.screenshot({ path, animations: "disabled" });
        report.screenshots.push(path);
      }
      await page.getByRole("button", { name: "设置", exact: true }).click();
    });
    await check("200-percent-zoom-reflow-and-reduced-motion", async () => {
      await resize(1280, 800);
      await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0];
        w.setContentSize(1280, 800);
        w.webContents.setZoomFactor(2);
      });
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => innerWidth), 640);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      if (
        await page
          .getByRole("button", { name: "收起侧栏", exact: true })
          .isVisible()
      )
        await page
          .getByRole("button", { name: "收起侧栏", exact: true })
          .click();
      await page
        .getByRole("heading", { name: "从云端恢复", exact: true })
        .waitFor();
      await audit("settings-200percent");
      await page.emulateMedia({ reducedMotion: "reduce" });
      assert.equal(
        await page
          .getByRole("button", { name: "切换侧栏", exact: true })
          .evaluate((el) => getComputedStyle(el).transitionDuration),
        "0s",
      );
      const path = "docs/screenshots/acceptance/zoom-200.png";
      await page.screenshot({ path, animations: "disabled" });
      report.screenshots.push(path);
    });
    assert.deepEqual(errors, []);
    await check("WCAG-AA-no-automated-violations", async () => {
      assert.equal(
        report.accessibility.filter((x) => x.violations.length).length,
        0,
        "WCAG violations: " +
          report.accessibility
            .filter((x) => x.violations.length)
            .map((x) => x.name)
            .join(", "),
      );
    });
    report.status = "passed";
  } catch (e) {
    report.status = "failed";
    report.error = { name: e.name, message: e.message, stack: e.stack };
    process.exitCode = 1;
    if (page) {
      mkdirSync("docs/screenshots/acceptance", { recursive: true });
      await page
        .screenshot({ path: "docs/screenshots/acceptance/failure.png" })
        .catch(() => {});
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    save();
    await app?.close();
    await server?.close();
    if (daemon && daemon.exitCode === null) {
      const stopped = once(daemon, "close");
      daemon.kill("SIGTERM");
      await stopped;
    }
    rmSync(root, { recursive: true, force: true });
    console.log(report.status + ": " + output);
  }
}
