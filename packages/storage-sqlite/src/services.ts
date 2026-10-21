import type { Storage } from "./index.js";

/** An unhandled operation has no result; handled results require validation by consumers. */
export type OperationResult =
  | { handled: false }
  | { handled: true; result: unknown };

/** Trusted host services are injected per Storage instance, never registered globally. */
export interface ServiceOperation {
  run(storage: Storage, input: unknown): unknown | Promise<unknown>;
  /** Read/network operations may bypass the queue; snapshot captures must remain queued. */
  concurrent?: boolean;
}

export interface StorageOptions {
  maxWriteConnections?: number;
  maxReadConnections?: number;
  services?: Readonly<Record<string, ServiceOperation>>;
}
