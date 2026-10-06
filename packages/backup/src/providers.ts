import { withS3Activity, readControl } from "./s3-control.js";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { unzipSync, zipSync } from "fflate";
import { createHash } from "node:crypto";
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

/** Accessor for S3-compatible object storage (put/get/list, etc.). */
export class S3Objects {
  bucket: string;
  prefix: string;
  client: S3Client;

  constructor(
    config: Pick<BackupTarget, "endpoint"> & Partial<BackupTarget>,
    credentials: Credentials,
  ) {
    this.bucket = config.bucket!;
    this.prefix = config.prefix || "anynote";
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region || "us-east-1",
      forcePathStyle: config.pathStyle !== false,
      credentials: {
        accessKeyId: credentials.accessKeyId!,
        secretAccessKey: credentials.secretAccessKey!,
        ...(credentials.sessionToken
          ? { sessionToken: credentials.sessionToken }
          : {}),
      },
    });
  }

  /**
   * Join a logical key into a full object key (with prefix).
   *
   * @param key Logical key.
   * @returns Prefixed object key.
   */
  key(key: string) {
    return `${this.prefix}/${key}`;
  }

  /**
   * Upload an object.
   *
   * @param key Logical object key.
   * @param bytes Object contents.
   * @param signal Optional abort signal.
   */
  async put(key: string, bytes: Uint8Array, signal?: AbortSignal) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(key),
        Body: bytes,
        ContentType: "application/octet-stream",
      }),
      { abortSignal: signal },
    );
  }

  /**
   * Delete an object.
   *
   * @param key Logical object key.
   */
  async delete(key: string) {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
    );
  }

  /**
   * Download an object with a maximum byte limit.
   *
   * @param key Logical object key.
   * @param options Download options (max bytes and abort signal).
   * @returns Object bytes.
   */
  async get(
    key: string,
    {
      maxBytes = 100 * 1024 ** 2,
      signal,
    }: { maxBytes?: number; signal?: AbortSignal } = {},
  ) {
    const r = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
      { abortSignal: signal },
    );
    const body = r.Body as import("node:stream").Readable | undefined;
    if (!body) throw Error("远端对象缺少响应体");
    try {
      if (Number(r.ContentLength) > maxBytes)
        throw Error("远端对象超过下载预算");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const part of body) {
        signal?.throwIfAborted();
        size += part.length;
        if (size > maxBytes) throw Error("远端对象超过下载预算");
        chunks.push(Buffer.from(part));
      }
      return Buffer.concat(chunks, size);
    } finally {
      body.destroy();
    }
  }

  /**
   * Whether an object exists (404 returns false).
   *
   * @param key Logical object key.
   * @param signal Optional abort signal.
   * @returns True when the object exists.
   */
  async has(key: string, signal?: AbortSignal) {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
        { abortSignal: signal },
      );
      return true;
    } catch (e: any) {
      if (
        e.$metadata?.httpStatusCode === 404 ||
        e.name === "NotFound" ||
        e.name === "NoSuchKey"
      )
        return false;
      throw e;
    }
  }

  /**
   * List one page of objects (up to 1000), returning entries and the next cursor.
   *
   * @param prefix Key prefix to list.
   * @param token Continuation token for the next page.
   * @returns Page items and the next continuation token, if any.
   */
  async listPage(prefix: string, token?: string) {
    const response = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.key(prefix),
        ContinuationToken: token,
        MaxKeys: 1000,
      }),
    );
    if (response.IsTruncated && !response.NextContinuationToken)
      throw Error("远端分页响应无效");
    return {
      items: (response.Contents || []).map((i) => ({
        key: i.Key!.slice(this.prefix.length + 1),
        date: i.LastModified?.getTime() || 0,
      })),
      next: response.IsTruncated ? response.NextContinuationToken : undefined,
    };
  }

  /**
   * List all objects under a prefix (up to 100 pages; throws when exceeded).
   *
   * @param prefix Key prefix to list.
   * @returns Every matching object entry.
   */
  async list(prefix: string) {
    const items = [];
    let token: string | undefined;
    for (let i = 0; i < 100; i++) {
      const response: import("@aws-sdk/client-s3").ListObjectsV2CommandOutput =
        await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: this.key(prefix),
            ContinuationToken: token,
          }),
        );
      items.push(
        ...(response.Contents || []).map((i) => ({
          key: i.Key!.slice(this.prefix.length + 1),
          date: i.LastModified?.getTime() || 0,
        })),
      );
      if (!response.IsTruncated) return items;
      token = response.NextContinuationToken;
    }
    throw Error("远端版本数量超过列举预算");
  }
}

