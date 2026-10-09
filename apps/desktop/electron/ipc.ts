import type { Credentials } from "@anynote/types/runtime.js";

/** Request sent from the main process to the storage process. */
export interface StorageRequest {
  type?: never;
  id: number;
  op: string;
  input: Record<string, unknown>;
}

/** Response returned by the storage process. */
export interface StorageResponse {
  type?: never;
  id: number;
  result?: unknown;
  error?: string;
}

/** System credential request forwarded from the storage process to the main process. */
export interface SecretRequest {
  type: "secret";
  id: number;
  op: "set" | "get";
  secretId: string;
  value?: Credentials;
}

/** System credential response returned from the main process to the storage process. */
export interface SecretResponse {
  type: "secret-response";
  id: number;
  result?: unknown;
  error?: string;
}

/** Host environment update pushed from the main process into the storage process. */
export interface EnvironmentReport {
  type: "environment";
  /** Whether the device is currently running on battery power. */
  onBattery: boolean;
}

/**
 * Request to open a URL in the system browser.
 *
 * OAuth 授权页必须由系统浏览器承载：厂商页面不进入带 preload 或 Node 权限的
 * Electron WebView（设计 §6.1）。回环回调由存储进程自己监听，主进程只负责
 * 唤起浏览器并返回结果。
 */
export interface OpenExternalRequest {
  type: "open-external";
  id: number;
  url: string;
}

/** Result of an `open-external` request. */
export interface OpenExternalResponse {
  type: "open-external-response";
  id: number;
  result?: boolean;
  error?: string;
}

/** One request awaiting a response (with timeout timer). */
export interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
