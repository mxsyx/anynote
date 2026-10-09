import { test } from "vitest";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  assertContentVerification,
  assertManifestIntegrity,
  assertPlanBudget,
  buildUploadPlan,
  createPlaceholderProvider,
  isCleanupEmpty,
  meetsVerification,
  parseHead,
  parseRootMarker,
  planCleanup,
  publishHead,
  resolveVerificationLevel,
  runFileLevelBackup,
  safeRelativePath,
} from "../.build/packages/cloud-backup-common/index.js";
import {
  CloudAuthError,
  TokenBroker,
  accountIdFrom,
  createCodeChallenge,
  createPkce,
  refreshAccessToken,
  safeEqual,
  startLoopbackListener,
  toCredentials,
} from "../.build/packages/oauth-broker/index.js";

const sha = (value) => createHash("sha256").update(value).digest("hex");

/** 构造一份最小可用的清单。 */
function manifestFor({
  notebookId = randomUUID(),
  deviceSlotId = randomUUID(),
  commitId = randomUUID(),
  databaseSha = sha("db"),
  databaseSize = 10,
  assets = [],
  assetRef = () => ({
    sha256: sha("asset"),
    size: 5,
    locator: { kind: "test", ref: "asset-1" },
  }),
} = {}) {
  return {
    format: "anynote.cloud-backup-manifest",
    formatVersion: 1,
    notebookId,
    deviceSlotId,
    commitId,
    createdAt: new Date().toISOString(),
    schemaVersion: 2,
    contentSeq: 7,
    database: {
      sha256: databaseSha,
      size: databaseSize,
      locator: { kind: "test", ref: "db-1" },
      schemaVersion: 2,
      contentSeq: 7,
    },
    assets: assets.map((path, index) => ({
      ...assetRef(index),
      path,
    })),
  };
}

test("PKCE 使用 S256 且 state 常量时间比较", () => {
  const pkce = createPkce();
  assert.equal(pkce.method, "S256");
  assert.ok(pkce.verifier.length >= 43 && pkce.verifier.length <= 128);
  assert.equal(
    pkce.challenge,
    createHash("sha256").update(pkce.verifier).digest("base64url"),
  );
  assert.equal(createCodeChallenge(pkce.verifier), pkce.challenge);
  assert.equal(safeEqual("state", "state"), true);
  assert.equal(safeEqual("state", "statf"), false);
  assert.equal(safeEqual("state", "state-longer"), false);
});

test("回环回调监听校验 state 与路径，并在授权后关闭", async () => {
  const listener = await startLoopbackListener({ expectedState: "s-1" });
  assert.match(listener.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  // 路径不符：不应结算会话。
  const wrongPath = await fetch(new URL("other", listener.redirectUri));
  assert.equal(wrongPath.status, 404);
  // state 不符：明确拒绝，而不是静默接受错误回调。
  const waiting = listener.wait();
  const rejected = assert.rejects(waiting, /state 校验失败/);
  await fetch(listener.redirectUri + "?code=c&state=wrong");
  await rejected;
  listener.close();
});

test("回环回调返回授权码与 state", async () => {
  const listener = await startLoopbackListener({ expectedState: "s-2" });
  const waiting = listener.wait();
  await fetch(listener.redirectUri + "?code=abc&state=s-2");
  const params = await waiting;
  assert.equal(params.code, "abc");
  assert.equal(params.state, "s-2");
});

test("refresh token 轮换缺失时保留原值，invalid_grant 转为需要重新登录", async () => {
  const descriptor = {
    providerId: "google-drive",
    authorizationEndpoint: "https://example.test/auth",
    tokenEndpoint: "https://example.test/token",
    scopes: ["scope"],
    pkce: true,
    redirect: "loopback",
    refreshTokenRotation: false,
  };
  const refreshResponse = {
    access_token: "new-token",
    expires_in: 3600,
    token_type: "Bearer",
  };
  const response = await refreshAccessToken({
    descriptor,
    clientId: "client",
    refreshToken: "old-refresh",
    fetchImpl: async () =>
      new Response(JSON.stringify(refreshResponse), { status: 200 }),
  });
  const credentials = toCredentials(response, { refreshToken: "old-refresh" });
  // 响应未包含 refresh token 时必须保留原值，否则后台备份会失去授权。
  assert.equal(credentials.refreshToken, "old-refresh");
  assert.equal(credentials.token, "new-token");

  await assert.rejects(
    refreshAccessToken({
      descriptor,
      clientId: "client",
      refreshToken: "revoked",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "撤销" }),
          { status: 400 },
        ),
    }),
    (error) => error instanceof CloudAuthError && error.reauthRequired,
  );
});

