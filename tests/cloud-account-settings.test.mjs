import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { cloudBackupOperation } from "../.build/packages/backup-core/operations.js";
import {
  createBackupHostContext,
  setCloudOpenExternal,
} from "../.build/packages/backup-core/host.js";
import {
  cloudBroker,
  disposeCloudBroker,
} from "../.build/packages/backup-core/broker.js";
import {
  upsertAccount,
  upsertTarget,
  findTarget,
  findAccount,
} from "../.build/packages/backup-core/state.js";
import {
  clearCloudProviders,
  registerCloudProvider,
} from "../.build/packages/backup-core/registry.js";
import { startCloudBackupScheduler } from "../.build/packages/backup-core/scheduler.js";
import { policyOperation } from "../.build/packages/backup/policy.js";
import { createPlaceholderProvider } from "../.build/packages/cloud-backup-common/index.js";

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "anynote-cloud-accounts-"));
  const s = new Storage(root);
  const book = await s.run("createNotebook", { title: "G13" });
  const account = {
    id: randomUUID(),
    ref: {
      providerId: "google-drive",
      oauthClientId: "app-a",
      accountId: "user-a",
    },
    createdAt: Date.now(),
  };
  const target = {
    id: randomUUID(),
    notebookId: book.id,
    accountRefId: account.id,
    providerId: "google-drive",
    deviceSlotId: randomUUID(),
    rootRef: "old-root",
    notebookRef: "old-folder",
    lastSuccess: 42,
    lastHeadCommitId: randomUUID(),
    lastDatabaseSha256: "old-hash",
    autoBackup: true,
    lastTaskBytes: 100,
  };
  upsertAccount(s, account);
  upsertTarget(s, target);
  clearCloudProviders();
  const provider = {
    ...createPlaceholderProvider("google-drive"),
    id: "google-drive",
    capabilities: {
      resumableUpload: false,
      conditionalHead: false,
      providerChecksum: [],
      appScopedStorage: false,
      quotaAvailable: false,
    },
    accountDescriptor: { scopes: [] },
    ensureTarget: vi.fn(async (input, ctx) => ({
      rootRef: `${ctx.accounts.current().accountId}-root`,
      notebookRef: `${ctx.accounts.current().accountId}-folder`,
    })),
    folderLink: async () => ({
      url: "https://drive.google.com/drive/folders/test",
    }),
  };
  registerCloudProvider({ provider, title: "Google Drive" });
  t.onTestFinished(async () => {
    await Promise.allSettled([...s.jobs.values()].map((j) => j.promise));
    disposeCloudBroker();
    clearCloudProviders();
    setCloudOpenExternal(undefined);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    s,
    book,
    account,
    target,
    provider,
    call: async (op, input = {}) =>
      (await cloudBackupOperation(s, op, input)).result,
  };
}

test("custom application settings persist, resolve precedence and leave existing identities intact", async (t) => {
  const f = await fixture(t);
  vi.stubEnv("ANYNOTE_GOOGLE_CLIENT_ID", "environment-app");
  await f.call("setCloudClientId", {
    providerId: "google-drive",
    clientId: " custom-app ",
  });
  const setting = (await f.call("getCloudSettings"))[0];
  assert.equal(setting.customClientId, "custom-app");
  assert.equal(setting.source, "explicit");
  const begun = await f.call("beginCloudAuthorization", {
    providerId: "google-drive",
  });
  assert.equal(
    new URL(begun.authorizationUrl).searchParams.get("client_id"),
    "custom-app",
  );
  await f.call("cancelCloudAuthorization", { sessionId: begun.sessionId });
  assert.equal(findAccount(f.s, f.account.id).ref.oauthClientId, "app-a");
  assert.equal(findTarget(f.s, f.book.id, f.target.id).rootRef, "old-root");
  assert.ok(
    readFileSync(
      join(f.s.root, "_local/cloud-backup-provider-state.json"),
      "utf8",
    ).includes("oauth.client.id"),
  );
  await f.call("setCloudClientId", {
    providerId: "google-drive",
    clientId: "",
  });
  assert.equal((await f.call("getCloudSettings"))[0].source, "environment");
  await assert.rejects(
    f.call("setCloudClientId", {
      providerId: "google-drive",
      clientId: "x".repeat(513),
    }),
  );
});

