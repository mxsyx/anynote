import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { unzipSync } from "fflate";
import { managedCloudConfig } from "./cloud/deploy.mjs";
import { readCloudConfig, redact } from "./cloud/config.mjs";
const args = process.argv.slice(2);
const providerIndex = args.indexOf("--provider");
const provider = providerIndex < 0 ? "cloudflare" : args[providerIndex + 1];
if (!["cloudflare", "s3"].includes(provider))
  throw Error("--provider 仅支持 cloudflare 或 s3");
const maintenance = args.includes("--maintenance");

// Optional isolated, real Secret Service; never substitute safeStorage or its vault.
if (args.includes("--isolated-keyring")) {
  if (process.platform !== "linux") throw Error("隔离 keyring 仅适用于 Linux");
  const root = mkdtempSync(join(tmpdir(), "anynote-desktop-keyring-"));
  const env = { ...process.env, ANYNOTE_ACCEPTANCE_KEYRING_ROOT: root };
  for (const [key, name] of Object.entries({
    XDG_CONFIG_HOME: "config",
    XDG_DATA_HOME: "data",
    XDG_CACHE_HOME: "cache",
  })) {
    env[key] = join(root, name);
    mkdirSync(env[key], { recursive: true, mode: 0o700 });
  }
  try {
    const child = spawn(
      "dbus-run-session",
      [
        "--",
        process.execPath,
        fileURLToPath(import.meta.url),
        "--provider",
        provider,
        ...(maintenance ? ["--maintenance"] : []),
        ...(args.includes("--local-s3") ? ["--local-s3"] : []),
        ...(args.includes("--cold-recovery") ? ["--cold-recovery"] : []),
      ],
      { env, stdio: "inherit" },
    );
    const [code] = await once(child, "close");
    process.exitCode = code ?? 1;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
} else {
  await acceptance();
}
async function acceptance() {
  const settings =
    provider === "s3"
      ? readCloudConfig("s3", process.env, {
          allowLocalHTTP: args.includes("--local-s3"),
        })
      : process.env.ANYNOTE_CF_ENDPOINT && process.env.ANYNOTE_CF_TOKEN
        ? readCloudConfig("cloudflare")
        : null;
  if (settings?.missing?.length)
    throw Error("缺少配置：" + settings.missing.join(", "));
  const config =
    provider === "s3"
      ? { ...settings.config, ...settings.secrets }
      : settings?.config
        ? { endpoint: settings.config.endpoint, token: settings.secrets.token }
        : managedCloudConfig();
  if (!config)
    throw Error("请先运行 pnpm run cloud:deploy，或提供完整 Cloudflare 配置。");
  const reportEnv = {
    ...process.env,
    ...(config.token ? { ANYNOTE_CF_TOKEN: config.token } : {}),
  };
  const privateValues = [
    config.token,
    config.accessKeyId,
    config.secretAccessKey,
    config.sessionToken,
  ].filter(Boolean);
  const root = mkdtempSync(join(tmpdir(), "anynote-desktop-cloud-"));
  const reportPath = resolve(
    maintenance && provider === "s3"
      ? process.env.ANYNOTE_EXECUTABLE
        ? "test-results/desktop-s3-maintenance-packaged-acceptance.json"
        : "test-results/desktop-s3-maintenance-acceptance.json"
      : maintenance
        ? process.env.ANYNOTE_EXECUTABLE
          ? "test-results/desktop-cloud-maintenance-packaged-acceptance.json"
          : "test-results/desktop-cloud-maintenance-acceptance.json"
        : provider === "s3"
          ? "test-results/desktop-s3-acceptance.json"
          : "test-results/desktop-cloud-acceptance.json",
  );
  const report = {
    format: "anynote.desktop-cloud-acceptance.v1",
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    mode: args.includes("--local-s3")
      ? "desktop-local-real-s3"
      : "desktop-real-cloud",
    entry: process.env.ANYNOTE_EXECUTABLE
      ? "linux-packaged"
      : "source-production",
    provider,
    endpoint: config.endpoint,
    ...(provider === "s3"
      ? {
          bucket: config.bucket,
          region: config.region,
          pathStyle: config.pathStyle,
        }
      : {}),
    status: "running",
    keyringSession: process.env.ANYNOTE_ACCEPTANCE_KEYRING_ROOT
      ? "isolated-real-gnome-keyring"
      : "existing-system-session",
    maintenance,
    steps: [],
    limitations: [
      "只验证当前 Linux/Electron 环境；未验证 Windows/macOS、系统重启或长期运行。",
      "自动备份使用正式 60 秒轮询和 10 分钟间隔配置；验证重启后到期的首个备份，不是持续 10 分钟负载测试。",
      "云端临时 Notebook/lineage 数据保留；桌面数据和隔离 keyring 在结束时删除。",
      "--no-sandbox 用于本环境启动；窗口仍验证 sandbox/contextIsolation 设置。",
    ],
  };
  function save() {
    mkdirSync(join(process.cwd(), "test-results"), { recursive: true });
    writeFileSync(
      reportPath,
      JSON.stringify(redact(report, reportEnv), null, 2) + "\n",
      { mode: 0o600, flush: true },
    );
  }
  async function check(name, action) {
    const step = { name, status: "running" };
    report.steps.push(step);
    save();
    console.log(name + " — running");
    const start = performance.now();
    try {
      await action();
      step.status = "passed";
    } catch (error) {
      step.status = "failed";
      throw error;
    } finally {
      step.durationMs = Math.round(performance.now() - start);
      save();
      console.log(name + " — " + step.status);
    }
  }
  let app,
    page,
    daemon,
    book,
    note,
    target,
    firstVersion,
    secondVersion,
    originalBody,
    changedBody;
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=";
  const request = (op, input = {}) =>
    page.evaluate(({ op, input }) => window.anynote.request(op, input), {
      op,
      input,
    });
  const backups = () => request("listBackupTargets", { notebookId: book.id });
  const launch = async (userData = root) => {
    const env = {
      ...process.env,
      ANYNOTE_USER_DATA_DIR: userData,
      ANYNOTE_DEV: "",
      ELECTRON_RUN_AS_NODE: "",
      NODE_USE_ENV_PROXY: "1",
    };
    for (const key of [
      "ANYNOTE_CF_TOKEN",
      "ANYNOTE_CF_ENDPOINT",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "CLOUDFLARE_API_TOKEN",
    ])
      delete env[key];
    // Launch the real application directly. Playwright's Electron loader forces
    // --password-store=basic, invalidating a system-vault acceptance test.
    const executable =
      process.env.ANYNOTE_EXECUTABLE ||
      resolve("node_modules/electron/dist/electron");
    const child = spawn(
      executable,
      [
        "--inspect=0",
        "--remote-debugging-port=0",
        ...(process.env.ANYNOTE_EXECUTABLE ? [] : ["."]),
        "--no-sandbox",
        ...(process.env.ANYNOTE_ACCEPTANCE_KEYRING_ROOT
          ? ["--password-store=gnome-libsecret", "--ozone-platform=x11"]
          : []),
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let logs = "",
      inspectorURL,
      browserURL;
    const collect = (bytes) => {
      logs = (logs + bytes.toString()).slice(-12000);
      inspectorURL ||= logs.match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1];
      browserURL ||= logs.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    let browser, inspector;
    app = {
      async close() {
        await browser?.close();
        inspector?.close();
        if (child.exitCode === null && !child.signalCode) {
          child.kill("SIGTERM");
          await Promise.race([
            once(child, "close"),
            new Promise((resolve) => setTimeout(resolve, 5000)),
          ]);
          if (child.exitCode === null && !child.signalCode)
            child.kill("SIGKILL");
        }
      },
    };
    for (let i = 0; i < 300 && (!inspectorURL || !browserURL); i++) {
      if (child.exitCode !== null || child.signalCode)
        throw Error("Electron 启动失败：" + logs);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!inspectorURL || !browserURL)
      throw Error("Electron 调试连接启动超时：" + logs);
    inspector = new WebSocket(inspectorURL);
    await once(inspector, "open");
    let id = 0;
    const pending = new Map();
    inspector.addEventListener("message", (event) => {
      const data = JSON.parse(String(event.data)),
        entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      data.error || data.result?.exceptionDetails
        ? entry.reject(
            Error(data.error?.message || data.result.exceptionDetails.text),
          )
        : entry.resolve(data.result.result.value);
    });
    app.evaluate = (fn) =>
      new Promise((resolve, reject) => {
        const callId = ++id;
        pending.set(callId, { resolve, reject });
        inspector.send(
          JSON.stringify({
            id: callId,
            method: "Runtime.evaluate",
            params: {
              expression:
                "(" +
                fn.toString() +
                ")(process.mainModule.require('electron'))",
              returnByValue: true,
              awaitPromise: true,
            },
          }),
        );
      });
    browser = await chromium.connectOverCDP(browserURL);
    const context = browser.contexts()[0];
    for (let i = 0; i < 100 && !context.pages().length; i++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    page = context.pages()[0];
    await page.setViewportSize({ width: 1440, height: 900 });
    await page
      .getByRole("textbox", { name: "笔记标题" })
      .waitFor({ timeout: 30000 });
  };
  const navigateBackup = async () => {
    await page
      .getByRole("button", { name: "本地优先，安心记录", exact: false })
      .click();
    await page.getByRole("button", { name: "添加目标", exact: true }).waitFor();
  };
  const closeTasks = async () => {
    const dialog = page.getByRole("dialog", { name: "任务中心", exact: true });
    // Even a skipped backup completes before React opens its task dialog.
    // Wait for that UI transition before closing and selecting a cloud version.
    await dialog.waitFor({ state: "visible", timeout: 10000 });
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  };
  async function waitTask(type, previous = []) {
    const deadline = Date.now() + 360000;
    let notified = Date.now();
    while (Date.now() < deadline) {
      const jobs = await request("listTasks");
      const job = jobs.find(
        (j) =>
          j.type === type &&
          !previous.includes(j.id) &&
          (type !== "backup" || j.targetId === target.id),
      );
      if (job?.status === "failed") throw Error(job.error);
      if (job?.status === "completed") return job;
      if (Date.now() - notified > 15000) {
        console.log(
          "等待正式桌面任务：" + (job?.progress || "调度器 60 秒轮询"),
        );
        notified = Date.now();
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw Error("桌面任务超时：" + type);
  }
  async function verifyRestore(id, body, verifySource = true) {
    assert.notEqual(id, book.id);
    const restored = await request("getNote", { notebookId: id, id: note.id });
    assert.equal(restored.body, body);
    assert.equal(restored.title, "Cloudflare 桌面验收");
    assert.deepEqual(restored.tags, ["桌面云验收"]);
    assert.equal(restored.favorite, 1);
    const resource = restored.body.match(/anynote-resource:([a-f0-9-]{36})/)[1];
    assert.equal(
      (
        await request("getAsset", {
          notebookId: id,
          id: resource,
          noteId: note.id,
        })
      ).data,
      png,
    );
    assert.ok(
      (await request("history", { notebookId: id, id: note.id })).length >= 3,
    );
    assert.ok(
      (await request("listNodes", { notebookId: id })).some(
        (n) => n.title === "云端回收站" && n.deleted_at,
      ),
    );
    assert.ok(
      (await request("search", { notebookId: id, query: "桌面中文正文" })).some(
        (n) => n.id === note.id,
      ),
    );
    if (verifySource) {
      const current = await request("getNote", {
        notebookId: book.id,
        id: note.id,
      });
      assert.equal(current.body, changedBody);
    }
    report.restoredNotebookIds ||= [];
    report.restoredNotebookIds.push(id);
  }
  save();
  try {
    if (process.env.ANYNOTE_ACCEPTANCE_KEYRING_ROOT) {
      mkdirSync(join(process.env.ANYNOTE_ACCEPTANCE_KEYRING_ROOT, "control"), {
        recursive: true,
        mode: 0o700,
      });
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
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await check("real-electron-system-encryption-and-sandbox", async () => {
      await launch();
      report.runtime = await app.evaluate(({ safeStorage, BrowserWindow }) => {
        const preferences =
          BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
        return {
          electron: process.versions.electron,
          node: process.versions.node,
          encryptionAvailable: safeStorage.isEncryptionAvailable(),
          backend: safeStorage.getSelectedStorageBackend(),
          sandbox: preferences.sandbox,
          contextIsolation: preferences.contextIsolation,
          nodeIntegration: preferences.nodeIntegration,
        };
      });
      assert.equal(report.runtime.sandbox, true);
      assert.equal(report.runtime.contextIsolation, true);
      assert.equal(report.runtime.nodeIntegration, false);
      if (
        !report.runtime.encryptionAvailable ||
        report.runtime.backend === "basic_text"
      )
        throw Error(
          "系统 keyring 不可用；请解锁系统 keyring，或在 Linux 使用 --isolated-keyring 验证真实隔离 Secret Service。",
        );
    });
    await check("desktop-fixture-save-history-trash-and-resource", async () => {
      book = (await request("listNotebooks"))[0];
      report.notebookId = book.id;
      await page.getByRole("button", { name: "新建笔记", exact: true }).click();
      await page.getByPlaceholder("输入一个名称…").fill("Cloudflare 桌面验收");
      await page.getByRole("button", { name: "创建", exact: true }).click();
      await page.getByRole("button", { name: "源码", exact: true }).click();
      await page
        .locator(".cm-content")
        .fill(
          '# 桌面云验收\n\n桌面中文正文。\n\n:::anynote{type="future.block" version="9" id="desktop-cloud"}\n{"keep":"未知块原样保留"}\n:::\n',
        );
      await page.keyboard.press("Control+s");
      await page.getByText("已保存至本地", { exact: true }).waitFor();
      const found = (await request("listNodes", { notebookId: book.id })).find(
        (n) => n.title === "Cloudflare 桌面验收",
      );
      note = await request("getNote", { notebookId: book.id, id: found.id });
      note = await request("saveNote", {
        notebookId: book.id,
        id: note.id,
        expectedRevision: note.revision,
        body: note.body,
        tags: ["桌面云验收"],
        favorite: true,
      });
      note = await request("addResource", {
        notebookId: book.id,
        id: note.id,
        expectedRevision: note.revision,
        name: "桌面像素.png",
        mime: "image/png",
        data: png,
      });
      originalBody = note.body;
      const trash = await request("createNode", {
        notebookId: book.id,
        kind: "note",
        title: "云端回收站",
      });
      await request("trashNode", { notebookId: book.id, id: trash.id });
      await page.reload();
      await page.getByRole("textbox", { name: "笔记标题" }).waitFor();
    });
    await check("configure-through-UI-and-encrypt-token", async () => {
      await navigateBackup();
      await page.getByRole("button", { name: "添加目标", exact: true }).click();
      const form = page.getByRole("dialog", { name: "配置备份", exact: true });
      await form.getByRole("combobox").first().selectOption(provider);
      await form
        .getByLabel("名称", { exact: true })
        .fill("真实 " + provider + " 桌面验收");
      await form.getByLabel("Endpoint", { exact: true }).fill(config.endpoint);
      if (provider === "cloudflare")
        await form.getByLabel("应用 Token", { exact: true }).fill(config.token);
      else {
        await form.getByLabel("Bucket", { exact: true }).fill(config.bucket);
        await form.getByLabel("Region", { exact: true }).fill(config.region);
        const prefix = "anynote-desktop-acceptance/" + report.runId;
        await form.getByLabel("Prefix", { exact: true }).fill(prefix);
        report.prefix = prefix;
        await form
          .locator('select[name="addressing"]')
          .selectOption(config.pathStyle ? "path" : "virtual");
        await form
          .getByLabel("Access Key ID", { exact: true })
          .fill(config.accessKeyId);
        await form
          .getByLabel("Secret Access Key", { exact: true })
          .fill(config.secretAccessKey);
        if (config.sessionToken)
          await form.locator('input[name="session"]').fill(config.sessionToken);
      }
      if (config.allowInsecure)
        await form
          .getByRole("checkbox", { name: "允许 HTTP，仅用于可信本机测试服务" })
          .check();
      await form.getByRole("button", { name: "保存配置", exact: true }).click();
      await form.waitFor({ state: "hidden", timeout: 30000 });
      target = (await backups())[0];
      assert.equal(target.credentialsMode, "system-encrypted");
      assert.equal(target.autoBackup, undefined);
      report.targetId = target.id;
      report.lineageId = target.lineageId;
      const bytes = readFileSync(join(root, "secrets", target.id + ".bin"));
      assert.ok(bytes.length > 0);
      for (const value of privateValues)
        assert.ok(!bytes.includes(Buffer.from(value)));
      const metadata = readFileSync(
        join(root, "notebooks", "_local", "backup-targets.json"),
        "utf8",
      );
      for (const value of privateValues) assert.ok(!metadata.includes(value));
      for (const value of privateValues)
        assert.ok(!JSON.stringify(target).includes(value));
      if (provider === "s3") assert.equal(target.pathStyle, config.pathStyle);
      await page.getByRole("button", { name: "测试连接", exact: true }).click();
      await page
        .getByRole("alert")
        .filter({ hasText: "连接测试通过" })
        .waitFor({ timeout: 90000 });
    });
    await check(
      "enable-auto-backup-and-restart-without-token-in-environment",
      async () => {
        await page
          .getByRole("checkbox", { name: "自动备份 · 每 10 分钟检查变更" })
          .click();
        for (let i = 0; i < 50 && !(await backups())[0].autoBackup; i++)
          await new Promise((r) => setTimeout(r, 100));
        assert.equal((await backups())[0].autoBackup, true);
        assert.equal((await backups())[0].intervalMinutes, 10);
        await app.close();
        app = null;
        await launch();
        await navigateBackup();
        assert.equal(
          await page
            .getByRole("checkbox", { name: "自动备份 · 每 10 分钟检查变更" })
            .isChecked(),
          true,
        );
        assert.equal((await backups())[0].id, target.id);
      },
    );
    await check(
      "real-scheduler-auto-backup-after-restart-and-task-center",
      async () => {
        await page
          .getByRole("button", { name: "任务中心", exact: true })
          .click();
        const job = await waitTask("backup");
        assert.ok(!job.progress.includes("跳过"));
        await page
          .getByRole("dialog", { name: "任务中心", exact: true })
          .getByText(job.progress, { exact: true })
          .waitFor({ timeout: 5000 });
        const versions = await request("listRemoteBackups", {
          notebookId: book.id,
          targetId: target.id,
        });
        assert.equal(versions.length, 1);
        firstVersion = versions[0];
        report.firstGenerationId = firstVersion.id;
        const saved = (await backups())[0];
        assert.equal(saved.lastGeneration, firstVersion.id);
        assert.equal(saved.pendingGeneration, null);
        assert.ok(saved.lastAckSeq > 0);
        await closeTasks();
        await page
          .getByRole("checkbox", { name: "自动备份 · 每 10 分钟检查变更" })
          .click();
        for (let i = 0; i < 50 && (await backups())[0].autoBackup; i++)
          await new Promise((r) => setTimeout(r, 100));
        assert.equal((await backups())[0].autoBackup, false);
      },
    );
    await check(
      "manual-changed-backup-and-unchanged-skip-through-UI",
      async () => {
        note = await request("getNote", { notebookId: book.id, id: note.id });
        changedBody = originalBody + "\n重启后的第二个桌面版本。";
        note = await request("saveNote", {
          notebookId: book.id,
          id: note.id,
          expectedRevision: note.revision,
          body: changedBody,
        });
        let previous = (await request("listTasks")).map((j) => j.id);
        await page
          .getByRole("button", { name: "立即备份", exact: true })
          .click();
        await waitTask("backup", previous);
        await closeTasks();
        const versions = await request("listRemoteBackups", {
          notebookId: book.id,
          targetId: target.id,
        });
        assert.equal(versions.length, 2);
        secondVersion = versions.find((v) => v.id !== firstVersion.id);
        report.secondGenerationId = secondVersion.id;
        previous = (await request("listTasks")).map((j) => j.id);
        await page
          .getByRole("button", { name: "立即备份", exact: true })
          .click();
        const job = await waitTask("backup", previous);
        assert.ok(job.progress.includes("没有变化"));
        await closeTasks();
        assert.equal(
          (
            await request("listRemoteBackups", {
              notebookId: book.id,
              targetId: target.id,
            })
          ).length,
          2,
        );
      },
    );
    await check("restore-old-and-new-cloud-versions-through-UI", async () => {
      for (const [version, body] of [
        [firstVersion, originalBody],
        [secondVersion, changedBody],
      ]) {
        const previous = (await request("listTasks")).map((j) => j.id);
        await page
          .getByRole("button", { name: "历史版本", exact: true })
          .click();
        const dialog = page.getByRole("dialog", {
          name: "远端备份版本",
          exact: true,
        });
        await dialog
          .locator(".snapshot-row")
          .filter({ hasText: "seq " + version.snapshotSeq + " ·" })
          .getByRole("button", { name: "恢复为副本", exact: true })
          .click();
        const job = await waitTask("restore", previous);
        assert.ok(job.restoredId);
        await verifyRestore(job.restoredId, body);
        await closeTasks();
      }
    });
    await check("archive-excludes-credentials-and-backup-targets", async () => {
      const archive = await request("exportArchive", { notebookId: book.id });
      const files = unzipSync(Buffer.from(archive.data, "base64"));
      for (const [name, bytes] of Object.entries(files)) {
        assert.ok(
          !name.includes("secrets") && !name.includes("backup-targets"),
        );
        for (const value of privateValues)
          assert.ok(!Buffer.from(bytes).includes(Buffer.from(value)));
      }
    });
    await check(
      "second-restart-preserves-cursor-and-decrypts-token",
      async () => {
        const prior = (await backups())[0];
        await app.close();
        app = null;
        await launch();
        await navigateBackup();
        const current = (await backups())[0];
        assert.equal(current.autoBackup, false);
        assert.equal(current.lastGeneration, prior.lastGeneration);
        assert.equal(current.lastAckSeq, prior.lastAckSeq);
        await page
          .getByRole("button", { name: "测试连接", exact: true })
          .click();
        await page
          .getByRole("alert")
          .filter({ hasText: "连接测试通过" })
          .waitFor({ timeout: 90000 });
        assert.equal(
          (
            await request("listRemoteBackups", {
              notebookId: book.id,
              targetId: target.id,
            })
          ).length,
          2,
        );
      },
    );
    if (maintenance) {
      await check(
        "remote-retention-preview-confirmation-and-head-restore-through-UI",
        async () => {
          await page
            .getByRole("button", { name: "远端维护", exact: true })
            .click();
          const dialog = page.getByRole("dialog", {
            name: "远端维护",
            exact: true,
          });
          if (provider === "s3")
            await dialog
              .getByRole("checkbox", {
                name: /确认访问此分支的所有客户端已升级/,
              })
              .check();
          await dialog.getByLabel("保留最近版本数").fill("1");
          await dialog.getByLabel("每日采样保留天数").fill("7");
          await dialog.getByLabel("每周采样保留周数").fill("4");
          await dialog.getByLabel("每月采样保留月数").fill("12");
          await dialog
            .getByRole("button", { name: "预览清理", exact: true })
            .click();
          await dialog
            .getByText(/将删除 1 个旧版本/)
            .waitFor({ timeout: 90000 });
          await dialog
            .getByText(/7 天日采样 \/ 4 周周采样 \/ 12 月月采样/)
            .waitFor();
          await dialog
            .getByText("查看策略保留版本与原因", { exact: true })
            .click();
          await dialog.getByText(/日采样、周采样、月采样/).waitFor();
          const apply = dialog.getByRole("button", {
            name: "确认永久清理",
            exact: true,
          });
          assert.equal(await apply.isEnabled(), false);
          assert.equal(
            (
              await request("listRemoteBackups", {
                notebookId: book.id,
                targetId: target.id,
              })
            ).length,
            2,
          );
          await dialog
            .getByRole("checkbox", {
              name: "我确认永久删除列出的远端版本和对象",
            })
            .check();
          await apply.click();
          await dialog
            .getByRole("status")
            .filter({ hasText: "清理已完成" })
            .waitFor({ timeout: 90000 });
          assert.deepEqual(
            (
              await request("listRemoteBackups", {
                notebookId: book.id,
                targetId: target.id,
              })
            ).map((v) => v.id),
            [secondVersion.id],
          );
          await dialog
            .getByRole("button", { name: "关闭", exact: true })
            .click();
          const previous = (await request("listTasks")).map((j) => j.id);
          await page
            .getByRole("button", { name: "历史版本", exact: true })
            .click();
          await page
            .getByRole("dialog", { name: "远端备份版本", exact: true })
            .getByRole("button", { name: "恢复为副本", exact: true })
            .click();
          const job = await waitTask("restore", previous);
          await verifyRestore(job.restoredId, changedBody);
          await closeTasks();
        },
      );
      if (provider === "cloudflare") {
        await check(
          "remote-writer-confirmation-and-persisted-epoch-through-UI",
          async () => {
            await page
              .getByRole("button", { name: "远端维护", exact: true })
              .click();
            const dialog = page.getByRole("dialog", {
              name: "远端维护",
              exact: true,
            });
            await dialog
              .getByRole("button", { name: "设备接管", exact: true })
              .click();
            await dialog
              .getByRole("button", { name: "读取写入权", exact: true })
              .click();
            const apply = dialog.getByRole("button", {
              name: "确认设备接管",
              exact: true,
            });
            await apply.waitFor({ timeout: 90000 });
            assert.equal(await apply.isEnabled(), false);
            await dialog
              .getByRole("checkbox", {
                name: "我确认撤销原设备并接管此远端分支",
              })
              .check();
            await apply.click();
            await dialog
              .getByRole("status")
              .filter({ hasText: "已接管写入权" })
              .waitFor({ timeout: 90000 });
            const [saved] = await backups();
            assert.equal(saved.writerEpoch, 2);
            assert.equal(saved.remoteNotebookId, book.id);
            assert.equal(saved.autoBackup, false);
            assert.equal(saved.lastAckSeq, null);
            await dialog
              .getByRole("button", { name: "关闭", exact: true })
              .click();
          },
        );
        await check(
          "claimed-writer-backup-after-restart-through-UI",
          async () => {
            await app.close();
            app = null;
            await launch();
            await navigateBackup();
            assert.equal((await backups())[0].writerEpoch, 2);
            const previous = (await request("listTasks")).map((j) => j.id);
            await page
              .getByRole("button", { name: "立即备份", exact: true })
              .click();
            await waitTask("backup", previous);
            await closeTasks();
            const versions = await request("listRemoteBackups", {
              notebookId: book.id,
              targetId: target.id,
            });
            assert.equal(versions.length, 2);
            assert.equal((await backups())[0].pendingGeneration, null);
          },
        );
      }
    }
    if (args.includes("--cold-recovery")) {
      const newDevice = join(root, "new-device");
      let connection;
      const settingsPage = async () => {
        await page.getByRole("button", { name: "设置", exact: true }).click();
        await page
          .getByRole("heading", { name: "从云端恢复", exact: true })
          .waitFor();
      };
      const versionRow = () =>
        page
          .locator(".cloud-recovery .setting-row")
          .filter({ hasText: secondVersion.id });
      const findVersion = async () => {
        await page.waitForFunction(
          () =>
            !Array.from(
              document.querySelectorAll(".cloud-recovery button"),
            ).some((b) => b.disabled),
          {},
          { timeout: 180000 },
        );
        for (let i = 0; i < 100; i++) {
          if (await versionRow().count()) return;
          const more = page.getByRole("button", {
            name: "继续加载版本",
            exact: true,
          });
          if (await more.isVisible()) {
            await more.click();
            await page.waitForFunction(
              () =>
                !Array.from(
                  document.querySelectorAll(".cloud-recovery button"),
                ).some((b) => b.disabled),
              {},
              { timeout: 180000 },
            );
          } else {
            await versionRow().waitFor({ timeout: 180000 });
            return;
          }
        }
        throw Error("未找到验收版本");
      };
      await check(
        "fresh-device-UI-connection-discovery-and-system-encryption",
        async () => {
          await app.close();
          await launch(newDevice);
          assert.ok(
            !(await request("listNotebooks")).some((b) => b.id === book.id),
          );
          assert.ok(
            !existsSync(
              join(newDevice, "notebooks/_local/backup-targets.json"),
            ),
          );
          await settingsPage();
          const form = page.getByRole("form", { name: "云恢复连接" });
          await form
            .getByLabel("存储类型", { exact: true })
            .selectOption(provider);
          await form
            .getByLabel("Endpoint", { exact: true })
            .fill(config.endpoint);
          if (provider === "cloudflare")
            await form
              .getByLabel("应用 Token", { exact: true })
              .fill(config.token);
          else {
            await form
              .getByLabel("Bucket", { exact: true })
              .fill(config.bucket);
            await form
              .getByLabel("Region", { exact: true })
              .fill(config.region);
            await form
              .getByLabel("Prefix", { exact: true })
              .fill(report.prefix);
            await form
              .getByLabel("寻址方式", { exact: true })
              .selectOption(config.pathStyle ? "path" : "virtual");
            await form
              .getByLabel("Access Key ID", { exact: true })
              .fill(config.accessKeyId);
            await form
              .getByLabel("Secret Access Key", { exact: true })
              .fill(config.secretAccessKey);
            if (config.sessionToken)
              await form
                .getByLabel("Session Token（可选）", { exact: true })
                .fill(config.sessionToken);
          }
          await form
            .getByRole("button", { name: "保存连接并查询", exact: true })
            .click();
          await findVersion();
          mkdirSync(resolve("docs/screenshots"), { recursive: true });
          await page.locator(".cloud-recovery").screenshot({
            path: resolve(
              "docs/screenshots/cloud-recovery-" + provider + ".png",
            ),
          });
          connection = (await request("listCloudRecoveryConnections"))[0];
          assert.equal(connection.credentialsMode, "system-encrypted");
          const encrypted = readFileSync(
            join(newDevice, "secrets", connection.id + ".bin"),
          );
          for (const value of privateValues)
            assert.ok(!encrypted.includes(Buffer.from(value)));
          const saved = readFileSync(
            join(newDevice, "notebooks/_local/recovery-connections.json"),
            "utf8",
          );
          for (const value of privateValues) assert.ok(!saved.includes(value));
          report.coldConnectionId = connection.id;
        },
      );
      await check(
        "fresh-device-restart-discovers-and-restores-through-UI",
        async () => {
          await app.close();
          await launch(newDevice);
          await settingsPage();
          assert.equal(
            (await request("listCloudRecoveryConnections"))[0].id,
            connection.id,
          );
          await page
            .getByRole("button", { name: "查询云端版本", exact: true })
            .click();
          await findVersion();
          const previous = (await request("listTasks")).map((j) => j.id);
          await versionRow()
            .getByRole("button", { name: "恢复此版本", exact: true })
            .click();
          const job = await waitTask("restore", previous);
          await verifyRestore(job.restoredId, changedBody, false);
          assert.deepEqual(
            await request("listBackupTargets", { notebookId: job.restoredId }),
            [],
          );
          await page
            .getByRole("button", { name: "打开恢复的 Notebook", exact: true })
            .click();
          assert.ok(
            (await request("listNotebooks")).some(
              (b) => b.id === job.restoredId,
            ),
          );
          report.coldRestoredNotebookId = job.restoredId;
        },
      );
    }
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = { name: error.name, message: error.message };
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    save();
    await app?.close();
    if (daemon && daemon.exitCode === null) {
      const stopped = once(daemon, "close");
      daemon.kill("SIGTERM");
      await stopped;
    }
    rmSync(root, { recursive: true, force: true });
    console.log(
      "Desktop " +
        provider +
        " acceptance: " +
        report.status +
        ". Report: " +
        reportPath,
    );
  }
}
