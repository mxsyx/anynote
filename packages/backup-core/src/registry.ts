import type {
  CloudBackupProvider,
  CloudProviderId,
} from "@anynote/types/cloud-backup.js";

/** Registration entry for an official extension: Provider implementation and display metadata. */
export interface CloudProviderRegistration {
  provider: CloudBackupProvider;
  title: string;
  /** An in-development Provider is marked Beta; the UI does not imply compatibility equal to stable Providers. */
  beta?: boolean;
}

const registry = new Map<string, CloudProviderRegistration>();

/**
 * Register an official cloud Provider.
 *
 * Consistent with how `backup-local` is consumed in-process: official extensions ship with the app as workspace packages,
 * and the core registers their Providers within the trusted boundary; an extension itself can only, via `BackupHostContext`,
 * access data, never getting a SQLite connection or an absolute path.
 *
 * @param registration Provider and display metadata.
 */
export function registerCloudProvider(
  registration: CloudProviderRegistration,
): void {
  const id = registration.provider.id;
  if (registry.has(id)) throw Error(`云盘 Provider 已注册：${id}`);
  registry.set(id, registration);
}

/**
 * Read a registered Provider; throws an explicit error when unregistered.
 *
 * @param id Vendor id.
 * @returns The Provider registration entry.
 */
export function getCloudProvider(
  id: CloudProviderId,
): CloudProviderRegistration {
  const entry = registry.get(id);
  if (!entry) throw Error(`未安装或未启用云盘扩展：${id}`);
  return entry;
}

/** Determine whether a Provider is registered (being disabled does not affect app startup). */
export const hasCloudProvider = (id: CloudProviderId): boolean =>
  registry.has(id);

/** List all registered Providers. */
export const listCloudProviders = (): CloudProviderRegistration[] => [
  ...registry.values(),
];

/** Clear the registry; used only for tests and process exit. */
export function clearCloudProviders(): void {
  registry.clear();
}