test("同一账号并发刷新是 single-flight", async () => {
  let calls = 0;
  const vault = new Map([
    ["acct", { token: "expired", refreshToken: "r", expiresAt: 0 }],
  ]);
  const broker = new TokenBroker({
    vault: {
      async set(id, value) {
        vault.set(id, value);
      },
      async get(id) {
        return vault.get(id);
      },
    },
    now: () => 1_000,
    fetchImpl: async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ access_token: "fresh", expires_in: 3600 }),
        { status: 200 },
      );
    },
  });
  const descriptor = {
    providerId: "dropbox",
    authorizationEndpoint: "https://example.test/auth",
    tokenEndpoint: "https://example.test/token",
    scopes: [],
    pkce: true,
    redirect: "loopback",
    refreshTokenRotation: false,
  };
  const tokens = await Promise.all([
    broker.accessToken("acct", descriptor, "client"),
    broker.accessToken("acct", descriptor, "client"),
    broker.accessToken("acct", descriptor, "client"),
  ]);
  assert.deepEqual(tokens, ["fresh", "fresh", "fresh"]);
  assert.equal(calls, 1);
  assert.equal(vault.get("acct").token, "fresh");
});

test("账号标识从 id_token 或响应字段读取", () => {
  const payload = Buffer.from(
    JSON.stringify({ sub: "sub-1", email: "a@b.c" }),
  ).toString("base64url");
  assert.equal(
    accountIdFrom(
      { id_token: `x.${payload}.y` },
      { accountIdClaim: "id_token:sub" },
    ),
    "sub-1",
  );
  assert.equal(
    accountIdFrom(
      { id_token: `x.${payload}.y` },
      { accountIdClaim: "id_token:email" },
    ),
    "a@b.c",
  );
  assert.equal(
    accountIdFrom(
      { account_id: "acc-9" },
      { accountIdClaim: "response:account_id" },
    ),
    "acc-9",
  );
});

test("差异计划：无变化跳过上传，新增附件只上传新对象", async () => {
  const assetA = sha("a"),
    previous = manifestFor({
      assets: ["assets/sha256/aa/a.bin"],
      assetRef: () => ({
        sha256: assetA,
        size: 5,
        locator: { kind: "test", ref: "a" },
      }),
    });
  const unchanged = await buildUploadPlan({
    commitId: randomUUID(),
    databaseSha256: previous.database.sha256,
    databaseSize: previous.database.size,
    assets: [{ path: "assets/sha256/aa/a.bin", sha256: assetA, size: 5 }],
    previous,
  });
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.items.length, 0);

  const assetB = sha("b"),
    added = await buildUploadPlan({
      commitId: randomUUID(),
      databaseSha256: previous.database.sha256,
      databaseSize: previous.database.size,
      assets: [
        { path: "assets/sha256/aa/a.bin", sha256: assetA, size: 5 },
        { path: "assets/sha256/bb/b.bin", sha256: assetB, size: 9 },
      ],
      previous,
    });
  assert.equal(added.unchanged, false);
  assert.deepEqual(
    added.items.map((item) => [item.kind, item.sha256]),
    [["asset", assetB]],
  );

  // 远端对象已被删除时重新上传，而不是只凭本机旧游标。
  const repaired = await buildUploadPlan({
    commitId: randomUUID(),
    databaseSha256: previous.database.sha256,
    databaseSize: previous.database.size,
    assets: [{ path: "assets/sha256/aa/a.bin", sha256: assetA, size: 5 }],
    previous,
    exists: async () => false,
  });
  assert.equal(repaired.unchanged, false);
  assert.deepEqual(
    repaired.items.map((item) => item.kind),
    ["database", "asset"],
  );
});

