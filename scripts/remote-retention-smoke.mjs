import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { expect } from "@playwright/test";
import { createServer } from "vite";

// Exercise the production dialog with simulated RPC; cloud persistence is
// separately covered by the backend contract suite and local workerd.
const server = await createServer({
  appType: "custom",
  server: { port: 0, strictPort: false },
});
server.middlewares.use(async (req, res, next) => {
  if (req.url !== "/__retention") return next();
  res.setHeader("Content-Type", "text/html");
  res.end(
    await server.transformIndexHtml(
      req.url,
      `<!doctype html><html lang="zh-CN"><div id="root"></div>
<script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
const {default: Maintenance} = await import('/src/RemoteMaintenance.tsx');
createRoot(document.getElementById('root')).render(React.createElement(Maintenance, {
notebookId: 'book', target: {id: 'target', name: '测试目标', lineageId: 'lineage'}, onClose() {}, onChanged() {}
}));
</script></html>`,
    ),
  );
});
let browser;
const report = { mode: "browser-simulated-rpc", status: "running", checks: [] };
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.ANYNOTE_BROWSER
      ? { executablePath: process.env.ANYNOTE_BROWSER }
      : {}),
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let policy = null,
    plan = null,
    applied = 0;
  await page.route("**/api/rpc", async (route) => {
    const { op, input } = route.request().postDataJSON();
    let result;
    if (op === "remoteRetentionState") result = { activePlan: null, policy };
    else if (op === "previewRemoteRetention")
      result = plan = {
        id: "plan",
        keep: input.keep,
        calendar: input.calendar,
        referenceTime: new Date().toISOString(),
        remove: [
          {
            id: "expired-upload",
            createdAt: new Date().toISOString(),
            status: "staging",
          },
        ],
        objects: [],
        protected: ["head"],
        staging: 1,
        expiredStaging: 1,
        reclaimBytes: 1048576,
        graceHours: 24,
        space: {
          totalBytes: 2097152,
          retainedBytes: 1048576,
          deferredObjects: 0,
        },
      };
    else if (op === "saveRemoteRetention")
      result = policy = { keep: input.keep, calendar: input.calendar };
    else if (op === "applyRemoteRetention") {
      assert.equal(input.confirmed, true);
      applied++;
      result = { completed: true };
    } else throw Error("Unexpected operation " + op);
    await route.fulfill({ json: { result } });
  });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/__retention`;
  await page.goto(url);
  await expect(page.getByLabel("保留最近版本数")).toBeEnabled();
  await expect(page.getByRole("button", { name: "保存保留配置" })).toHaveCount(
    0,
  );
  await page.getByLabel("保留最近版本数").fill("7");
  await page.getByLabel("每日采样保留天数").fill("14");
  await page.getByRole("button", { name: "预览清理", exact: true }).click();
  await expect(page.getByText(/当前数据占用 2.00 MB/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "确认永久清理" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "保存保留配置" }).click();
  await expect(page.getByRole("status")).toContainText("清理仍需手动");
  assert.equal(applied, 0);
  report.checks.push(
    "first preview estimates space; saving never applies deletion",
  );
  await page.reload();
  await expect(page.getByLabel("保留最近版本数")).toHaveValue("7");
  await expect(page.getByLabel("每日采样保留天数")).toHaveValue("14");
  await expect(page.getByText(/不会定时删除/)).toBeVisible();
  report.checks.push(
    "reopening loads the target policy and manual-only semantics",
  );
  await page.getByRole("button", { name: "预览清理", exact: true }).click();
  await page.getByRole("checkbox").check();
  await page.getByLabel("每日采样保留天数").fill("15");
  await expect(page.getByRole("button", { name: "确认永久清理" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "预览清理", exact: true }).click();
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "确认永久清理" }).click();
  await expect(page.getByRole("status")).toContainText("清理已完成");
  assert.equal(applied, 1);
  assert.equal(plan.calendar.dailyDays, 15);
  assert.deepEqual(errors, []);
  report.checks.push(
    "changing policy invalidates confirmation; apply requires a new explicit confirmation",
  );
  report.status = "passed";
  console.log("Remote retention UI: 3 checks passed (simulated RPC).");
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  throw error;
} finally {
  await browser?.close();
  await server.close();
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/remote-retention-ui.json",
    JSON.stringify(report, null, 2) + "\n",
  );
}