test("switch identity creates a fresh slot without old cursors; same identity keeps its slot", async (t) => {
  const f = await fixture(t);
  const same = await f.call("configureCloudTarget", {
    notebookId: f.book.id,
    targetId: f.target.id,
    providerId: "google-drive",
    accountRefId: f.account.id,
  });
  assert.equal(same.deviceSlotId, f.target.deviceSlotId);
  assert.equal(same.lastSuccess, 42);
  const another = {
    ...f.account,
    id: randomUUID(),
    ref: { ...f.account.ref, oauthClientId: "app-b" },
  };
  upsertAccount(f.s, another);
  const switched = await f.call("configureCloudTarget", {
    notebookId: f.book.id,
    targetId: f.target.id,
    providerId: "google-drive",
    accountRefId: another.id,
  });
  assert.notEqual(switched.deviceSlotId, f.target.deviceSlotId);
  for (const key of [
    "lastSuccess",
    "lastHeadCommitId",
    "lastDatabaseSha256",
    "autoBackup",
  ])
    assert.equal(switched[key], undefined);
  assert.deepEqual(f.provider.ensureTarget.mock.calls[1][0].existing, {
    rootRef: undefined,
    notebookRef: undefined,
  });
  assert.equal(findAccount(f.s, f.account.id).ref.oauthClientId, "app-a");
});

test("provider mismatch, missing targets, busy accounts and concurrent changes cannot rebind a target", async (t) => {
  const f = await fixture(t);
  const other = {
    ...f.account,
    id: randomUUID(),
    ref: { ...f.account.ref, providerId: "dropbox" },
  };
  upsertAccount(f.s, other);
  for (const op of ["configureCloudTarget", "probeCloudTarget"]) {
    await assert.rejects(
      f.call(op, {
        ...(op === "configureCloudTarget" ? { notebookId: f.book.id } : {}),
        providerId: "google-drive",
        accountRefId: other.id,
      }),
      /不匹配/,
    );
  }
  await assert.rejects(
    f.call("configureCloudTarget", {
      notebookId: f.book.id,
      targetId: randomUUID(),
      providerId: "google-drive",
      accountRefId: f.account.id,
    }),
    /不存在/,
  );
  f.s.jobs.set("busy", {
    id: "busy",
    targetId: f.target.id,
    status: "committing",
  });
  await assert.rejects(
    f.call("disconnectCloudAccount", { accountRefId: f.account.id }),
    /任务运行/,
  );
  await assert.rejects(
    f.call("configureCloudTarget", {
      notebookId: f.book.id,
      targetId: f.target.id,
      providerId: "google-drive",
      accountRefId: f.account.id,
    }),
    /任务运行/,
  );
  f.s.jobs.clear();
  f.provider.ensureTarget.mockImplementationOnce(async () => {
    upsertTarget(f.s, { ...f.target, deviceSlotId: randomUUID() });
    return { rootRef: "unsafe" };
  });
  await assert.rejects(
    f.call("configureCloudTarget", {
      notebookId: f.book.id,
      targetId: f.target.id,
      providerId: "google-drive",
      accountRefId: f.account.id,
    }),
    /其他操作修改/,
  );
  assert.notEqual(findTarget(f.s, f.book.id, f.target.id).rootRef, "unsafe");
});

