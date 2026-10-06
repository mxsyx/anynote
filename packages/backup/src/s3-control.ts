import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  GetBucketVersioningCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import type { S3Objects } from "./providers.js";

/** S3 maintenance control record (active writers/readers, retired and committed versions, cleanup plan). */
export interface S3Control {
  version: 1;
  revision: number;
  writers: { id: string; generationId: string }[];
  readers: { id: string; generationId: string }[];
  retired: string[];
  committed: string[];
  plan?: S3Plan;
}

/** One S3 remote cleanup plan. */
export interface S3Plan {
  id: string;
  status: "planned" | "deleting" | "completed";
  created: number;
  revision: number;
  keep: number;
  calendar: { dailyDays: number; weeklyWeeks: number; monthlyMonths: number };
  referenceTime: string;
  remove: { id: string; createdAt: string }[];
  protected: string[];
  objects: { key: string; versionId: string; size: number }[];
  sampled: { id: string; reasons: string[] }[];
  reclaimBytes: number;
  graceHours: number;
  cursor: number;
}

/**
 * Whether an error means the object is missing.
 *
 * @param e Error to inspect.
 * @returns True when the error indicates a missing object.
 */
const missing = (e: any) =>
  e.$metadata?.httpStatusCode === 404 ||
  ["NoSuchKey", "NotFound"].includes(e.name);

/**
 * Whether an error is a conditional-write conflict.
 *
 * @param e Error to inspect.
 * @returns True when the error indicates a conflict.
 */
export const conflict = (e: any) =>
  [409, 412].includes(e.$metadata?.httpStatusCode);

/**
 * Object key for the maintenance control data.
 *
 * @param base Base prefix.
 * @returns Full control object key.
 */
const key = (base: string) => `${base}/maintenance/control.json`;

/**
 * Read and strictly validate the S3 maintenance control record (returns `null` when absent).
 *
 * @param objects S3 accessor.
 * @param base Base prefix.
 * @returns Control value with its etag, or `null`.
 */
export async function readControl(
  objects: S3Objects,
  base: string,
): Promise<{ value: S3Control; etag: string } | null> {
  try {
    const r = await objects.client.send(
      new GetObjectCommand({
        Bucket: objects.bucket,
        Key: objects.key(key(base)),
      }),
    );
    if (!r.ETag || !r.Body || (r.ContentLength ?? 0) > 256 * 1024)
      throw Error("S3 维护控制数据无效或超过预算");
    const chunks: Buffer[] = [];
    let size = 0;
    const body = r.Body as import("node:stream").Readable;
    try {
      for await (const c of body) {
        size += c.length;
        if (size > 256 * 1024) throw Error("S3 维护控制数据超过预算");
        chunks.push(Buffer.from(c));
      }
    } finally {
      body.destroy();
    }
    const id = z.string().uuid(),
      list = z.array(id).max(2000);
    const plan = z
      .object({
        id,
        status: z.enum(["planned", "deleting", "completed"]),
        created: z.number().int().nonnegative(),
        revision: z.number().int().nonnegative(),
        keep: z.number().int().min(1).max(1000),
        calendar: z
          .object({
            dailyDays: z.number().int().min(0).max(365),
            weeklyWeeks: z.number().int().min(0).max(104),
            monthlyMonths: z.number().int().min(0).max(120),
          })
          .strict(),
        referenceTime: z.string().datetime(),
        remove: z
          .array(z.object({ id, createdAt: z.string().datetime() }).strict())
          .max(200),
        protected: list,
        objects: z
          .array(
            z
              .object({
                key: z.string().max(1000),
                versionId: z
                  .string()
                  .min(1)
                  .max(1024)
                  .refine((v) => v !== "null"),
                size: z.number().int().nonnegative(),
              })
              .strict(),
          )
          .max(1000),
        sampled: z
          .array(
            z
              .object({ id, reasons: z.array(z.string().max(20)).max(5) })
              .strict(),
          )
          .max(200),
        reclaimBytes: z.number().int().nonnegative(),
        graceHours: z.literal(24),
        cursor: z.number().int().min(0).max(1000),
      })
      .strict();
    const value = z
      .object({
        version: z.literal(1),
        revision: z.number().int().nonnegative(),
        writers: z.array(z.object({ id, generationId: id }).strict()).max(64),
        readers: z.array(z.object({ id, generationId: id }).strict()).max(64),
        retired: list,
        committed: list,
        plan: plan.optional(),
      })
      .strict()
      .parse(JSON.parse(Buffer.concat(chunks).toString())) as S3Control;
    if (value.plan) {
      const p = value.plan;
      const scope = new RegExp(
        "^" +
          base +
          "/(objects/sha256/[a-f0-9]{64}|databases/[a-f0-9]{64}\\.sqlite|generations/[a-f0-9-]{36}/(manifest|COMMITTED)\\.json)$",
      );
      if (
        p.cursor > p.objects.length ||
        p.objects.some((v) => !scope.test(v.key)) ||
        p.remove.some((v) => p.protected.includes(v.id))
      )
        throw Error("S3 清理计划范围无效");
    }
    return { value, etag: r.ETag };
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}

/**
 * Conditionally write the maintenance control record (by etag, or requiring creation).
 *
 * @param objects S3 accessor.
 * @param base Base prefix.
 * @param value Control record to persist.
 * @param etag Expected etag for the conditional write.
 */
export async function saveControl(
  objects: S3Objects,
  base: string,
  value: S3Control,
  etag?: string,
) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > 256 * 1024) throw Error("S3 维护控制数据超过预算");
  await objects.client.send(
    new PutObjectCommand({
      Bucket: objects.bucket,
      Key: objects.key(key(base)),
      Body: body,
      ContentType: "application/json",
      ...(etag ? { IfMatch: etag } : { IfNoneMatch: "*" }),
    }),
  );
}