test("空间不足时拒绝提交，而不是先清理旧副本", () => {
  assert.throws(
    () =>
      assertPlanBudget({
        commitId: randomUUID(),
        items: [{ kind: "database", sha256: sha("x"), size: 100 }],
        uploadBytes: 100,
        unchanged: false,
        requiredBytes: 200,
        availableBytes: 10,
      }),
    /空间不足/,
  );
});

test("清单完整性校验拒绝身份、哈希、数量与路径不符", () => {
  const notebookId = randomUUID(),
    deviceSlotId = randomUUID(),
    commitId = randomUUID(),
    manifest = manifestFor({
      notebookId,
      deviceSlotId,
      commitId,
      assets: ["assets/sha256/aa/a.bin"],
      assetRef: () => ({
        sha256: sha("a"),
        size: 5,
        locator: { kind: "t", ref: "a" },
      }),
    });
  const expected = {
    notebookId,
    deviceSlotId,
    commitId,
    databaseSha256: manifest.database.sha256,
    assets: [{ path: "assets/sha256/aa/a.bin", sha256: sha("a") }],
  };
  assert.equal(assertManifestIntegrity(manifest, expected).commitId, commitId);
  assert.throws(
    () =>
      assertManifestIntegrity(manifest, {
        ...expected,
        databaseSha256: sha("other"),
      }),
    /数据库哈希/,
  );
  assert.throws(
    () =>
      assertManifestIntegrity(manifest, {
        ...expected,
        assets: [{ path: "assets/sha256/aa/other.bin", sha256: sha("a") }],
      }),
    /资源/,
  );
  // 路径逃逸必须在 schema 层被拒绝。
  assert.throws(() =>
    assertManifestIntegrity(
      {
        ...manifest,
        assets: [{ ...manifest.assets[0], path: "../../etc/passwd" }],
      },
      expected,
    ),
  );
  assert.equal(safeRelativePath("../../etc/passwd"), undefined);
  assert.equal(safeRelativePath("/abs"), undefined);
  assert.equal(safeRelativePath("a/./b"), "a/b");
});

test("校验等级规则：数据库必须有内容校验，provider-checksum 取决于厂商能力", () => {
  assert.equal(meetsVerification("accepted-size", "provider-checksum"), false);
  assert.equal(meetsVerification("download-sha256", "provider-checksum"), true);
  assert.equal(
    resolveVerificationLevel({ providerChecksum: ["md5"] }, "md5-value"),
    "provider-checksum",
  );
  // 厂商不提供内容 checksum 时只能退化为上传后下载校验。
  assert.equal(
    resolveVerificationLevel({ providerChecksum: [] }, undefined),
    "accepted-size",
  );
  assert.throws(
    () =>
      assertContentVerification(
        {
          sha256: sha("x"),
          size: 1,
          locator: { kind: "t", ref: "1" },
          verification: "accepted-size",
        },
        "数据库",
      ),
    /尚未完成内容校验/,
  );
});