test("account-scoped provider caches cannot expose another account's folder or upload session", async (t) => {
  const f = await fixture(t);
  const context = (account) =>
    createBackupHostContext({
      s: f.s,
      broker: cloudBroker(f.s),
      account,
      providerId: "google-drive",
      notebookId: f.book.id,
      signal: new AbortController().signal,
      tempDir: f.s.root,
    });
  const first = context(f.account),
    second = context({ ...f.account, id: randomUUID() });
  await first.state.set("drive.root.id", "private-folder");
  assert.equal(await second.state.get("drive.root.id"), null);
  assert.equal(
    await context(f.account).state.get("drive.root.id"),
    "private-folder",
  );
});

test("relogin after disconnect rejects wrong account and repairs the original target without re-adding", async (t) => {
  const f = await fixture(t);
  const realFetch = globalThis.fetch;
  let user = "user-b",
    client = "app-a",
    opened;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).includes("oauth2.googleapis.com/token"))
      return new Response(
        JSON.stringify({
          access_token: "fresh",
          refresh_token: "refresh",
          id_token: `x.${Buffer.from(JSON.stringify({ sub: user })).toString("base64url")}.y`,
          expires_in: 3600,
        }),
      );
    return realFetch(url, init);
  });
  setCloudOpenExternal(async (url) => {
    opened = new URL(url);
  });
  await cloudBroker(f.s).tokens.save(f.account.id, { token: "old" });
  await f.call("disconnectCloudAccount", { accountRefId: f.account.id });
  assert.ok(findAccount(f.s, f.account.id).reauthReason);
  assert.equal(
    (await f.call("listCloudTargets", { notebookId: f.book.id }))[0].state,
    "reauth-required",
  );
  const login = async (reconnect = true) => {
    const begun = await f.call("beginCloudAuthorization", {
      providerId: "google-drive",
      ...(reconnect ? { accountRefId: f.account.id } : {}),
    });
    assert.equal(opened.searchParams.get("client_id"), client);
    const callback = new URL(opened.searchParams.get("redirect_uri"));
    callback.searchParams.set("state", opened.searchParams.get("state"));
    callback.searchParams.set("code", "test");
    await realFetch(callback);
    return f.call("completeCloudAuthorization", { sessionId: begun.sessionId });
  };
  await assert.rejects(login(), /原账号不同/);
  await assert.rejects(cloudBroker(f.s).tokens.load(f.account.id), /重新登录/);
  user = "user-a";
  upsertTarget(f.s, { ...f.target, pausedReason: "auth", failureCount: 2 });
  const repaired = await login();
  assert.equal(repaired.id, f.account.id);
  assert.equal(repaired.reauthReason, null);
  const target = findTarget(f.s, f.book.id, f.target.id);
  assert.equal(target.deviceSlotId, f.target.deviceSlotId);
  assert.equal(target.pausedReason, null);
  assert.equal(target.lastSuccess, 42);
  assert.equal((await f.call("listCloudAccounts")).length, 1);
  await f.call("setCloudClientId", {
    providerId: "google-drive",
    clientId: "app-a",
  });
  assert.equal((await login(false)).id, f.account.id);
  assert.equal((await f.call("listCloudAccounts")).length, 1);
  client = "app-b";
  await f.call("setCloudClientId", {
    providerId: "google-drive",
    clientId: client,
  });
  assert.notEqual((await login(false)).id, f.account.id);
  assert.equal((await f.call("listCloudAccounts")).length, 2);
  assert.equal(
    findTarget(f.s, f.book.id, f.target.id).accountRefId,
    f.account.id,
  );
});

