import { chromium } from "playwright";
import { expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

// UI fixtures exercise renderer behavior; real OAuth and vendor services remain G01 acceptance.
const browser = await chromium.launch({
  ...(process.env.ANYNOTE_BROWSER
    ? { executablePath: process.env.ANYNOTE_BROWSER }
    : {}),
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
});
const page = await context.newPage();
const output = process.env.ANYNOTE_SCREENSHOTS || "/tmp/anynote-cloud-accounts";
mkdirSync(output, { recursive: true });
const errors = [],
  calls = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(() => {
  const connection = new EventTarget();
  connection.saveData = false;
  connection.type = "wifi";
  Object.defineProperty(navigator, "connection", {
    configurable: true,
    value: connection,
  });
});
const accounts = ["甲", "乙"].map((name, index) => ({
  id: `account-${index}`,
  ref: {
    providerId: "google-drive",
    accountId: `user-${index}`,
    displayName: `账号${name}`,
    oauthClientId: "old-app",
  },
  createdAt: 1,
}));
const policy = {
  policy: {
    backoff: {
      baseSeconds: 30,
      maxSeconds: 3600,
      maxAttempts: 8,
      jitterRatio: 0.5,
    },
    pause: { onBattery: false, onMeteredNetwork: false, largeTaskBytes: 0 },
  },
  environment: {},
};
const target = {
  id: "target",
  notebookId: "garden",
  providerId: "google-drive",
  accountRefId: accounts[0].id,
  deviceSlotId: "old-slot",
  autoBackup: true,
  lastSuccess: Date.now(),
};
const settings = ["google-drive", "dropbox", "onedrive"].map((id, index) => ({
  providerId: id,
  title: ["Google Drive", "Dropbox", "OneDrive"][index],
  customClientId: "",
  configured: false,
  source: "none",
  stage: "production",
}));
const targetView = () => ({
  target,
  account: accounts.find((a) => a.id === target.accountRefId),
  provider: {
    id: "google-drive",
    title: "Google Drive",
    beta: false,
    installed: true,
  },
  capabilities: { providerChecksum: ["md5"] },
  state:
    policy.environment.online === false ||
    (policy.environment.metered && policy.policy.pause.onMeteredNetwork)
      ? "waiting-network"
      : "completed",
  waitingReason:
    policy.environment.online === false
      ? "offline"
      : policy.environment.metered && policy.policy.pause.onMeteredNetwork
        ? "metered"
        : undefined,
});
let authorization = "error",
  releaseAuthorization,
  cancellations = 0,
  starts = 0,
  folderOpens = 0;
await page.route("**/api/rpc", async (route) => {
  const { op, input } = route.request().postDataJSON();
  calls.push(op);
  let result = op.startsWith("list") || op === "getBacklinks" ? [] : null;
  if (op === "listNotebooks") result = [{ id: "garden", name: "云盘账号测试" }];
  if (op === "getBackupPolicy") result = policy;
  if (op === "setBackupPolicy") {
    Object.assign(policy.policy.pause, input.pause);
    result = policy.policy;
  }
  if (op === "reportBackupEnvironment") {
    Object.assign(policy.environment, input);
    result = policy.environment;
  }
  if (op === "listCloudTargets") result = [targetView()];
  if (op === "listCloudAccounts") result = accounts;
  if (op === "getCloudSettings") result = settings;
  if (op === "setCloudClientId") {
    const app = settings.find((s) => s.providerId === input.providerId);
    app.customClientId = input.clientId.trim();
    app.configured = !!app.customClientId;
    app.source = app.configured ? "explicit" : "none";
    result = settings;
  }
  if (op === "listCloudProviders")
    result = settings.map((s) => ({
      id: s.providerId,
      title: s.title,
      beta: false,
      installed: true,
      oauthConfigured: s.configured,
      scopes: ["openid"],
      capabilities: { appScopedStorage: false },
    }));
  if (op === "configureCloudTarget") {
    expect(input.targetId).toBe("target");
    target.accountRefId = input.accountRefId;
    target.deviceSlotId = "new-slot";
    target.autoBackup = false;
    result = target;
  }
  if (op === "beginCloudAuthorization") {
    expect(input.accountRefId).toBe(target.accountRefId);
    result = {
      sessionId: "auth",
      authorizationUrl: "https://example.invalid/auth",
      opened: true,
    };
  }
  if (op === "completeCloudAuthorization") {
    if (authorization === "pending")
      await new Promise((resolve) => {
        releaseAuthorization = resolve;
      });
    if (authorization !== "success")
      return route.fulfill({
        json: { error: "登录的账号与原账号不同，请使用原账号重新登录。" },
      });
    result = accounts.find((a) => a.id === target.accountRefId);
  }
  if (op === "cancelCloudAuthorization") {
    cancellations++;
    releaseAuthorization?.();
    result = true;
  }
  if (op === "setCloudSchedule") {
    target.autoBackup = input.enabled;
    result = target;
  }
  if (op === "startCloudBackup") {
    starts++;
    result = { id: "job" };
  }
  if (op === "openCloudFolder") {
    folderOpens++;
    result = {
      url: "https://drive.google.com/drive/folders/test",
      opened: true,
    };
  }
  await route.fulfill({ json: { result } });
});
try {
  await page.goto(process.env.ANYNOTE_URL || "http://127.0.0.1:5173");
  await page
    .getByRole("button", { name: "打开 Notebook：云盘账号测试", exact: true })
    .click();
  await page.getByTitle("查看备份", { exact: true }).click();
  await page
    .getByRole("button", { name: "高级设置 · Client ID", exact: true })
    .click();
  const settingsDialog = page.getByRole("dialog", { name: "云盘高级设置" });
  await expect(settingsDialog).toContainText(
    "既有备份目录不会自动对新应用可见",
  );
  await settingsDialog
    .getByLabel("Google Drive · Client ID / App Key")
    .fill("new-app");
  await settingsDialog
    .getByRole("button", { name: "保存 Google Drive" })
    .click();
  await expect(settingsDialog.getByRole("status")).toContainText("已保存");
  await page.screenshot({ path: `${output}/settings.png` });
  await settingsDialog
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page
    .getByRole("button", { name: "高级设置 · Client ID", exact: true })
    .click();
  await expect(
    settingsDialog.getByLabel("Google Drive · Client ID / App Key"),
  ).toHaveValue("new-app");
  await settingsDialog
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  const card = page
    .locator(".backup-target")
    .filter({ hasText: "Google Drive" });
  await card.getByRole("button", { name: "切换账号", exact: true }).click();
  const switching = page.getByRole("dialog", { name: "切换云盘账号" });
  await switching
    .locator(".snapshot-row")
    .filter({ hasText: "账号乙" })
    .getByRole("button", { name: "使用此账号" })
    .click();
  await expect(
    switching.getByRole("button", { name: "保存并完成" }),
  ).toBeDisabled();
  await switching.getByLabel(/我确认切换身份/).check();
  await switching.getByRole("button", { name: "保存并完成" }).click();
  await expect(card).toContainText("账号乙");
  expect(target.deviceSlotId).toBe("new-slot");
  expect(accounts).toHaveLength(2);
  await card.getByRole("button", { name: "重新登录", exact: true }).click();
  const login = page.getByRole("dialog", { name: "重新登录云盘账号" });
  await login.getByRole("button", { name: "打开浏览器授权" }).click();
  await expect(login.getByRole("alert")).toContainText("原账号不同");
  authorization = "pending";
  await login.getByRole("button", { name: "打开浏览器授权" }).click();
  await expect(login.getByRole("button", { name: "取消授权" })).toBeEnabled();
  await login.getByRole("button", { name: "取消授权" }).click();
  await expect.poll(() => cancellations).toBe(1);
  authorization = "success";
  await login.getByRole("button", { name: "打开浏览器授权" }).click();
  await expect(login).toBeHidden();
  expect(target.deviceSlotId).toBe("new-slot");
  await card.getByRole("button", { name: "打开云盘目录" }).click();
  expect(folderOpens).toBe(1);
  await card.getByLabel(/自动备份 · 至少每/).click();
  await expect(card.getByLabel(/自动备份 · 至少每/)).toBeChecked();
  await page
    .getByLabel("计量 / 省流量网络暂停自动备份（本设备所有备份目标）")
    .click();
  await expect(
    page.getByLabel("计量 / 省流量网络暂停自动备份（本设备所有备份目标）"),
  ).toBeChecked();
  await expect(
    page.getByLabel("计量网络时暂停自动备份", { exact: true }),
  ).toBeChecked();
  await page.locator("summary").filter({ hasText: "自动备份暂停策略" }).click();
  await page.getByLabel("计量网络时暂停自动备份", { exact: true }).click();
  await expect(
    page.getByLabel("计量 / 省流量网络暂停自动备份（本设备所有备份目标）"),
  ).not.toBeChecked();
  await page.getByLabel("计量网络时暂停自动备份", { exact: true }).click();
  await expect(
    page.getByLabel("计量 / 省流量网络暂停自动备份（本设备所有备份目标）"),
  ).toBeChecked();
  await page.locator("summary").filter({ hasText: "自动备份暂停策略" }).click();
  await page.evaluate(() => {
    navigator.connection.saveData = true;
    navigator.connection.dispatchEvent(new Event("change"));
  });
  await expect(card).toContainText("等待网络");
  await card.getByRole("button", { name: "立即备份", exact: true }).click();
  expect(starts).toBe(1);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await context.setOffline(true);
  await expect(
    card.getByRole("button", { name: "立即备份", exact: true }),
  ).toBeDisabled();
  await expect(card).toContainText("请连接网络");
  await page.screenshot({ path: `${output}/offline.png` });
  await context.setOffline(false);
  await page.evaluate(() => {
    navigator.connection.saveData = false;
    navigator.connection.dispatchEvent(new Event("change"));
  });
  await expect(card).not.toContainText("等待网络");
  await expect(
    card.getByRole("button", { name: "立即备份", exact: true }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 720, height: 1000 });
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${output}/narrow.png` });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  writeFileSync(
    `${output}/report.json`,
    JSON.stringify(
      {
        checks: [
          "settings persistence",
          "identity switch",
          "wrong account rejected",
          "cancel while waiting",
          "relogin same target",
          "folder",
          "metered manual override",
          "offline and recovery",
          "narrow layout",
        ],
        errors,
        calls: calls.length,
      },
      null,
      2,
    ),
  );
  console.log(`Cloud accounts UI smoke passed; screenshots: ${output}`);
} finally {
  await browser.close();
}
