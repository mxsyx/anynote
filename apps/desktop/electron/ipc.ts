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
 * The OAuth authorization page must be hosted by the system browser: vendor pages never enter an
 * Electron WebView with preload or Node privileges (design §6.1). The loopback callback is handled by the storage process itself; the main process only
 * launches the browser and returns the result.
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
