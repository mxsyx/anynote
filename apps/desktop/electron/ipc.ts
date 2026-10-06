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

/** One request awaiting a response (with timeout timer). */
export interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
