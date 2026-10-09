import type { Credentials, Vault } from "@anynote/types/runtime.js";
import type { OAuthProviderDescriptor } from "@anynote/types/cloud-backup.js";

/** Raw response fields of the vendor token endpoint. */
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

/** Safety margin for early refresh; avoids a request landing exactly on expiry. */
const refreshSkewMs = 60_000;

/** An unrecoverable auth error, turned into "re-login required" instead of infinite retries. */
export class CloudAuthError extends Error {
  readonly reauthRequired: boolean;

  /**
   * Construct a cloud auth error.
   *
   * @param message Readable message.
   * @param reauthRequired Whether the user must log in again.
   */
  constructor(message: string, reauthRequired = false) {
    super(message);
    this.name = "CloudAuthError";
    this.reauthRequired = reauthRequired;
  }
}

/**
 * Parse and validate the token endpoint response.
 *
 * @param response Raw response JSON.
 * @param previous Previous credentials; may backfill the refresh token on rotation.
 * @param now Current time (milliseconds).
 * @returns Normalized credentials.
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
    // When the response has no refresh token keep the original (design §6.2); rotation must not lose background access.
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
 * Read the cloud account identifier from the token response.
 *
 * `id_token` is only base64url-decoded to read the claim: TLS plus the vendor token endpoint already guarantee the source,
 * so no signature verification is repeated here, and no local permission is granted based on it.
 *
 * @param response Token response.
 * @param descriptor Vendor auth descriptor.
 * @returns The account identifier, or undefined when it cannot be determined.
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
 * JWT parsing that discards the payload without decoding it; used only to read the identifier.
 *
 * @param token JWT。
 * @returns The payload object or undefined.
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
 * Exchange the authorization code for tokens (Authorization Code + PKCE).
 *
 * @param args Endpoints, client, and app info.
 * @returns The token response.
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
 * Refresh access using the refresh token.
 *
 * @param args Endpoints, client, and refresh token.
 * @returns The token response.
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
 * Call the token endpoint as a form post and parse JSON.
 *
 * @param endpoint Token endpoint.
 * @param fetchImpl fetch implementation.
 * @param params Form parameters.
 * @returns The parsed token response.
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
      // invalid_grant / revoked are unrecoverable errors requiring re-login.
      code === "invalid_grant" ||
        code === "invalid_client" ||
        response.status === 401,
    );
  }
  return parsed;
}

/**
 * Account credential broker: handles secure storage, single-flight refresh, and revocation.
 *
 * All credentials are written to `Vault` keyed by `accountRefId` (UUID), so they only enter system secure
 * storage; the refresh token is never returned to the Renderer nor written into a Notebook.
 */
export class TokenBroker {
  #vault: Vault;
  #fetch: typeof fetch;
  #now: () => number;
  #inflight = new Map<string, Promise<Credentials>>();

  /**
   * @param options Vault, fetch implementation, and clock.
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

  /** Read account credentials; throws a re-login-required error when absent. */
  async load(accountRefId: string): Promise<Credentials> {
    const credentials = await this.#vault.get(accountRefId);
    if (!credentials?.token && !credentials?.refreshToken)
      throw new CloudAuthError("云盘账号需要重新登录", true);
    return credentials;
  }

  /** Atomically save account credentials. */
  async save(accountRefId: string, credentials: Credentials): Promise<void> {
    await this.#vault.set(accountRefId, credentials);
  }

  /** Delete account credentials; called on disconnect. */
  async forget(accountRefId: string): Promise<void> {
    await this.#vault.set(accountRefId, { token: undefined });
  }

  /**
   * Get a still-valid access token, single-flight refreshing per account when needed.
   *
   * Concurrent calls trigger only one refresh; unrecoverable errors such as `invalid_grant` are converted into
   * re-login-required, with no infinite retries (design §6.2).
   *
   * @param accountRefId Account credential key.
   * @param descriptor Vendor auth descriptor.
   * @param clientId OAuth Client ID。
   * @returns A valid access token.
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
   * Call the vendor revocation endpoint (if applicable) and clear local credentials.
   *
   * Revoking the vendor endpoint may affect the same app's authorization on other devices, so this is an optional
   * step within "disconnect", not a deletion of cloud backups (design §5.4).
   *
   * @param accountRefId Account credential key.
   * @param descriptor Vendor auth descriptor.
   * @returns Whether the revocation endpoint was called successfully.
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
        // A revocation failure does not block local disconnect; the UI provides a link to the account security page.
        await this.forget(accountRefId);
        return false;
      }
    }
    await this.forget(accountRefId);
    return true;
  }

  /** Determine whether credentials are expired (including the early-refresh margin). */
  #expired(credentials: Credentials): boolean {
    // Missing expiry is treated as long-lived; `0` is a genuine "expired long ago" and must be refreshed.
    if (credentials.expiresAt == null) return false;
    return credentials.expiresAt - refreshSkewMs <= this.#now();
  }
}
