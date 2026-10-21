import type { uploadSessions } from "./upload-sessions.js";
import { missingUpload } from "./upload-sessions.js";
import { multipartPartBytes } from "@anynote/protocol/cloud-objects.js";
import type { R2Bucket, R2UploadedPart } from "@cloudflare/workers-types";

const partBytes = multipartPartBytes;

/** Assemble transport parts privately, verify the whole file, then publish immutable content.
 * A failed or interrupted upload cannot replace a file referenced by an existing backup.
 */
export async function multipart(
  request: Request,
  bucket: R2Bucket,
  key: string,
  staging: string,
  expected: { hash: string; size: number },
  token?: string,
  partNumber?: number,
  sessions?: ReturnType<typeof uploadSessions>,
) {
  if (!token && request.method === "POST") {
    const nonce = crypto.randomUUID();
    const upload = await bucket.createMultipartUpload(`${staging}/${nonce}`);
    await sessions?.created(upload, `${staging}/${nonce}`);
    return { uploadId: `${nonce}:${upload.uploadId}` };
  }
  const split = token?.indexOf(":") ?? -1;
  if (split !== 36 || !/^[a-f0-9-]{36}$/.test(token!.slice(0, split)))
    throw Error("上传会话无效");
  const temp = `${staging}/${token!.slice(0, split)}`;
  const id = token!.slice(split + 1);
  if (sessions && !(await sessions.exists(id, temp)))
    throw Error("UPLOAD_SESSION_MISSING");
  const upload = bucket.resumeMultipartUpload(temp, id);
  const resume = async <T>(action: () => Promise<T>) => {
    try {
      return await action();
    } catch (error) {
      if (missingUpload(error)) {
        await sessions?.removed(id);
        throw Error("UPLOAD_SESSION_MISSING");
      }
      throw error;
    }
  };
  if (request.method === "DELETE") {
    await upload.abort();
    await bucket.delete(temp);
    await sessions?.removed(id);
    return { aborted: true };
  }
  if (request.method === "PUT" && partNumber) {
    const size = Math.min(
      partBytes,
      expected.size - (partNumber - 1) * partBytes,
    );
    if (
      !Number.isSafeInteger(partNumber) ||
      partNumber < 1 ||
      size <= 0 ||
      Number(request.headers.get("content-length")) > partBytes
    )
      throw Error("传输片段无效");
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength !== size) throw Error("传输片段大小不匹配");
    return resume(() => upload.uploadPart(partNumber, bytes));
  }
  if (request.method !== "POST" || partNumber) throw Error("上传操作无效");
  const text = await request.text();
  if (text.length > 1024 ** 2) throw Error("上传片段清单超限");
  const { parts } = JSON.parse(text) as { parts: R2UploadedPart[] };
  if (
    !Array.isArray(parts) ||
    parts.length !== Math.ceil(expected.size / partBytes) ||
    parts.some((p, i) => p.partNumber !== i + 1 || typeof p.etag !== "string")
  )
    throw Error("上传片段清单无效");
  if (!(await bucket.head(temp))) await resume(() => upload.complete(parts));
  let discard = false;
  try {
    const object = await bucket.get(temp);
    if (!object || object.size !== expected.size) throw Error("附件大小不匹配");
    const hasher = new (
      crypto as unknown as {
        DigestStream: new (
          algorithm: string,
        ) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> };
      }
    ).DigestStream("SHA-256");
    await (object.body as unknown as ReadableStream<Uint8Array>).pipeTo(hasher);
    const hash = Array.from(new Uint8Array(await hasher.digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    if (hash !== expected.hash) {
      discard = true;
      throw Error("附件 SHA-256 校验失败");
    }
    // R2 single puts have a size limit; use multipart for the verified server-side copy too.
    const published = await bucket.createMultipartUpload(key);
    await sessions?.created(published, key);
    try {
      const copied = [];
      // Stream larger copy parts to bound storage subrequests for a 20GiB file without buffering them.
      const copyBytes = partBytes * 2;
      for (let offset = 0; offset < expected.size; offset += copyBytes) {
        const part = await bucket.get(temp, {
          range: {
            offset,
            length: Math.min(copyBytes, expected.size - offset),
          },
        });
        if (!part) throw Error("附件临时对象缺失");
        copied.push(await published.uploadPart(copied.length + 1, part.body));
      }
      await published.complete(copied);
      await sessions?.removed(published.uploadId);
    } catch (error) {
      try {
        await published.abort();
        await sessions?.removed(published.uploadId);
      } catch {}
      throw error;
    }
    discard = true;
    return { verified: true };
  } finally {
    if (discard) {
      await bucket.delete(temp);
      await sessions?.removed(id);
    }
  }
}