test("发布：响应丢失时读回确认，冲突与未确认都不更新成功状态", async () => {
  const head = {
    format: "anynote.cloud-backup-head",
    formatVersion: 1,
    notebookId: randomUUID(),
    deviceSlotId: randomUUID(),
    commitId: randomUUID(),
    manifestRef: "manifest-1",
    manifestSha256: sha("manifest"),
    completedAt: new Date().toISOString(),
  };
  // 响应丢失但远端其实已提交：读回确认后视为成功，不重复盲写。
  const lost = await publishHead({
    head,
    conditional: true,
    expectedVersionToken: "v1",
    write: async () => {
      throw Error("socket hang up");
    },
    read: async () => head,
    verification: "download-sha256",
  });
  assert.equal(lost.commitId, head.commitId);

  await assert.rejects(
    publishHead({
      head,
      conditional: true,
      expectedVersionToken: "v1",
      write: async () => ({ conflict: true }),
      read: async () => null,
      verification: "download-sha256",
    }),
    /已被其他写入者更新/,
  );
  await assert.rejects(
    publishHead({
      head,
      conditional: false,
      write: async () => ({}),
      read: async () => null,
      verification: "download-sha256",
    }),
    /读回确认失败/,
  );
});

test("受管 GC：指针未确认不清理，宽限期内不清理旧对象", () => {
  const locator = { kind: "test", ref: "old" };
  assert.throws(
    () =>
      planCleanup({
        currentHead: null,
        currentManifest: null,
        managed: [{ locator, kind: "asset" }],
      }),
    /禁止清理/,
  );
  const head = {
    format: "anynote.cloud-backup-head",
    formatVersion: 1,
    notebookId: randomUUID(),
    deviceSlotId: randomUUID(),
    commitId: randomUUID(),
    manifestRef: "current-manifest",
    manifestSha256: sha("m"),
    completedAt: new Date().toISOString(),
  };
  const manifest = manifestFor({ assets: ["assets/sha256/aa/a.bin"] });
  const now = Date.now();
  const keepAll = planCleanup({
    currentHead: head,
    currentManifest: manifest,
    managed: [
      { locator, kind: "asset", registeredAt: now - 1000 },
      // 当前清单引用的对象必须保留。
      { locator: manifest.database.locator, kind: "database", registeredAt: 0 },
    ],
    graceMs: 60_000,
    now,
  });
  assert.equal(isCleanupEmpty(keepAll), true);

  const aged = planCleanup({
    currentHead: head,
    currentManifest: manifest,
    managed: [{ locator, kind: "asset", registeredAt: now - 120_000 }],
    graceMs: 60_000,
    now,
  });
  assert.deepEqual(aged.objects, [locator]);
  // 进行中任务/恢复 pin 保护的对象不进入清理计划。
  const pinned = planCleanup({
    currentHead: head,
    currentManifest: manifest,
    managed: [{ locator, kind: "asset", registeredAt: 0 }],
    protectedLocators: [locator],
    graceMs: 0,
    now,
  });
  assert.equal(isCleanupEmpty(pinned), true);
});

test("head 与根标记 schema 拒绝未知字段与非法身份", () => {
  const head = {
    format: "anynote.cloud-backup-head",
    formatVersion: 1,
    notebookId: randomUUID(),
    deviceSlotId: randomUUID(),
    commitId: randomUUID(),
    manifestRef: "m",
    manifestSha256: sha("m"),
    completedAt: new Date().toISOString(),
  };
  assert.equal(parseHead(head).commitId, head.commitId);
  assert.throws(() => parseHead({ ...head, extra: 1 }));
  assert.throws(() => parseHead({ ...head, manifestSha256: "short" }));
  assert.throws(() =>
    parseRootMarker({
      format: "anynote.cloud-backup-root",
      formatVersion: 1,
      app: "other",
      createdAt: new Date().toISOString(),
    }),
  );
});