/**
 * Mutate the maintenance control record in a read-modify-write loop, retrying on conflict.
 *
 * @param objects S3 accessor.
 * @param base Base prefix.
 * @param fn Mutation function applied to the current control record.
 * @returns Result of the mutation function.
 */
export async function mutateControl<T>(
  objects: S3Objects,
  base: string,
  fn: (c: S3Control) => T,
): Promise<T> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const current = await readControl(objects, base);
    if (!current) throw Error("S3 维护控制记录缺失");
    const result = fn(current.value);
    current.value.revision++;
    try {
      await saveControl(objects, base, current.value, current.etag);
      return result;
    } catch (e) {
      if (!conflict(e)) throw e;
    }
  }
  throw Error("S3 维护并发冲突，请重试");
}

/**
 * Probe bucket versioning and conditional-write support, initializing the control record on first success.
 *
 * @param objects S3 accessor.
 * @param base Base prefix.
 */
export async function activateControl(objects: S3Objects, base: string) {
  const bucket = await objects.client.send(
    new GetBucketVersioningCommand({ Bucket: objects.bucket }),
  );
  if (bucket.Status !== "Enabled")
    throw Error("S3 远端清理需要已启用的桶版本管理；应用不会自动改变桶设置");
  // Only probe with random private keys; never test preconditions against user data.
  const probe = `${base}/maintenance/probe-${randomUUID()}`;
  const versions: string[] = [];
  try {
    const first = await objects.client.send(
      new PutObjectCommand({
        Bucket: objects.bucket,
        Key: objects.key(probe),
        Body: Buffer.from("first"),
        IfNoneMatch: "*",
      }),
    );
    if (!first.VersionId || first.VersionId === "null" || !first.ETag)
      throw Error("S3 未返回有效对象版本，不能安全清理");
    versions.push(first.VersionId);
    for (const condition of [
      { IfNoneMatch: "*" },
      { IfMatch: '"anynote-impossible-etag"' },
    ]) {
      let rejected = false;
      try {
        const r = await objects.client.send(
          new PutObjectCommand({
            Bucket: objects.bucket,
            Key: objects.key(probe),
            Body: Buffer.from("must-not-write"),
            ...condition,
          }),
        );
        if (r.VersionId) versions.push(r.VersionId);
      } catch (e) {
        if (!conflict(e)) throw e;
        rejected = true;
      }
      if (!rejected) throw Error("S3 服务未遵守条件写入，拒绝启用远端清理");
    }
    const next = await objects.client.send(
      new PutObjectCommand({
        Bucket: objects.bucket,
        Key: objects.key(probe),
        Body: Buffer.from("second"),
        IfMatch: first.ETag,
      }),
    );
    if (
      !next.VersionId ||
      next.VersionId === "null" ||
      next.VersionId === first.VersionId
    )
      throw Error("S3 对象版本能力无效");
    versions.push(next.VersionId);
    await objects.client.send(
      new DeleteObjectCommand({
        Bucket: objects.bucket,
        Key: objects.key(probe),
        VersionId: first.VersionId,
      }),
    );
    const latest = await objects.get(probe, { maxBytes: 64 });
    if (latest.toString() !== "second")
      throw Error("S3 版本删除影响了新版本，拒绝启用清理");
  } finally {
    for (const version of versions)
      await objects.client.send(
        new DeleteObjectCommand({
          Bucket: objects.bucket,
          Key: objects.key(probe),
          VersionId: version,
        }),
      );
  }
  if (!(await readControl(objects, base))) {
    const existing = await objects.list(base + "/generations/");
    const committed = existing
      .filter((v) => v.key.endsWith("/COMMITTED.json"))
      .map((v) => v.key.split("/").at(-2)!);
    if (
      committed.length > 200 ||
      committed.some((v) => !/^[a-f0-9-]{36}$/i.test(v))
    )
      throw Error("S3 已提交版本身份或数量无效");
    try {
      await saveControl(objects, base, {
        version: 1,
        revision: 0,
        writers: [],
        readers: [],
        retired: [],
        committed,
      });
    } catch (e) {
      if (!conflict(e)) throw e;
    }
  }
}