/**
 * Upload a consistent snapshot: dedupe assets by hash, write the version manifest, and commit a marker.
 *
 * @param objects S3 accessor.
 * @param bundle Zipped snapshot bundle.
 * @param options Snapshot identity, progress callback, and abort signal.
 * @returns Commit result with generation id, snapshot seq, and manifest key.
 */
async function uploadSnapshotCore(
  objects: S3Objects,
  bundle: Buffer,
  {
    notebookId,
    lineageId,
    generationId,
    progress = () => {},
    signal,
  }: {
    notebookId: string;
    lineageId: string;
    generationId: string;
    progress?: (message: string) => void;
    signal?: AbortSignal;
  },
) {
  const files = unzipSync(bundle),
    manifest = JSON.parse(Buffer.from(files["manifest.json"]).toString()),
    base = `${notebookId}/${lineageId}`;
  const uploaded = [];
  for (const object of [manifest.database, ...manifest.assets]) {
    signal?.throwIfAborted();
    const key =
        object.path === "notebook.sqlite"
          ? `${base}/databases/${object.sha256}.sqlite`
          : `${base}/objects/sha256/${object.sha256}`,
      bytes = Buffer.from(files[object.path]);
    progress("正在验证并上传 " + object.path);
    let valid = false;
    if (await objects.has(key))
      valid = digest(await objects.get(key)) === object.sha256;
    if (!valid) {
      await objects.put(key, bytes);
      if (digest(await objects.get(key)) !== object.sha256)
        throw Error("上传对象 SHA-256 校验失败");
      uploaded.push(key);
    }
    object.key = key;
  }
  const saved = {
      ...manifest,
      protocolVersion: 1,
      provider: "s3",
      lineageId,
      generationId,
    },
    body = Buffer.from(JSON.stringify(saved)),
    manifestKey = `${base}/generations/${generationId}/manifest.json`;
  await objects.put(manifestKey, body);
  if (digest(await objects.get(manifestKey)) !== digest(body))
    throw Error("manifest 校验失败");
  signal?.throwIfAborted();
  progress("正在提交远端版本");
  const markerKey = `${base}/generations/${generationId}/COMMITTED.json`,
    marker = Buffer.from(
      JSON.stringify({
        manifestKey,
        manifestHash: digest(body),
        generationId,
        snapshotSeq: manifest.snapshotSeq,
        createdAt: manifest.createdAt,
      }),
    );
  await objects.put(markerKey, marker);
  if (digest(await objects.get(markerKey)) !== digest(marker))
    throw Error("提交记录校验失败");
  return {
    generationId,
    snapshotSeq: manifest.snapshotSeq,
    uploaded: uploaded.length,
    manifestKey,
  };
}

/**
 * List remote restorable committed versions, skipping retired and non-branch versions.
 *
 * @param objects S3 accessor.
 * @param notebookId Notebook ID.
 * @param lineageId Lineage ID.
 * @returns Restorable committed versions.
 */
