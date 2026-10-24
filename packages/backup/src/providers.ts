import type { TransferSession, MultipartProgress } from "./transfer-session.js";
import { multipartPartBytes } from "@anynote/protocol/cloud-objects.js";
import { createHash } from "node:crypto";
import { parseRetryAfter } from "./policy.js";
import type { BackupTarget, Credentials } from "@anynote/types/runtime.js";
import type { ScopedReadSource } from "@anynote/protocol/file-source.js";
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
    session?: TransferSession,
    hash = "",
  ) {
    const key = "upload.parts." + hash;
    let reported = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      let saved = session?.read<MultipartProgress>(key);
      if (!saved) {
        const { uploadId } = await this.call(path + "/multipart", {
          method: "POST",
          signal,
        });
        saved = { uploadId, parts: [] };
        session?.write(key, saved);
      }
      const { uploadId } = saved;
      const parts: MultipartProgress["parts"] = [];
      try {
        const partBytes = multipartPartBytes;
        for (let offset = 0; offset < source.size; offset += partBytes) {
          signal.throwIfAborted();
          const bytes = await source.read(
            offset,
            Math.min(partBytes, source.size - offset),
          );
          if (bytes.length !== Math.min(partBytes, source.size - offset))
            throw Error("附件读取不完整");
          const prior = saved.parts[parts.length];
          const sha256 = digest(bytes);
          if (
            prior &&
            (prior.partNumber !== parts.length + 1 || prior.sha256 !== sha256)
          )
            throw Error("备份源切点改变，无法复用上传片段");
          const part =
            prior ||
            (await this.call(
              path +
                `/multipart/${encodeURIComponent(uploadId)}/${parts.length + 1}`,
              { method: "PUT", bytes, signal, timeoutMs: 30 * 60000 },
            ));
          parts.push({ ...part, sha256 });
          if (!prior) {
            saved.parts.push(parts.at(-1)!);
            session?.write(key, saved);
          }
          const completed = offset + bytes.length;
          if (completed > reported) onBytes(completed - reported);
          reported = Math.max(reported, completed);
        }
        signal.throwIfAborted();
        await this.call(path + `/multipart/${encodeURIComponent(uploadId)}`, {
          method: "POST",
          body: { parts },
          signal,
          timeoutMs: 30 * 60000,
        });
        return;
      } catch (error) {
        // Durable tasks keep acknowledged parts on interruption and cancellation.
        // Stateless callers still abort immediately; registered abandoned sessions are reclaimable.
        if (!session)
          await this.call(path + `/multipart/${encodeURIComponent(uploadId)}`, {
            method: "DELETE",
          }).catch(() => {});
        else if (
          error instanceof Error &&
          error.message === "UPLOAD_SESSION_MISSING"
        )
          session.write(key, null);
        if (
          session &&
          error instanceof Error &&
          error.message === "UPLOAD_SESSION_MISSING" &&
          attempt === 0
        )
          continue;
        throw error;
      }
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
      range,
    }: {
      maxBytes?: number;
      signal?: AbortSignal;
      range?: { offset: number; size: number; total: number };
    } = {},
  ) {
    const r = await fetch(this.url + path, {
      headers: {
        Authorization: "Bearer " + this.token,
        ...(range
          ? { Range: `bytes=${range.offset}-${range.offset + range.size - 1}` }
          : {}),
      },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
        : AbortSignal.timeout(60000),
    });
    if (!r.ok) {
      await r.body?.cancel();
      throw Error("远端对象下载失败");
    }
    if (
      range &&
      (r.status !== 206 ||
        r.headers.get("content-range") !==
          `bytes ${range.offset}-${range.offset + range.size - 1}/${range.total}`)
    ) {
      await r.body?.cancel();
      throw Error("远端附件范围响应无效");
    }
    return boundedBody(r, maxBytes, signal);
  }
}
