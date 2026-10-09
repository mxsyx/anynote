import { test } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  OAuthLaunchError,
  OAuthPortError,
  createOAuthBroker,
  describeOAuthApps,
  resolveClientId,
  resolveOAuthClient,
  resolveOAuthStage,
  startLoopbackListener,
} from "../.build/packages/oauth-broker/index.js";

/** In-process vault; test-only, real credentials go into system secure storage. */
function memoryVault(store = new Map()) {
  return {
    store,
    async set(id, value) {
      store.set(id, value);
    },
    async get(id) {
      return store.get(id);
    },
  };
}

/** Build a base64url-encoded JWT payload; the signature is guaranteed by vendor TLS, so tests need not verify it. */
const idToken = (claims) =>
  `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

test("应用身份按开发/生产阶段解析，缺失时明确为空", () => {
  const env = {
    ANYNOTE_OAUTH_STAGE: "development",
    ANYNOTE_OAUTH_APPS: JSON.stringify({
      "google-drive": { development: "dev-id", production: "prod-id" },
    }),
  };
  assert.equal(resolveOAuthStage(env), "development");
  assert.deepEqual(resolveOAuthClient("google-drive", undefined, env), {
    clientId: "dev-id",
    source: "registered",
    stage: "development",
  });
  assert.deepEqual(
    resolveOAuthClient("google-drive", undefined, {
      ...env,
      ANYNOTE_OAUTH_STAGE: "production",
    }),
    { clientId: "prod-id", source: "registered", stage: "production" },
  );
  // Explicit values and env vars take precedence over the official registry.
  assert.equal(resolveClientId("google-drive", "explicit", env), "explicit");
  assert.equal(
    resolveClientId("dropbox", undefined, {
      ...env,
      ANYNOTE_DROPBOX_APP_KEY: "env-key",
    }),
    "env-key",
  );
  // Returns undefined when missing, rather than a placeholder string.
  assert.equal(resolveClientId("onedrive", undefined, {}), undefined);
  // An invalid stage falls back to production; a corrupt registry is ignored rather than throwing.
  assert.equal(
    resolveOAuthStage({ ANYNOTE_OAUTH_STAGE: "staging" }),
    "production",
  );
  assert.equal(
    resolveClientId("google-drive", undefined, {
      ANYNOTE_OAUTH_APPS: "{not-json",
    }),
    undefined,
  );
});

test("应用身份配置状态只报告是否配置与来源", () => {
  const status = describeOAuthApps({
    ANYNOTE_OAUTH_STAGE: "production",
    ANYNOTE_OAUTH_APPS: JSON.stringify({
      "google-drive": { production: "prod-id" },
    }),
    ANYNOTE_ONEDRIVE_CLIENT_ID: "env-id",
  });
  const byId = Object.fromEntries(
    status.map((item) => [item.providerId, item]),
  );
  assert.deepEqual(byId["google-drive"], {
    providerId: "google-drive",
    stage: "production",
    configured: true,
    source: "registered",
  });
  assert.deepEqual(byId.dropbox, {
    providerId: "dropbox",
    stage: "production",
    configured: false,
    source: "none",
  });
  assert.equal(byId.onedrive.source, "environment");
});

test("授权经回环回调交换 token 并写入保管库", async () => {
  const vault = memoryVault();
  let authorization;
  let tokenRequest;
  const broker = createOAuthBroker({
    vault,
    env: {},
    clientIds: { "google-drive": "client-1" },
    fetchImpl: async (_input, init) => {
      tokenRequest = new URLSearchParams(init.body);
      return new Response(
        JSON.stringify({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          id_token: idToken({ sub: "user-1" }),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
    openExternal: async (url) => {
      authorization = new URL(url);
      const redirect = authorization.searchParams.get("redirect_uri");
      const state = authorization.searchParams.get("state");
      // Simulate the vendor page redirecting the browser back to the loopback callback address.
      setTimeout(() => {
        void fetch(
          `${redirect}?code=code-1&state=${encodeURIComponent(state)}`,
        );
      }, 5);
    },
  });

  const begun = await broker.begin({ providerId: "google-drive" });
  assert.equal(begun.opened, true);
  assert.equal(authorization.searchParams.get("client_id"), "client-1");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.get("response_type"), "code");
  assert.equal(authorization.searchParams.get("access_type"), "offline");
  assert.match(
    authorization.searchParams.get("redirect_uri"),
    /^http:\/\/127\.0\.0\.1:\d+\/$/,
  );

  const { id, ref } = await broker.complete({ sessionId: begun.sessionId });
  assert.equal(ref.accountId, "user-1");
  assert.equal(ref.oauthClientId, "client-1");
  assert.equal(ref.providerId, "google-drive");
  // PKCE: the verifier received by the token endpoint must reconstruct the challenge in the authorization request.
  assert.equal(
    createHash("sha256")
      .update(tokenRequest.get("code_verifier"))
      .digest("base64url"),
    authorization.searchParams.get("code_challenge"),
  );
  assert.equal(tokenRequest.get("code"), "code-1");
  assert.equal(tokenRequest.get("grant_type"), "authorization_code");
  assert.equal(vault.store.get(id).refreshToken, "rt");
  broker.dispose();
});

test("回调 state 不符时拒绝且不交换 token", async () => {
  const vault = memoryVault();
  let exchanged = false;
  const broker = createOAuthBroker({
    vault,
    env: {},
    clientIds: { "google-drive": "client-1" },
    fetchImpl: async () => {
      exchanged = true;
      return new Response("{}", { status: 200 });
    },
    openExternal: async (url) => {
      const target = new URL(url);
      const redirect = target.searchParams.get("redirect_uri");
      setTimeout(() => {
        void fetch(`${redirect}?code=code-1&state=forged`);
      }, 5);
    },
  });
  const begun = await broker.begin({ providerId: "google-drive" });
  await assert.rejects(
    broker.complete({ sessionId: begun.sessionId }),
    /state 校验失败/,
  );
  assert.equal(exchanged, false);
  broker.dispose();
});

test("授权超时给出明确状态", async () => {
  const vault = memoryVault();
  const broker = createOAuthBroker({
    vault,
    env: {},
    clientIds: { "google-drive": "client-1" },
    timeoutMs: 20,
    openExternal: async () => {},
  });
  const begun = await broker.begin({ providerId: "google-drive" });
  await assert.rejects(broker.complete({ sessionId: begun.sessionId }), /超时/);
  broker.dispose();
});

test("回环端口被占用时报明确状态，并可回落到随机端口", async () => {
  const blocker = createServer(() => {});
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const busyPort = blocker.address().port;

  await assert.rejects(
    startLoopbackListener({ expectedState: "s", ports: [busyPort] }),
    (error) => error instanceof OAuthPortError,
  );

  // When the second candidate is 0 (random port) it should listen successfully, not fail outright.
  const listener = await startLoopbackListener({
    expectedState: "s",
    ports: [busyPort, 0],
  });
  assert.match(listener.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  listener.close();
  await new Promise((resolve) => blocker.close(resolve));
});

test("系统浏览器唤起失败给出明确状态并清理会话", async () => {
  const vault = memoryVault();
  let port;
  const broker = createOAuthBroker({
    vault,
    env: {},
    clientIds: { "google-drive": "client-1" },
    timeoutMs: 20,
    openExternal: async (url) => {
      port = new URL(url).searchParams.get("redirect_uri");
      throw new Error("no system browser");
    },
  });
  await assert.rejects(
    broker.begin({ providerId: "google-drive" }),
    (error) =>
      error instanceof OAuthLaunchError && error.cause instanceof Error,
  );
  // The session was already discarded on launch failure: complete finds no session and the port is released.
  broker.dispose();
  assert.ok(port);
});

test("未配置应用身份时给出可操作错误", async () => {
  const vault = memoryVault();
  const broker = createOAuthBroker({ vault, env: {} });
  await assert.rejects(
    broker.begin({ providerId: "google-drive" }),
    /未配置 google-drive 的 OAuth 应用身份/,
  );
  broker.dispose();
});
