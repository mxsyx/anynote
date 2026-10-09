import { createHash } from "node:crypto";
import { parseRetryAfter } from "./policy.js";
import type { BackupTarget, Credentials } from "@anynote/types/runtime.js";

/**
 * Compute the SHA-256 hex digest of a byte sequence.
 *
 * @param bytes Source bytes to hash.
 * @returns Lowercase hex digest.
 */
export const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Read a response body with a maximum byte limit and optional cancellation.
 *
 * @param r Response whose body is read.
 * @param maxBytes Maximum number of bytes to read.
 * @param signal Optional abort signal.
 * @returns Concatenated body bytes.
 */
async function boundedBody(
  r: Response,
  maxBytes: number,
  signal?: AbortSignal,
) {
  const reader = r.body?.getReader();
  if (!reader) throw Error("远端对象缺少响应体");
  try {
    if (Number(r.headers.get("content-length")) > maxBytes)
      throw Error("对象超过下载预算");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw Error("对象超过下载预算");
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Client for the Cloudflare Worker backup service. */
export class CloudflareClient {
  url: string;
  token: string;

  constructor(
    config: Pick<BackupTarget, "endpoint"> & Partial<BackupTarget>,
    secrets: Credentials,
  ) {
    this.url = config.endpoint.replace(/\/$/, "");
    this.token = secrets.token!;
  }

  /**
   * Issue one JSON/byte request, parsing the server error message on failure.
   *
   * @param path Request path.
   * @param options Request options (method, body, bytes, abort signal).
   * @returns Parsed JSON response.
   */
  async call(
    path: string,
    {
      method = "GET",
      body,
      bytes,
      signal,
    }: {
      method?: string;
      body?: unknown;
      bytes?: Uint8Array;
      signal?: AbortSignal;
    } = {},
  ) {
    const r = await fetch(this.url + path, {
      method,
      headers: {
        Authorization: "Bearer " + this.token,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body:
        (bytes as BodyInit | undefined) ||
        (body ? JSON.stringify(body) : undefined),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
        : AbortSignal.timeout(60000),
    });
    if (!r.ok) {
      let message;
      try {
        message = JSON.parse(
          (await boundedBody(r, 65536, signal)).toString(),
        ).error;
      } catch {}
      // Honor a server-provided Retry-After so throttling is deferred per the
      // design's "限流按服务返回的重试信息延后".
      throw Object.assign(Error(message || "备份服务返回 HTTP " + r.status), {
        status: r.status,
        retryAfterMs: parseRetryAfter(
          r.headers.get("retry-after") ?? undefined,
        ),
      });
    }
    return JSON.parse((await boundedBody(r, 5 * 1024 ** 2, signal)).toString());
  }

  /**
   * Upload one object.
   *
   * @param path Object path.
   * @param bytes Object contents.
   * @param signal Optional abort signal.
   * @returns Response from the upload call.
   */
  async uploadObject(path: string, bytes: Uint8Array, signal?: AbortSignal) {
    return this.call(path, { method: "PUT", bytes, signal });
  }

  /**
   * Download one object with a maximum byte limit.
   *
   * @param path Object path.
   * @param options Download options (max bytes and abort signal).
   * @returns Object bytes.
   */
  async downloadObject(
    path: string,
    {
      maxBytes = 100 * 1024 ** 2,
      signal,
    }: { maxBytes?: number; signal?: AbortSignal } = {},
  ) {
    const r = await fetch(this.url + path, {
      headers: { Authorization: "Bearer " + this.token },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
        : AbortSignal.timeout(60000),
    });
    if (!r.ok) {
      await r.body?.cancel();
      throw Error("远端对象下载失败");
    }
    return boundedBody(r, maxBytes, signal);
  }
}