export async function listSnapshots(
  objects: S3Objects,
  notebookId: string,
  lineageId: string,
) {
  const control = objects.client
    ? (await readControl(objects, `${notebookId}/${lineageId}`))?.value
    : undefined;
  const retired = control?.retired ?? [];
  const items = await objects.list(`${notebookId}/${lineageId}/generations/`),
    result = [];
  for (const item of items
    .filter((i) => i.key.endsWith("/COMMITTED.json"))
    .sort((a, b) => b.date - a.date)
    .slice(0, 100)) {
    if (
      retired.includes(item.key.split("/").at(-2)!) ||
      (control && !control.committed.includes(item.key.split("/").at(-2)!))
    )
      continue;
    const marker = JSON.parse((await objects.get(item.key)).toString()),
      manifest = await objects.get(marker.manifestKey);
    if (digest(manifest) !== marker.manifestHash) continue;
    const m = JSON.parse(manifest.toString());
    if (
      m.notebookId !== notebookId ||
      m.lineageId !== lineageId ||
      m.generationId !== marker.generationId
    )
      continue;
    result.push({
      id: m.generationId,
      createdAt: m.createdAt,
      snapshotSeq: m.snapshotSeq,
      assets: m.assets.length,
    });
  }
  return result;
}

/**
 * Download and verify one version's manifest and objects, reassembling them into an archive bundle.
 *
 * @param objects S3 accessor.
 * @param options Version identity (notebook, lineage, generation).
 * @returns Zipped snapshot bundle.
 */
async function restoreSnapshotCore(
  objects: S3Objects,
  {
    notebookId,
    lineageId,
    generationId,
  }: { notebookId: string; lineageId: string; generationId: string },
) {
  if (!/^[a-f0-9-]{36}$/i.test(generationId)) throw Error("无效备份版本");
  const base = `${notebookId}/${lineageId}`,
    marker = JSON.parse(
      (
        await objects.get(`${base}/generations/${generationId}/COMMITTED.json`)
      ).toString(),
    ),
    body = await objects.get(marker.manifestKey);
  if (digest(body) !== marker.manifestHash)
    throw Error("恢复 manifest 校验失败");
  const m = JSON.parse(body.toString());
  if (
    m.notebookId !== notebookId ||
    m.lineageId !== lineageId ||
    m.generationId !== generationId ||
    m.format !== "anynote.notebook"
  )
    throw Error("备份身份不匹配");
  const files: Record<string, Uint8Array> = {};
  let total = 0;
  for (const object of [m.database, ...m.assets]) {
    if (
      !/^(notebook\.sqlite|assets\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.bin)$/.test(
        object.path,
      ) ||
      !object.key.startsWith(base + "/")
    )
      throw Error("远端资源路径无效");
    const bytes = await objects.get(object.key);
    total += bytes.length;
    if (
      total > 100 * 1024 * 1024 ||
      bytes.length !== object.size ||
      digest(bytes) !== object.sha256
    )
      throw Error("恢复对象校验失败");
    files[object.path] = bytes;
  }
  files["manifest.json"] = Buffer.from(JSON.stringify(m));
  return Buffer.from(zipSync(files));
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
      throw Object.assign(Error(message || "备份服务返回 HTTP " + r.status), {
        status: r.status,
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

/**
 * S3 snapshot upload that registers writer activity.
 *
 * @param args Arguments forwarded to {@link uploadSnapshotCore}.
 * @returns Commit result of the snapshot upload.
 */
export function uploadSnapshot(...args: Parameters<typeof uploadSnapshotCore>) {
  return withS3Activity(
    args[0],
    `${args[2].notebookId}/${args[2].lineageId}`,
    "writer",
    args[2].generationId,
    () => uploadSnapshotCore(...args),
  );
}

/**
 * S3 snapshot restore that registers reader activity.
 *
 * @param args Arguments forwarded to {@link restoreSnapshotCore}.
 * @returns Zipped snapshot bundle.
 */
export function restoreSnapshot(
  ...args: Parameters<typeof restoreSnapshotCore>
) {
  return withS3Activity(
    args[0],
    `${args[1].notebookId}/${args[1].lineageId}`,
    "reader",
    args[1].generationId,
    () => restoreSnapshotCore(...args),
  );
}
