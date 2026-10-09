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

/** 一个进行中的授权会话。 */
export interface AuthorizationSession {
  sessionId: string;
  providerId: CloudProviderId;
  oauthClientId: string;
  /** 应用身份来源，便于诊断自编译/环境变量注入是否生效。 */
  clientIdSource: OAuthClientSource;
  /** 当前应用阶段（开发/生产）。 */
  stage: OAuthAppStage;
  redirectUri: string;
  createdAt: number;
}

export interface OAuthBrokerOptions {
  /** 系统安全存储；桌面为 safeStorage，浏览器预览为内存。 */
  vault: Vault;
  /**
   * 用系统浏览器打开授权页；只能由主进程执行。
   *
   * 缺省时 `begin` 只返回授权 URL，由调用方（渲染进程）自行打开，便于浏览器
   * 预览与自动化测试复用同一条 PKCE 流程。
   */
  openExternal?(url: string): Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** 自编译/高级设置注入的 Client ID；缺省回落到环境变量。 */
  clientIds?: Partial<Record<CloudProviderId, string>>;
  env?: NodeJS.ProcessEnv;
  /** 授权会话超时（毫秒）。 */
  timeoutMs?: number;
}

/**
 * 厂商专属的授权请求附加参数。
 *
 * @param providerId 厂商标识。
 * @returns 需要附加到授权 URL 的查询参数。
 */
function providerAuthParams(
  providerId: CloudProviderId,
): Record<string, string> {
  if (providerId === "google-drive")
    // 桌面后台备份需要 refresh token（设计 §6.1）。
    return { access_type: "offline", prompt: "consent" };
  if (providerId === "dropbox")
    // Dropbox 使用 PKCE + refresh token 的后台访问模式（设计 §11.1）。
    return { token_access_type: "offline" };
  if (providerId === "onedrive") return { response_mode: "query" };
  return {};
}

/**
 * 创建统一 OAuth 执行框架（设计 §6.1、§6.2）。
 *
 * 负责系统浏览器唤起、回环回调监听、state/PKCE 校验、授权码交换、凭据落
 * 安全存储与 single-flight 刷新；不感知任何云盘业务语义。
 *
 * @param options 保管库、浏览器唤起、时钟与 Client ID 来源。
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

  /** 解析厂商 Client ID，缺失时给出明确错误而不是占位值。 */
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

  /** 关闭一个会话并释放回环端口。 */
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
     * 开始一次授权：生成 PKCE/state、开启回环监听并用系统浏览器打开授权页。
     *
     * @param input 厂商标识与可选的自定义 Client ID。
     * @returns 会话标识与授权 URL。
     */
    async begin(input: {
      providerId: CloudProviderId;
      oauthClientId?: string;
    }): Promise<{
      sessionId: string;
      authorizationUrl: string;
      /** 是否已由宿主（主进程）打开系统浏览器；否则由调用方自行打开。 */
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
        // 浏览器唤起失败属于明确状态：清理会话并给出可操作提示，不把原始系统错误抛给用户。
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
     * 等待回调、校验 state、交换授权码并落安全存储。
     *
     * @param input 会话标识。
     * @param signal 取消信号。
     * @returns 本机账号引用 ID 与账号引用。
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
     * 取消一次进行中的授权。
     *
     * @param input 会话标识。
     * @returns 是否取消了会话。
     */
    async cancel(input: { sessionId: string }): Promise<boolean> {
      const entry = sessions.get(input.sessionId);
      if (!entry) return false;
      entry.listener.close();
      sessions.delete(input.sessionId);
      return true;
    },

    /** 为指定账号创建短时 access token 提供者（受信首方扩展使用）。 */
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

    /** 关闭全部进行中的授权会话。 */
    dispose() {
      for (const entry of sessions.values()) entry.listener.close();
      sessions.clear();
    },
  };
}

export type OAuthBroker = ReturnType<typeof createOAuthBroker>;
