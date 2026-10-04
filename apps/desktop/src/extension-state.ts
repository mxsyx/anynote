import { request } from "./api";
import type { InstalledExtension } from "@anynote/plugin-sdk/declarative";
const cache = new Map<string, Promise<InstalledExtension[]>>();
export function installedExtensions(notebookId: string) {
  let value = cache.get(notebookId);
  if (!value) {
    value = request<InstalledExtension[]>("listExtensions", {
      notebookId,
    }).catch((e) => {
      cache.delete(notebookId);
      throw e;
    });
    if (cache.size >= 8) cache.delete(cache.keys().next().value!);
    cache.set(notebookId, value);
  }
  return value;
}
export function extensionsChanged() {
  cache.clear();
  window.dispatchEvent(new Event("anynote:extensions-changed"));
}
