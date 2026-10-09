import { hasCloudProvider, registerCloudProvider } from "./registry.js";

/**
 * Register the three official cloud extensions that ship with the app (design §4).
 *
 * Official extensions are in-process with the core and ship with the app as workspace packages, consistent with how `backup-local` is
 * consumed by `local.ts`; an extension can only access data via `BackupHostContext`, thus
 * gaining natural integration with the credential vault, scheduler, and consistent capture.
 *
 * Idempotent: repeated calls do not re-register, and disabled extensions do not affect app startup.
 */
export async function registerOfficialProviders(): Promise<void> {
  if (
    hasCloudProvider("google-drive") &&
    hasCloudProvider("dropbox") &&
    hasCloudProvider("onedrive")
  )
    return;
  // googleapis is loaded dynamically only inside the Google extension; when disabled it does not affect editor startup.
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