test("文件级流程：无变化跳过、发布失败不更新成功指针", async () => {
  const ctx = {
    tasks: {
      signal: new AbortController().signal,
      progress() {},
      log() {},
      concurrency: () => 2,
    },
  };
  const capture = {
    notebookId: randomUUID(),
    notebookName: "n",
    contentSeq: 3,
    schemaVersion: 2,
    database: {
      sha256: sha("db"),
      size: 4,
      read: async () => new Uint8Array(),
      stream: async function* () {},
    },
    assets: [],
    release: async () => {},
  };
  const previousHead = {
    format: "anynote.cloud-backup-head",
    formatVersion: 1,
    notebookId: capture.notebookId,
    deviceSlotId: randomUUID(),
    commitId: randomUUID(),
    manifestRef: "m-ref",
    manifestSha256: sha("m"),
    completedAt: new Date().toISOString(),
  };
  const previousManifest = manifestFor({
    notebookId: capture.notebookId,
    deviceSlotId: previousHead.deviceSlotId,
    commitId: previousHead.commitId,
    databaseSha: sha("db"),
    databaseSize: 4,
  });

  const noChangeProvider = {
    id: "test",
    protocolVersion: 1,
    async plan() {
      return {
        commitId: randomUUID(),
        items: [],
        uploadBytes: 0,
        unchanged: true,
        requiredBytes: 0,
      };
    },
    async reconcile() {
      return { committedCommitId: previousHead.commitId, head: previousHead };
    },
    async execute() {
      throw Error("无变化时不应执行上传");
    },
  };
  const skipped = await runFileLevelBackup({
    provider: noChangeProvider,
    ctx,
    target: { rootRef: "r", notebookRef: "n", deviceSlotRef: "d" },
    capture,
    deviceSlotId: previousHead.deviceSlotId,
    previous: previousManifest,
    previousHead,
  });
  assert.equal(skipped.unchanged, true);
  assert.equal(skipped.uploadedBytes, 0);

  /** 构造一个只在 publish 阶段失败的 Provider。 */
  const failingProvider = {
    id: "test",
    protocolVersion: 1,
    async plan() {
      return {
        commitId: randomUUID(),
        items: [{ kind: "database", sha256: sha("db"), size: 4 }],
        uploadBytes: 4,
        unchanged: false,
        requiredBytes: 4,
      };
    },
    async execute(plan) {
      return {
        commitId: plan.commitId,
        database: {
          sha256: sha("db"),
          size: 4,
          locator: { kind: "test", ref: "db-2" },
          verification: "download-sha256",
        },
        assets: [],
        transferredBytes: 4,
        complete: true,
        manifestDraft: manifestFor({
          notebookId: capture.notebookId,
          deviceSlotId: previousHead.deviceSlotId,
          commitId: plan.commitId,
          databaseSha: sha("db"),
          databaseSize: 4,
        }),
      };
    },
    async verify(input) {
      return input.manifestDraft;
    },
    async publish() {
      throw Error("发布被拒绝");
    },
  };
  await assert.rejects(
    runFileLevelBackup({
      provider: failingProvider,
      ctx,
      target: { rootRef: "r", notebookRef: "n", deviceSlotRef: "d" },
      capture,
      deviceSlotId: previousHead.deviceSlotId,
      previous: previousManifest,
      previousHead,
    }),
    /发布被拒绝/,
  );
});

test("占位 Provider 明确拒绝未实现的备份流程", async () => {
  const provider = createPlaceholderProvider({
    id: "dropbox",
    capabilities: {
      resumableUpload: false,
      conditionalHead: false,
      providerChecksum: [],
      appScopedStorage: true,
      quotaAvailable: false,
    },
    accountDescriptor: {
      providerId: "dropbox",
      authorizationEndpoint: "https://example.test/auth",
      tokenEndpoint: "https://example.test/token",
      scopes: [],
      pkce: true,
      redirect: "loopback",
      refreshTokenRotation: false,
    },
    reason: "Dropbox 备份仍处于 Beta",
  });
  assert.throws(() => provider.ensureTarget({}, {}), /Dropbox 备份仍处于 Beta/);
  assert.equal((await provider.listCurrentBackups({})).slots.length, 0);
  const probed = await provider.probe({});
  assert.equal(probed.accountType, "placeholder");
});
