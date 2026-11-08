import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { _electron } from "playwright";
import { videoCard, videoEmbed } from "../.build/packages/protocol/video.js";
import { openNotebook } from "./acceptance/open-notebook.mjs";

mkdirSync("tmp/reports/rm01", { recursive: true });
const root = mkdtempSync(resolve("tmp/rm01-ui-"));
const report = {
  baselineCommit: "60a8c4b614b8831d2a16366a79d595942e7b87a1",
  scope:
    "isolated old Electron renderer; iframe responses intercepted locally, not remote playback",
  providers: [],
  status: "running",
};
let app;
try {
  app = await _electron.launch({
    args: [".", "--no-sandbox"],
    env: {
      ...process.env,
      ANYNOTE_USER_DATA_DIR: root,
      ANYNOTE_DEV: "",
      ELECTRON_RUN_AS_NODE: "",
    },
  });
  const page = await app.firstWindow();
  await openNotebook(page);
  report.retention = await page.evaluate(async () => {
    try {
      await window.anynote.request("saveRemoteRetention", {});
      return { outcome: "resolved" };
    } catch (e) {
      return { outcome: "rejected", message: e.message };
    }
  });
  assert.equal(report.retention.outcome, "rejected");
  assert.match(report.retention.message, /未授权请求/);
  for (const url of [
    "https://youtu.be/dQw4w9WgXcQ",
    "https://vimeo.com/123456789",
    "https://www.bilibili.com/video/BV1xx411c7mD",
  ]) {
    const card = videoCard(url),
      embed = videoEmbed(card);
    let intercepted = false;
    await page.route(embed, async (route) => {
      intercepted = true;
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Local CSP probe</title>",
      });
    });
    const result = await page.evaluate(
      (src) =>
        new Promise((done) => {
          const frame = document.createElement("iframe");
          let violation;
          const listener = (event) => {
            if (event.effectiveDirective === "frame-src")
              violation = {
                directive: event.effectiveDirective,
                blockedURI: event.blockedURI,
              };
          };
          document.addEventListener("securitypolicyviolation", listener);
          frame.src = src;
          document.body.append(frame);
          setTimeout(() => {
            document.removeEventListener("securitypolicyviolation", listener);
            frame.remove();
            done({ violation: violation ?? null });
          }, 500);
        }),
      embed,
    );
    report.providers.push({
      provider: card.provider,
      embed,
      intercepted,
      ...result,
    });
    if (card.provider === "youtube") assert(intercepted && !result.violation);
    else assert(result.violation && !intercepted);
    await page.unroute(embed);
  }
  report.status = "passed-known-gap-probes";
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await app?.close();
  rmSync(root, { recursive: true, force: true });
  writeFileSync(
    "tmp/reports/rm01/known-gaps.json",
    JSON.stringify(report, null, 2) + "\n",
  );
}
