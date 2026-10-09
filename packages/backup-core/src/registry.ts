import type {
  CloudBackupProvider,
  CloudProviderId,
} from "@anynote/types/cloud-backup.js";

/** 官方扩展的注册项：Provider 实现与展示元数据。 */
export interface CloudProviderRegistration {
  provider: CloudBackupProvider;
  title: string;
  /** 开发中 Provider 标记 Beta，UI 不暗示与稳定 Provider 兼容性相同。 */
  beta?: boolean;
}

const registry = new Map<string, CloudProviderRegistration>();

/**
 * 注册一个官方云盘 Provider。
 *
 * 与现有 `backup-local` 被内进程消费的模式一致：官方扩展以工作区包形式随应用
 * 构建，核心在受信边界内注册其 Provider；扩展本身只能通过 `BackupHostContext`
 * 访问数据，拿不到 SQLite 连接或绝对路径。
 *
 * @param registration Provider 与展示元数据。
 */
export function registerCloudProvider(
  registration: CloudProviderRegistration,
): void {
  const id = registration.provider.id;
  if (registry.has(id)) throw Error(`云盘 Provider 已注册：${id}`);
  registry.set(id, registration);
}

/**
 * 读取一个已注册的 Provider；未注册时抛出明确错误。
 *
 * @param id 厂商标识。
 * @returns Provider 注册项。
 */
export function getCloudProvider(
  id: CloudProviderId,
): CloudProviderRegistration {
  const entry = registry.get(id);
  if (!entry) throw Error(`未安装或未启用云盘扩展：${id}`);
  return entry;
}

/** 判断 Provider 是否已注册（未启用不影响主应用启动）。 */
export const hasCloudProvider = (id: CloudProviderId): boolean =>
  registry.has(id);

/** 列出全部已注册 Provider。 */
export const listCloudProviders = (): CloudProviderRegistration[] => [
  ...registry.values(),
];

/** 清空注册表；仅用于测试与进程退出。 */
export function clearCloudProviders(): void {
  registry.clear();
}
