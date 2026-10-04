import type { Credentials } from "@anynote/types/runtime.js";
export interface StorageRequest {
  type?: never;
  id: number;
  op: string;
  input: Record<string, unknown>;
}
export interface StorageResponse {
  type?: never;
  id: number;
  result?: unknown;
  error?: string;
}
export interface SecretRequest {
  type: "secret";
  id: number;
  op: "set" | "get";
  secretId: string;
  value?: Credentials;
}
export interface SecretResponse {
  type: "secret-response";
  id: number;
  result?: unknown;
  error?: string;
}
export interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
