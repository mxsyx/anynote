import { randomUUID } from "node:crypto";
import type { Vault } from "@anynote/types/runtime.js";
import type {
  AccessTokenProvider,
  CloudAccountRef,
  CloudProviderId,
  OAuthProviderDescriptor,
} from "@anynote/types/cloud-backup.js";
import { createPkce, randomState } from "./pkce.js";
import { startLoopbackListener, type CallbackListener } from "./loopback.js";
import {
  type OAuthAppStage,
  type OAuthClientSource,
  resolveOAuthClient,
} from "./apps.js";
import { OAuthLaunchError } from "./errors.js";
import { oauthDescriptors } from "./providers.js";
import {
  CloudAuthError,
  TokenBroker,
  accountIdFrom,
  exchangeAuthorizationCode,
  toCredentials,
} from "./tokens.js";

/** An in-progress authorization session. */
export interface AuthorizationSession {
  sessionId: string;
  providerId: CloudProviderId;
  oauthClientId: string;
  /** App identity source, to diagnose whether self-build/env injection took effect. */
  clientIdSource: OAuthClientSource;
  /** Current app stage (development/production). */
  stage: OAuthAppStage;
  redirectUri: string;
  createdAt: number;
}

export interface OAuthBrokerOptions {
  /** System secure storage; safeStorage on desktop, in-memory in browser preview. */
  vault: Vault;
  /**
   * Open the authorization page in the system browser; only the main process can do this.
   *
   * When absent, `begin` only returns the authorization URL for the caller (renderer) to open, so browser
   * preview and automated tests reuse the same PKCE flow.
   */
  openExternal?(url: string): Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Client ID injected by self-build/advanced settings; falls back to the env var when absent. */
  clientIds?: Partial<Record<CloudProviderId, string>>;
  env?: NodeJS.ProcessEnv;
  /** Authorization session timeout (milliseconds). */
  timeoutMs?: number;
}

/**
 * Vendor-specific extra parameters for the authorization request.
 *
 * @param providerId Vendor id.
 * @returns Query parameters to append to the authorization URL.
 */
function providerAuthParams(
  providerId: CloudProviderId,
): Record<string, string> {
  if (providerId === "google-drive")
    // Desktop background backup needs a refresh token (design §6.1).
    return { access_type: "offline", prompt: "consent" };
  if (providerId === "dropbox")
    // Dropbox uses the PKCE + refresh token background access mode (design §11.1).
    return { token_access_type: "offline" };
  if (providerId === "onedrive") return { response_mode: "query" };
  return {};
}

/**
 * Create the unified OAuth execution framework (design §6.1, §6.2).
 *
 * Handles system browser launch, loopback callback listening, state/PKCE verification, authorization code exchange, credential
 * secure storage, and single-flight refresh; unaware of any cloud business semantics.
 *
 * @param options Vault, browser launcher, clock, and Client ID source.
 * @returns OAuth broker。
 */
