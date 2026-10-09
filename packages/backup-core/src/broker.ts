import type { Storage } from "@anynote/storage-sqlite/index.js";
import type { Credentials, Vault } from "@anynote/types/runtime.js";
import { createOAuthBroker, type OAuthBroker } from "@anynote/oauth-broker";
import { optionalCloudOpenExternal } from "./host.js";

let current: OAuthBroker | undefined;
let currentRoot: string | undefined;

/** 内存保管库：浏览器预览没有系统安全存储，只能在进程内保留凭据。 */
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
 * 取得当前 Storage 对应的 OAuth broker。
 *
 * 每个 Storage root 一个实例，避免跨数据目录串用令牌；桌面使用
 * `safeStorage` 支撑的 `Storage.vault`，浏览器预览退化为内存保管库。
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
      // 桌面 IPC 请求上限为 120s；授权会话必须在此之前结束并给出明确状态。
      timeoutMs: 110_000,
    });
    currentRoot = s.root;
  }
  return current;
}

/** 释放 broker；进程退出或测试清理时调用。 */
export function disposeCloudBroker(): void {
  current?.dispose();
  current = undefined;
  currentRoot = undefined;
}
