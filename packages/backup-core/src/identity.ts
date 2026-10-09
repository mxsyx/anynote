import type { CloudProviderId } from "@anynote/types/cloud-backup.js";
import { listCloudProviders } from "./registry.js";

/** 官方三家云盘的展示元数据；未安装的扩展也可在「添加目标」中被发现。 */
export interface OfficialProvider {
  id: CloudProviderId;
  title: string;
  beta: boolean;
}

/** 首期官方 Provider 清单（设计 §1.1）。 */
export const officialProviders: readonly OfficialProvider[] = Object.freeze([
  { id: "google-drive", title: "Google Drive", beta: false },
  { id: "dropbox", title: "Dropbox", beta: true },
  { id: "onedrive", title: "OneDrive", beta: true },
]);

/**
 * 合并官方清单与已注册 Provider，得到备份中心可展示的 Provider 视图。
 *
 * `installed` 表示该扩展在当前构建中可用；未安装时备份中心只提供安装引导，
 * 不会自动索取权限（设计 §4）。
 *
 * @returns Provider 视图列表。
 */
export function listProviderViews(): (OfficialProvider & {
  installed: boolean;
})[] {
  const registered = new Set(
    listCloudProviders().map((entry) => entry.provider.id),
  );
  return officialProviders.map((provider) => ({
    ...provider,
    installed: registered.has(provider.id),
  }));
}

/**
 * 读取官方展示元数据。
 *
 * @param id 厂商标识。
 * @returns 展示元数据；未知厂商返回 undefined。
 */
export const officialProvider = (
  id: CloudProviderId,
): OfficialProvider | undefined =>
  officialProviders.find((provider) => provider.id === id);
