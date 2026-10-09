import type { Storage } from "@anynote/storage-sqlite/index.js";
import type { Credentials, Vault } from "@anynote/types/runtime.js";
import { createOAuthBroker, type OAuthBroker } from "@anynote/oauth-broker";
import { optionalCloudOpenExternal } from "./host.js";

let current: OAuthBroker | undefined;
let currentRoot: string | undefined;

/** In-memory vault: the browser preview has no system secure storage, so credentials can only be kept in-process. */
function memoryVault(s: Storage): Vault {
  s.secretMemory ??= new Map();
  return {
    async set(id: string, value: Credentials) {
      s.secretMemory!.set(id, value);
      return true;
    },
    async get(id: string) {
      const value = s.secretMemory!.get(id);
      if (!value) throw Error("浏览器预览的凭据只保存在内存，请重新连接账号。");
      return value;
    },
  };
}

/**
 * Get the OAuth broker for the current Storage.
 *
 * One instance per Storage root, avoiding token reuse across data directories; on desktop it uses the
 * `safeStorage`-backed `Storage.vault`, degrading to an in-memory vault in the browser preview.
 *
 * @param s Storage。
 * @returns OAuth broker。
 */
export function cloudBroker(s: Storage): OAuthBroker {
  if (!current || currentRoot !== s.root) {
    current?.dispose();
    current = createOAuthBroker({
      vault: s.vault ?? memoryVault(s),
      openExternal: optionalCloudOpenExternal(),
      // The desktop IPC request cap is 120s; the authorization session must finish before then and give an explicit state.
      timeoutMs: 110_000,
    });
    currentRoot = s.root;
  }
  return current;
}

/** Dispose of the broker; called on process exit or test cleanup. */
export function disposeCloudBroker(): void {
  current?.dispose();
  current = undefined;
  currentRoot = undefined;
}