/**
 * Register active writers/readers in the control record, revoking and committing when done.
 *
 * @param objects S3 accessor.
 * @param base Base prefix.
 * @param kind Activity kind (writer or reader).
 * @param generationId Generation ID the activity belongs to.
 * @param fn Operation to run while the activity is registered.
 * @returns Result of the wrapped operation.
 */
export async function withS3Activity<T>(
  objects: S3Objects,
  base: string,
  kind: "writer" | "reader",
  generationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Legacy test adapters and unmanaged scopes keep the original protocol.
  if (!objects.client || !(await readControl(objects, base))) return fn();
  const id = randomUUID();
  await mutateControl(objects, base, (c) => {
    if (c.plan?.status === "deleting")
      throw Error("S3 远端维护进行中，请稍后重试");
    if (c.retired.includes(generationId)) throw Error("S3 版本已退役");
    if (kind === "reader" && !c.committed.includes(generationId))
      throw Error("S3 版本尚未提交至维护控制记录");
    if (c.writers.length + c.readers.length >= 64)
      throw Error("S3 活动任务保护超过预算");
    if (kind === "writer") c.writers.push({ id, generationId });
    else c.readers.push({ id, generationId });
  });
  try {
    const result = await fn();
    if (kind === "writer")
      await mutateControl(objects, base, (c) => {
        if (
          !c.writers.some((v) => v.id === id) ||
          c.plan?.status === "deleting" ||
          c.retired.includes(generationId)
        )
          throw Error("S3 提交保护已失效");
        if (!c.committed.includes(generationId)) c.committed.push(generationId);
      });
    return result;
  } finally {
    await mutateControl(objects, base, (c) => {
      if (kind === "writer") c.writers = c.writers.filter((v) => v.id !== id);
      else c.readers = c.readers.filter((v) => v.id !== id);
    });
  }
}

/**
 * Cancel one generation: revoke its writer registration and mark it retired if not yet committed.
 *
 * @param objects S3 accessor.
 * @param base Base prefix.
 * @param generationId Generation ID to cancel.
 */
export async function cancelS3Generation(
  objects: S3Objects,
  base: string,
  generationId: string,
) {
  if (!(await readControl(objects, base))) return;
  await mutateControl(objects, base, (c) => {
    c.writers = c.writers.filter((v) => v.generationId !== generationId);
    if (
      !c.committed.includes(generationId) &&
      !c.retired.includes(generationId)
    ) {
      if (c.retired.length >= 2000) throw Error("S3 退役记录超过预算");
      c.retired.push(generationId);
    }
  });
}
