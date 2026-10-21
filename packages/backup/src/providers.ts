import { multipartPartBytes } from "@anynote/protocol/cloud-objects.js";
import { createHash } from "node:crypto";
import { parseRetryAfter } from "./policy.js";
import type { BackupTarget, Credentials } from "@anynote/types/runtime.js";
import type { ScopedReadSource } from "@anynote/types/cloud-backup.js";
import { mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";

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
      timeoutMs = 60000,
    }: {
      method?: string;
      body?: unknown;
      bytes?: Uint8Array;
      signal?: AbortSignal;
      timeoutMs?: number;
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
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) {
      let message;
      try {
        message = JSON.parse(
          (await boundedBody(r, 65536, signal)).toString(),
        ).error;
      } catch {}
      // Honor a server-provided Retry-After so throttling is deferred per the
      // Design: "throttling is deferred based on the retry info returned by the service".
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

  /** Multipart is a transport detail; the committed resource remains one hash-addressed file. */
  async uploadFile(
    path: string,
    source: ScopedReadSource,
    signal: AbortSignal,
    onBytes: (n: number) => void = () => {},
  ) {
    const { uploadId } = await this.call(path + "/multipart", {
      method: "POST",
      signal,
    });
    const parts = [];
    try {
      const partBytes = multipartPartBytes;
      for (let offset = 0; offset < source.size; offset += partBytes) {
        const bytes = await source.read(
          offset,
          Math.min(partBytes, source.size - offset),
        );
        if (bytes.length !== Math.min(partBytes, source.size - offset))
          throw Error("附件读取不完整");
        const part = await this.call(
          path +
            `/multipart/${encodeURIComponent(uploadId)}/${parts.length + 1}`,
          { method: "PUT", bytes, signal, timeoutMs: 30 * 60000 },
        );
        parts.push(part);
        onBytes(bytes.length);
      }
      await this.call(path + `/multipart/${encodeURIComponent(uploadId)}`, {
        method: "POST",
        body: { parts },
        signal,
        timeoutMs: 30 * 60000,
      });
    } catch (error) {
      await this.call(path + `/multipart/${encodeURIComponent(uploadId)}`, {
        method: "DELETE",
      }).catch(() => {});
      throw error;
    }
  }

  async downloadFile(
    path: string,
    file: string,
    expected: { size: number; sha256: string },
    signal: AbortSignal,
    onBytes: (n: number) => void,
  ) {
    const response = await fetch(this.url + path, {
      headers: { Authorization: "Bearer " + this.token },
      signal,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw Error("远端附件下载失败");
    }
    const reader = response.body.getReader(),
      hash = createHash("sha256");
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let size = 0,
      success = false;
    try {
      await mkdir(dirname(file), { recursive: true });
      handle = await open(file, "wx", 0o600);
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > expected.size) throw Error("附件超过清单预算");
        hash.update(value);
        await handle.writeFile(value);
        onBytes(value.length);
      }
      if (size !== expected.size || hash.digest("hex") !== expected.sha256)
        throw Error("附件 SHA-256 校验失败");
      await handle.sync();
      success = true;
    } finally {
      await handle?.close();
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      if (handle && !success) await unlink(file);
    }
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
