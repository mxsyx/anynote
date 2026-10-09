import { hasCloudProvider, registerCloudProvider } from "./registry.js";

/**
 * 注册随应用构建的三个官方云盘扩展（设计 §4）。
 *
 * 官方扩展与核心同进程、以工作区包形式随应用构建，与现有 `backup-local` 被
 * `local.ts` 消费的模式一致；扩展只能通过 `BackupHostContext` 访问数据，因此
 * 换取了与凭据保管库、调度器和一致性捕获的天然集成。
 *
 * 幂等：重复调用不会重复注册，未启用的扩展也不影响主应用启动。
 */
export async function registerOfficialProviders(): Promise<void> {
  if (
    hasCloudProvider("google-drive") &&
    hasCloudProvider("dropbox") &&
    hasCloudProvider("onedrive")
  )
    return;
  // googleapis 只在 Google 扩展内部动态加载，未启用时不影响编辑器启动。
  const [google, dropbox, onedrive] = await Promise.all([
    import("@anynote/backup-google-drive"),
    import("@anynote/backup-dropbox"),
    import("@anynote/backup-onedrive"),
  ]);
  for (const extension of [
    google.cloudBackupExtension,
    dropbox.cloudBackupExtension,
    onedrive.cloudBackupExtension,
  ])
    if (!hasCloudProvider(extension.provider.id))
      registerCloudProvider({
        provider: extension.provider,
        title: extension.title,
        beta: extension.beta,
      });
}