export function createOAuthBroker(options: OAuthBrokerOptions) {
  const now = options.now ?? Date.now,
    tokens = new TokenBroker({
      vault: options.vault,
      fetchImpl: options.fetchImpl,
      now,
    }),
    sessions = new Map<
      string,
      {
        session: AuthorizationSession;
        listener: CallbackListener;
        verifier: string;
        descriptor: OAuthProviderDescriptor;
      }
    >();

  /** Resolve the vendor Client ID, giving an explicit error rather than a placeholder when missing. */
  const clientIdFor = (providerId: CloudProviderId, explicit?: string) => {
    const { clientId, source, stage } = resolveOAuthClient(
      providerId,
      explicit ?? options.clientIds?.[providerId],
      options.env,
    );
    if (!clientId)
      throw new Error(
        `未配置 ${providerId} 的 OAuth 应用身份（阶段：${stage}）；官方版本会预置，自编译版本可在高级设置或环境变量中提供。`,
      );
    return { clientId, source, stage };
  };

  /** Close a session and release the loopback port. */
  const discard = (sessionId: string) => {
    const entry = sessions.get(sessionId);
    if (!entry) return false;
    sessions.delete(sessionId);
    entry.listener.close();
    return true;
  };

  return {
    descriptors: oauthDescriptors,
    tokens,

    /**
     * Begin an authorization: generate PKCE/state, open the loopback listener, and open the authorization page in the system browser.
     *
     * @param input Vendor id and an optional custom Client ID.
     * @returns The session id and authorization URL.
     */
    async begin(input: {
      providerId: CloudProviderId;
      oauthClientId?: string;
    }): Promise<{
      sessionId: string;
      authorizationUrl: string;
      /** Whether the host (main process) opened the system browser; otherwise the caller opens it. */
      opened: boolean;
    }> {
      const descriptor = oauthDescriptors[input.providerId];
      if (!descriptor) throw new Error(`未知的云盘厂商：${input.providerId}`);
      const client = clientIdFor(input.providerId, input.oauthClientId),
        state = randomState(),
        pkce = createPkce(),
        listener = await startLoopbackListener({
          expectedState: state,
          path: descriptor.redirectPath,
          ports: descriptor.redirectPorts,
          timeoutMs: options.timeoutMs,
        }),
        sessionId = randomUUID(),
        url = new URL(descriptor.authorizationEndpoint);
      url.searchParams.set("client_id", client.clientId);
      url.searchParams.set("redirect_uri", listener.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", descriptor.scopes.join(" "));
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", pkce.challenge);
      url.searchParams.set("code_challenge_method", pkce.method);
      for (const [key, value] of Object.entries(
        providerAuthParams(input.providerId),
      ))
        url.searchParams.set(key, value);
      sessions.set(sessionId, {
        session: {
          sessionId,
          providerId: input.providerId,
          oauthClientId: client.clientId,
          clientIdSource: client.source,
          stage: client.stage,
          redirectUri: listener.redirectUri,
          createdAt: now(),
        },
        listener,
        verifier: pkce.verifier,
        descriptor,
      });
      try {
        await options.openExternal?.(url.toString());
      } catch (error) {
        // Browser launch failure is an explicit state: clean up the session and give an actionable prompt, not a raw system error.
        discard(sessionId);
        throw new OAuthLaunchError(
          "无法打开系统浏览器完成授权，请检查默认浏览器设置后重试。",
          { cause: error },
        );
      }
      return {
        sessionId,
        authorizationUrl: url.toString(),
        opened: !!options.openExternal,
      };
    },

    /**
     * Wait for the callback, verify state, exchange the authorization code, and store credentials securely.
     *
     * @param input Session id.
     * @param signal Cancellation signal.
     * @returns The local account reference id and account reference.
     */
    async complete(
      input: { sessionId: string },
      signal?: AbortSignal,
    ): Promise<{ id: string; ref: CloudAccountRef }> {
      const entry = sessions.get(input.sessionId);
      if (!entry) throw new Error("OAuth 授权会话不存在或已结束");
      try {
        const callback = await entry.listener.wait(signal);
        if (callback.error)
          throw new CloudAuthError(
            callback.errorDescription || `授权被拒绝（${callback.error}）`,
          );
        if (!callback.code) throw new CloudAuthError("OAuth 回调缺少授权码");
        const response = await exchangeAuthorizationCode({
          descriptor: entry.descriptor,
          clientId: entry.session.oauthClientId,
          code: callback.code,
          codeVerifier: entry.verifier,
          redirectUri: entry.session.redirectUri,
          fetchImpl: options.fetchImpl,
        });
        const credentials = toCredentials(response, {}, now());
        credentials.providerId = entry.session.providerId;
        const accountId = accountIdFrom(response, entry.descriptor);
        if (!accountId)
          throw new CloudAuthError(
            "无法确定云盘账号身份，请重新授权或检查应用权限",
          );
        const id = randomUUID();
        await tokens.save(id, credentials);
        return {
          id,
          ref: {
            providerId: entry.session.providerId,
            oauthClientId: entry.session.oauthClientId,
            accountId,
            context:
              entry.session.providerId === "onedrive" ? "common" : undefined,
            displayName: accountId,
          },
        };
      } finally {
        discard(input.sessionId);
      }
    },

    /**
     * Cancel an in-progress authorization.
     *
     * @param input Session id.
     * @returns Whether the session was cancelled.
     */
    async cancel(input: { sessionId: string }): Promise<boolean> {
      const entry = sessions.get(input.sessionId);
      if (!entry) return false;
      entry.listener.close();
      sessions.delete(input.sessionId);
      return true;
    },

    /** Create a short-lived access token provider for the given account (used by trusted first-party extensions). */
    tokenProvider(
      accountRefId: string,
      providerId: CloudProviderId,
      clientId: string,
    ): AccessTokenProvider {
      const descriptor = oauthDescriptors[providerId];
      return {
        getAccessToken: async () => {
          const token = await tokens.accessToken(
            accountRefId,
            descriptor,
            clientId,
          );
          const credentials = await tokens
            .load(accountRefId)
            .catch(() => undefined);
          return {
            token,
            expiryDate: credentials?.expiresAt ?? now() + 3_600_000,
          };
        },
      };
    },

    /** Close all in-progress authorization sessions. */
    dispose() {
      for (const entry of sessions.values()) entry.listener.close();
      sessions.clear();
    },
  };
}

export type OAuthBroker = ReturnType<typeof createOAuthBroker>;
