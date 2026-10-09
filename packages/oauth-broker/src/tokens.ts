import type { Credentials, Vault } from "@anynote/types/runtime.js";
import type { OAuthProviderDescriptor } from "@anynote/types/cloud-backup.js";

/** 厂商 token 端点的原始响应字段。 */
export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
  account_id?: string;
  error?: string;
  error_description?: string;
}

/** 提前刷新的安全余量；避免请求恰好撞上过期。 */
const refreshSkewMs = 60_000;

/** 不可恢复的鉴权错误，转为「需要重新登录」而不是无限重试。 */
export class CloudAuthError extends Error {
  readonly reauthRequired: boolean;

  /**
   * 构造云盘鉴权错误。
   *
   * @param message 可读信息。
   * @param reauthRequired 是否需要用户重新登录。
   */
  constructor(message: string, reauthRequired = false) {
    super(message);
    this.name = "CloudAuthError";
    this.reauthRequired = reauthRequired;
  }
}

/**
 * 解析并校验 token 端点响应。
 *
 * @param response 原始响应 JSON。
 * @param previous 上一次凭据；轮换时可回填 refresh token。
 * @param now 当前时间（毫秒）。
 * @returns 归一化后的凭据。
 */
export function toCredentials(
  response: TokenResponse,
  previous: Credentials = {},
  now: number = Date.now(),
): Credentials {
  if (!response.access_token)
    throw new CloudAuthError(
      response.error_description || response.error || "云盘未返回 access token",
      response.error === "invalid_grant",
    );
  return {
    token: response.access_token,
    // 响应未包含 refresh token 时保留原值（设计 §6.2），不能因轮换丢失后台访问能力。
    refreshToken: response.refresh_token ?? previous.refreshToken,
    expiresAt: response.expires_in
      ? now + response.expires_in * 1000
      : previous.expiresAt,
    scope: response.scope ?? previous.scope,
    tokenType: response.token_type ?? previous.tokenType ?? "Bearer",
    providerId: previous.providerId,
  };
}

/**
 * 从 token 响应中读取云盘账号标识。
 *
 * `id_token` 只做 base64url 解码取 claim：TLS + 厂商 token 端点已经保证来源，
 * 这里不重复做签名校验，但也不会据此授予任何本地权限。
 *
 * @param response token 响应。
 * @param descriptor 厂商认证描述。
 * @returns 账号标识；无法确定时返回 undefined。
 */
export function accountIdFrom(
  response: TokenResponse,
  descriptor: OAuthProviderDescriptor,
): string | undefined {
  const claim = descriptor.accountIdClaim ?? "id_token:sub";
  if (claim === "response:account_id") return response.account_id;
  const payload = decodeJwtPayload(response.id_token);
  if (!payload) return undefined;
  if (claim === "id_token:email")
    return typeof payload.email === "string" ? payload.email : undefined;
  return typeof payload.sub === "string" ? payload.sub : undefined;
}

/**
 * 不解码即丢弃 payload 的 JWT 解析；仅用于读取标识。
 *
 * @param token JWT。
 * @returns payload 对象或 undefined。
 */
