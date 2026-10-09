import type { CloudProviderId } from "@anynote/types/cloud-backup.js";
import { listCloudProviders } from "./registry.js";

/** Display metadata for the three official clouds; extensions not yet installed can still be discovered in "Add target". */
export interface OfficialProvider {
  id: CloudProviderId;
  title: string;
  beta: boolean;
}

/** Initial official Provider list (design §1.1). */
export const officialProviders: readonly OfficialProvider[] = Object.freeze([
  { id: "google-drive", title: "Google Drive", beta: false },
  { id: "dropbox", title: "Dropbox", beta: false },
  { id: "onedrive", title: "OneDrive", beta: false },
]);

/**
 * Merge the official list with registered Providers to get the Provider view shown in the backup center.
 *
 * `installed` means the extension is available in the current build; when not installed the backup center only offers install guidance,
 * never requesting permissions automatically (design §4).
 *
 * @returns The list of Provider views.
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
 * Read the official display metadata.
 *
 * @param id Vendor id.
 * @returns Display metadata; returns undefined for an unknown vendor.
 */
export const officialProvider = (
  id: CloudProviderId,
): OfficialProvider | undefined =>
  officialProviders.find((provider) => provider.id === id);