test("offline and metered policies wait without failed jobs, resume automatically and allow a manual metered run", async (t) => {
  const f = await fixture(t);
  const report = (input) =>
    policyOperation(f.s, "reportBackupEnvironment", input);
  policyOperation(f.s, "setBackupPolicy", {
    pause: { onMeteredNetwork: true, onBattery: true },
  });
  const started = [];
  vi.spyOn(f.s, "run").mockImplementation(async (op, input) => {
    started.push({ op, input });
  });
  const scheduler = startCloudBackupScheduler(f.s);
  t.onTestFinished(() => scheduler.dispose());
  report({ online: false });
  await scheduler.tick();
  assert.equal(started.length, 0);
  assert.equal(
    (await f.call("listCloudTargets", { notebookId: f.book.id }))[0].state,
    "waiting-network",
  );
  await assert.rejects(
    f.call("startCloudBackup", {
      notebookId: f.book.id,
      targetId: f.target.id,
    }),
    /离线/,
  );
  assert.equal(f.s.jobs.size, 0);
  assert.equal(findTarget(f.s, f.book.id, f.target.id).lastAttempt, undefined);
  report({ online: true, metered: true });
  await scheduler.tick();
  assert.equal(started.length, 0);
  f.provider.ensureTarget.mockRejectedValueOnce(Error("manual test"));
  const manual = await f.call("startCloudBackup", {
    notebookId: f.book.id,
    targetId: f.target.id,
  });
  await f.s.jobs.get(manual.id).promise;
  assert.equal(f.s.jobs.size, 1);
  upsertTarget(f.s, f.target);
  report({ metered: false, onBattery: false });
  await scheduler.tick();
  assert.equal(started.length, 1);
  report({ onBattery: true });
  await scheduler.tick();
  assert.equal(started.length, 1);
  assert.equal(
    (await f.call("listCloudTargets", { notebookId: f.book.id }))[0].state,
    "paused",
  );
  upsertTarget(f.s, { ...f.target, pausedReason: "auth" });
  report({ onBattery: false });
  await scheduler.tick();
  assert.equal(started.length, 1);
});

test("environment observation is ephemeral and performs no disk writes during repeated reports", async (t) => {
  const f = await fixture(t);
  policyOperation(f.s, "setBackupPolicy", {
    pause: { onMeteredNetwork: true },
  });
  const file = join(f.s.root, "_local/backup-policy.json"),
    before = statSync(file).mtimeMs;
  for (let i = 0; i < 1000; i++)
    policyOperation(f.s, "reportBackupEnvironment", {
      online: i % 2 === 0,
      metered: true,
    });
  assert.equal(statSync(file).mtimeMs, before);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).environment, {});
  assert.equal(
    policyOperation(f.s, "getBackupPolicy", {}).result.environment.metered,
    true,
  );
});

test("folder opening uses the provider URL and the host launcher", async (t) => {
  const f = await fixture(t);
  let url;
  setCloudOpenExternal(async (value) => {
    url = value;
  });
  const result = await f.call("openCloudFolder", {
    notebookId: f.book.id,
    targetId: f.target.id,
  });
  assert.equal(result.opened, true);
  assert.equal(result.url, url);
  f.provider.folderLink = async () => ({ url: "file:///tmp/private" });
  await assert.rejects(
    f.call("openCloudFolder", { notebookId: f.book.id, targetId: f.target.id }),
    /HTTPS/,
  );
});

test("network loss during a backup does not exhaust retries or delay recovery by a full interval", async (t) => {
  const f = await fixture(t);
  f.provider.ensureTarget.mockImplementationOnce(async () => {
    policyOperation(f.s, "reportBackupEnvironment", { online: false });
    throw Error("fetch failed");
  });
  const job = await f.call("startCloudBackup", {
    notebookId: f.book.id,
    targetId: f.target.id,
  });
  await f.s.jobs.get(job.id).promise;
  const current = findTarget(f.s, f.book.id, f.target.id);
  assert.equal(current.failureCount, undefined);
  assert.equal(current.nextAttemptAt, undefined);
  assert.equal(current.lastAttempt, undefined);
  assert.equal(
    (await f.call("listCloudTargets", { notebookId: f.book.id }))[0].state,
    "waiting-network",
  );
});

test("one account cannot acquire two targets for the same Notebook", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.call("configureCloudTarget", {
      notebookId: f.book.id,
      providerId: "google-drive",
      accountRefId: f.account.id,
    }),
    /已为此 Notebook 配置目标/,
  );
  assert.equal(f.provider.ensureTarget.mock.calls.length, 0);
});
