import type { CloudProviderId } from "@anynote/types/cloud-backup.js";

/**
 * Official OAuth app registration (design §6.3, §6.4).
 *
 * Official builds ship with pre-registered app identities; dev/test and production registrations are independent, so
 * each vendor holds its own Client ID per "stage". Client ID / App Key is a public app identifier,
 * so only the identifier lives here, with no secret — desktop binaries and public source cannot keep a Client Secret.
 *
 * Official builds may inject `ANYNOTE_OAUTH_APPS` (JSON) at packaging time; self-builds or developers may also
 * override via env vars or an explicit caller argument. When all three are missing it returns `undefined`, and the caller produces
 * an explicit "app identity not configured" error rather than silently starting authorization with a placeholder string.
 */

/** OAuth app release stage; dev and production registrations are not mixed (design §6.4). */
export type OAuthAppStage = "development" | "production";

/** Allowed stage values, for validation and diagnostics. */
export const oauthAppStages: readonly OAuthAppStage[] = Object.freeze([
  "development",
  "production",
]);

/** Resolution source of the Client ID; used to truthfully show config status. */
export type OAuthClientSource =
  | "explicit"
  | "environment"
  | "registered"
  | "none";

/** Mapping from env var names to vendors; self-builds can inject their own Client IDs. */
export const oauthClientIdEnv: Readonly<Record<CloudProviderId, string>> =
  Object.freeze({
    "google-drive": "ANYNOTE_GOOGLE_CLIENT_ID",
    dropbox: "ANYNOTE_DROPBOX_APP_KEY",
    onedrive: "ANYNOTE_ONEDRIVE_CLIENT_ID",
  });

/** Stage-selector env var; official builds inject it per release channel, defaulting to production. */
export const oauthStageEnv = "ANYNOTE_OAUTH_STAGE";

/** Official app registry env var; value is JSON like `{"google-drive":{"production":"…"}}`. */
export const oauthAppsEnv = "ANYNOTE_OAUTH_APPS";

/** Official app registry organized by vendor and stage. */
export type OAuthAppRegistry = Partial<
  Record<CloudProviderId, Partial<Record<OAuthAppStage, string>>>
>;

/** Officially supported vendor ids; consistent with the type definitions, serving as the single source of iteration order. */
const providerIds: readonly CloudProviderId[] = Object.freeze([
  "google-drive",
  "dropbox",
  "onedrive",
]);

/**
 * Resolve the currently effective app stage.
 *
 * Falls back to `production` when unset or invalid: official builds publish against production by default, and dev builds
 * should explicitly inject `ANYNOTE_OAUTH_STAGE=development` to avoid using dev credentials as a long-term baseline.
 *
 * @param env Environment source.
 * @returns The current stage.
 */
export function resolveOAuthStage(
  env: NodeJS.ProcessEnv = process.env,
): OAuthAppStage {
  const value = env[oauthStageEnv]?.trim().toLowerCase();
  return value === "development" || value === "production"
    ? value
    : "production";
}

/**
 * Read and validate the official app registry; returns an empty table rather than throwing when malformed.
 *
 * @param env Environment source.
 * @returns The normalized registry.
 */
export function readOAuthAppRegistry(
  env: NodeJS.ProcessEnv = process.env,
): OAuthAppRegistry {
  const raw = env[oauthAppsEnv]?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const registry: OAuthAppRegistry = {};
  for (const providerId of providerIds) {
    const stages = (parsed as Record<string, unknown>)[providerId];
    if (!stages || typeof stages !== "object") continue;
    const entry: Partial<Record<OAuthAppStage, string>> = {};
    for (const stage of oauthAppStages) {
      const clientId = (stages as Record<string, unknown>)[stage];
      if (typeof clientId === "string" && clientId.trim())
        entry[stage] = clientId.trim();
    }
    if (Object.keys(entry).length) registry[providerId] = entry;
  }
  return registry;
}

/**
 * Resolve a vendor's OAuth Client ID and its source.
 *
 * Priority (design §6.3): explicit caller value → vendor env var → official registry for the current stage.
 * Falls back one by one rather than concatenating, ensuring "one identity per vendor", and truthfully reports the source for diagnostics and the settings page
 * to decide whether to guide the user to configure it.
 *
 * @param providerId Vendor id.
 * @param explicit Client ID explicitly provided by the caller (advanced settings / self-build).
 * @param env Environment source.
 * @returns The Client ID, its source, and the current stage.
 */
export function resolveOAuthClient(
  providerId: CloudProviderId,
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): { clientId?: string; source: OAuthClientSource; stage: OAuthAppStage } {
  const stage = resolveOAuthStage(env),
    explicitId = explicit?.trim();
  if (explicitId) return { clientId: explicitId, source: "explicit", stage };
  const envId = env[oauthClientIdEnv[providerId]]?.trim();
  if (envId) return { clientId: envId, source: "environment", stage };
  const registered = readOAuthAppRegistry(env)[providerId]?.[stage];
  if (registered) return { clientId: registered, source: "registered", stage };
  return { source: "none", stage };
}

/**
 * Resolve a vendor's OAuth Client ID; returns `undefined` when missing.
 *
 * @param providerId Vendor id.
 * @param explicit Client ID explicitly provided by the caller.
 * @param env Environment source.
 * @returns The Client ID or undefined.
 */
export function resolveClientId(
  providerId: CloudProviderId,
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return resolveOAuthClient(providerId, explicit, env).clientId;
}

/** App identity config status for a single vendor (excluding the Client ID itself, for display and diagnostics). */
export interface OAuthAppStatus {
  providerId: CloudProviderId;
  stage: OAuthAppStage;
  /** Whether a usable Client ID has been resolved. */
  configured: boolean;
  source: OAuthClientSource;
}

/**
 * Summarize the current app identity config status for each vendor.
 *
 * Exposes only whether it is configured and the source, never the Client ID itself, keeping it out of logs and diagnostic exports.
 *
 * @param env Environment source.
 * @returns The list of per-vendor statuses.
 */
export function describeOAuthApps(
  env: NodeJS.ProcessEnv = process.env,
): OAuthAppStatus[] {
  return providerIds.map((providerId) => {
    const { clientId, source, stage } = resolveOAuthClient(
      providerId,
      undefined,
      env,
    );
    return { providerId, stage, configured: !!clientId, source };
  });
}
