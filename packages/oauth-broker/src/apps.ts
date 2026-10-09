import type { CloudProviderId } from "@anynote/types/cloud-backup.js";

/**
 * 官方 OAuth 应用注册（设计 §6.3、§6.4）。
 *
 * 官方版本随发行预置已注册的应用身份；开发/测试与生产的注册相互独立，因此
 * 每个厂商按「阶段」持有各自的 Client ID。Client ID / App Key 是公开应用标识，
 * 这里只承载标识，不含任何密钥——桌面二进制与公开源码无法保密 Client Secret。
 *
 * 官方构建可在打包时注入 `ANYNOTE_OAUTH_APPS`（JSON）；自编译或开发者也可用
 * 环境变量或调用方显式传入覆盖。三者都缺失时返回 `undefined`，由调用方给出
 * 「未配置应用身份」的明确错误，而不是静默使用占位字符串发起授权。
 */

/** OAuth 应用的发布阶段；开发与生产注册不混用（设计 §6.4）。 */
export type OAuthAppStage = "development" | "production";

/** 允许的阶段取值，供校验与诊断使用。 */
export const oauthAppStages: readonly OAuthAppStage[] = Object.freeze([
  "development",
  "production",
]);

/** Client ID 的解析来源；用于如实展示配置状态。 */
export type OAuthClientSource =
  | "explicit"
  | "environment"
  | "registered"
  | "none";

/** 环境变量名到厂商的映射；自编译版本可注入自己的 Client ID。 */
export const oauthClientIdEnv: Readonly<Record<CloudProviderId, string>> =
  Object.freeze({
    "google-drive": "ANYNOTE_GOOGLE_CLIENT_ID",
    dropbox: "ANYNOTE_DROPBOX_APP_KEY",
    onedrive: "ANYNOTE_ONEDRIVE_CLIENT_ID",
  });

/** 阶段选择器环境变量；官方构建按发布渠道注入，缺省视为生产。 */
export const oauthStageEnv = "ANYNOTE_OAUTH_STAGE";

/** 官方应用注册表环境变量；值为 JSON，形如 `{"google-drive":{"production":"…"}}`。 */
export const oauthAppsEnv = "ANYNOTE_OAUTH_APPS";

/** 按厂商与阶段组织的官方应用注册表。 */
export type OAuthAppRegistry = Partial<
  Record<CloudProviderId, Partial<Record<OAuthAppStage, string>>>
>;

/** 官方支持的厂商标识；与类型定义保持一致，作为遍历顺序的单一来源。 */
const providerIds: readonly CloudProviderId[] = Object.freeze([
  "google-drive",
  "dropbox",
  "onedrive",
]);

/**
 * 解析当前生效的应用阶段。
 *
 * 未设置或取值非法时回退到 `production`：官方默认按生产注册发布，开发构建
 * 应显式注入 `ANYNOTE_OAUTH_STAGE=development`，避免误用开发凭据作为长期基线。
 *
 * @param env 环境变量来源。
 * @returns 当前阶段。
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
 * 读取并校验官方应用注册表；结构非法时返回空表而不是抛错。
 *
 * @param env 环境变量来源。
 * @returns 归一化后的注册表。
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
 * 解析厂商的 OAuth Client ID 及其来源。
 *
 * 优先级（设计 §6.3）：调用方显式值 → 厂商环境变量 → 当前阶段的官方注册表。
 * 逐一回落而不是拼接，保证「一个厂商一个身份」，并如实报告来源供诊断与设置页
 * 判断是否需要引导用户配置。
 *
 * @param providerId 厂商标识。
 * @param explicit 调用方显式提供的 Client ID（高级设置 / 自编译）。
 * @param env 环境变量来源。
 * @returns Client ID、来源与当前阶段。
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
 * 解析厂商的 OAuth Client ID；缺失时返回 `undefined`。
 *
 * @param providerId 厂商标识。
 * @param explicit 调用方显式提供的 Client ID。
 * @param env 环境变量来源。
 * @returns Client ID 或 undefined。
 */
export function resolveClientId(
  providerId: CloudProviderId,
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return resolveOAuthClient(providerId, explicit, env).clientId;
}

/** 单个厂商的应用身份配置状态（不含 Client ID 本身，便于展示与诊断）。 */
export interface OAuthAppStatus {
  providerId: CloudProviderId;
  stage: OAuthAppStage;
  /** 是否已解析到可用的 Client ID。 */
  configured: boolean;
  source: OAuthClientSource;
}

/**
 * 汇总各厂商当前的应用身份配置状态。
 *
 * 只暴露是否配置与来源，不回传 Client ID 本身，避免其进入日志或诊断导出。
 *
 * @param env 环境变量来源。
 * @returns 各厂商状态列表。
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