function decodeJwtPayload(token?: string): Record<string, unknown> | undefined {
  if (!token) return undefined;
  const segment = token.split(".")[1];
  if (!segment) return undefined;
  try {
    return JSON.parse(
      Buffer.from(segment, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * 用授权码交换 token（Authorization Code + PKCE）。
 *
 * @param args 端点、客户端与应用信息。
 * @returns token 响应。
 */
export async function exchangeAuthorizationCode(args: {
  descriptor: OAuthProviderDescriptor;
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<TokenResponse> {
  return postToken(args.descriptor.tokenEndpoint, args.fetchImpl, {
    grant_type: "authorization_code",
    code: args.code,
    code_verifier: args.codeVerifier,
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
  });
}

/**
 * 用 refresh token 刷新访问权限。
 *
 * @param args 端点、客户端与 refresh token。
 * @returns token 响应。
 */
export async function refreshAccessToken(args: {
  descriptor: OAuthProviderDescriptor;
  clientId: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<TokenResponse> {
  return postToken(args.descriptor.tokenEndpoint, args.fetchImpl, {
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: args.clientId,
    scope: args.descriptor.scopes.join(" "),
  });
}

/**
 * 以表单形式调用 token 端点并解析 JSON。
 *
 * @param endpoint token 端点。
 * @param fetchImpl fetch 实现。
 * @param params 表单参数。
 * @returns 解析后的 token 响应。
 */
async function postToken(
  endpoint: string,
  fetchImpl: typeof fetch | undefined,
  params: Record<string, string>,
): Promise<TokenResponse> {
  const response = await (fetchImpl ?? fetch)(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let parsed: TokenResponse = {};
  try {
    parsed = JSON.parse(text) as TokenResponse;
  } catch {
    throw new CloudAuthError("云盘鉴权端点返回了无法解析的响应");
  }
  if (!response.ok) {
    const code = parsed.error ?? String(response.status);
    throw new CloudAuthError(
      parsed.error_description || `云盘鉴权失败（${code}）`,
      // invalid_grant / 已撤销 属于不可恢复错误，需要重新登录。
      code === "invalid_grant" ||
        code === "invalid_client" ||
        response.status === 401,
    );
  }
  return parsed;
}

/**
 * 账号凭据 broker：负责落安全存储、single-flight 刷新与撤销。
 *
 * 所有凭据以 `accountRefId`（UUID）为键写入 `Vault`，因此只会进入系统安全
 * 存储；refresh token 不返回 Renderer，也不写入 Notebook。
 */
export class TokenBroker {
  #vault: Vault;
  #fetch: typeof fetch;
  #now: () => number;
  #inflight = new Map<string, Promise<Credentials>>();

  /**
   * @param options 保管库、fetch 实现与时钟。
   */
  constructor(options: {
    vault: Vault;
    fetchImpl?: typeof fetch;
    now?: () => number;
  }) {
    this.#vault = options.vault;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  /** 读取账号凭据；不存在时抛出需要重新登录的错误。 */
  async load(accountRefId: string): Promise<Credentials> {
    const credentials = await this.#vault.get(accountRefId);
    if (!credentials?.token && !credentials?.refreshToken)
      throw new CloudAuthError("云盘账号需要重新登录", true);
    return credentials;
  }

  /** 原子保存账号凭据。 */
  async save(accountRefId: string, credentials: Credentials): Promise<void> {
    await this.#vault.set(accountRefId, credentials);
  }

  /** 删除账号凭据；断开连接时调用。 */
  async forget(accountRefId: string): Promise<void> {
    await this.#vault.set(accountRefId, { token: undefined });
  }

  /**
   * 取得仍有效的 access token；必要时按账号 single-flight 刷新。
   *
   * 并发调用只会触发一次刷新；`invalid_grant` 等不可恢复错误会转换为需要
   * 重新登录，不做无限重试（设计 §6.2）。
   *
   * @param accountRefId 账号凭据键。
   * @param descriptor 厂商认证描述。
   * @param clientId OAuth Client ID。
   * @returns 有效 access token。
   */
  async accessToken(
    accountRefId: string,
    descriptor: OAuthProviderDescriptor,
    clientId: string,
  ): Promise<string> {
    const credentials = await this.load(accountRefId);
    if (credentials.token && !this.#expired(credentials))
      return credentials.token;
    if (!credentials.refreshToken)
      throw new CloudAuthError("云盘账号需要重新登录", true);
    const existing = this.#inflight.get(accountRefId);
    if (existing) return (await existing).token!;
    const refresh = (async () => {
      const response = await refreshAccessToken({
        descriptor,
        clientId,
        refreshToken: credentials.refreshToken!,
        fetchImpl: this.#fetch,
      });
      const next = toCredentials(response, credentials, this.#now());
      next.providerId = credentials.providerId;
      await this.save(accountRefId, next);
      return next;
    })();
    this.#inflight.set(accountRefId, refresh);
    try {
      return (await refresh).token!;
    } finally {
      this.#inflight.delete(accountRefId);
    }
  }

  /**
   * 调用厂商撤销端点（若适用）并清除本机凭据。
   *
   * 撤销厂商端点可能影响同一应用在其他设备上的授权，因此这是「断开连接」中
   * 的可选步骤，而不是删除云端备份（设计 §5.4）。
   *
   * @param accountRefId 账号凭据键。
   * @param descriptor 厂商认证描述。
   * @returns 是否成功调用撤销端点。
   */
  async revoke(
    accountRefId: string,
    descriptor: OAuthProviderDescriptor,
  ): Promise<boolean> {
    const credentials = await this.load(accountRefId).catch(() => undefined);
    const token = credentials?.refreshToken ?? credentials?.token;
    if (token && descriptor.revocationEndpoint) {
      const body =
        descriptor.providerId === "google-drive"
          ? new URLSearchParams({ token })
          : new URLSearchParams({ token, client_id: "" });
      try {
        await this.#fetch(descriptor.revocationEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        // 撤销失败不影响本机断开；UI 会给出账号安全页入口。
        await this.forget(accountRefId);
        return false;
      }
    }
    await this.forget(accountRefId);
    return true;
  }

  /** 判断凭据是否已过期（含提前刷新余量）。 */
  #expired(credentials: Credentials): boolean {
    // 缺少过期时间时视为长期有效；`0` 是真实的「很久以前过期」，必须刷新。
    if (credentials.expiresAt == null) return false;
    return credentials.expiresAt - refreshSkewMs <= this.#now();
  }
}
