import { randomUUID } from "node:crypto";
import {
  ListObjectVersionsCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import type { S3Objects } from "./providers.js";
import { digest } from "./providers.js";
import { manifestSchema } from "@anynote/storage-sqlite/archive-stream.js";
import {
  sampleVersions,
  calendarPolicy,
} from "@anynote/cloudflare-backup/src/retention-policy.js";
import {
  activateControl,
  readControl,
  mutateControl,
  type S3Plan,
} from "./s3-control.js";

/** Grace period for unreferenced objects (24 hours). */
const grace = 24 * 60 * 60 * 1000;

/**
 * List all object versions under one branch (including delete markers), up to 10000.
 *
 * @param objects S3 accessor.
 * @param base Base prefix.
 * @returns Object version entries.
 */
async function versions(objects: S3Objects, base: string) {
  const entries: {
    key: string;
    versionId: string;
    size: number;
    date: number;
    marker: boolean;
  }[] = [];
  let KeyMarker: string | undefined, VersionIdMarker: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await objects.client.send(
      new ListObjectVersionsCommand({
        Bucket: objects.bucket,
        Prefix: objects.key(base + "/"),
        KeyMarker,
        VersionIdMarker,
        MaxKeys: 1000,
      }),
    );
    for (const [items, marker] of [
      [r.Versions, false],
      [r.DeleteMarkers, true],
    ] as const)
      for (const v of items ?? []) {
        if (
          !v.Key?.startsWith(objects.key(base + "/")) ||
          !v.VersionId ||
          v.VersionId === "null"
        )
          throw Error("S3 对象版本列举无效");
        entries.push({
          key: v.Key.slice(objects.prefix.length + 1),
          versionId: v.VersionId,
          size: "Size" in v ? Number(v.Size ?? 0) : 0,
          date: v.LastModified?.getTime() ?? 0,
          marker,
        });
      }
    if (!r.IsTruncated) return entries;
    if (
      !r.NextKeyMarker ||
      !r.NextVersionIdMarker ||
      (KeyMarker === r.NextKeyMarker &&
        VersionIdMarker === r.NextVersionIdMarker)
    )
      throw Error("S3 版本分页响应无效");
    KeyMarker = r.NextKeyMarker;
    VersionIdMarker = r.NextVersionIdMarker;
  }
  throw Error("S3 版本规划超过 10000 个对象版本预算");
}

/**
 * Build one cleanup snapshot: protected versions, versions to delete, and protected object keys.
 *
 * @param objects S3 accessor.
 * @param base Base prefix.
 * @param keep Number of most recent versions to keep.
 * @param calendar Daily/weekly/monthly sampling policy.
 * @param referenceTime Reference timestamp for calendar windows.
 * @param retired Retired generation IDs.
 * @param committed Committed generation IDs.
 * @param readers Active readers to protect.
 * @returns Cleanup snapshot used to build a plan.
 */
async function snapshot(
  objects: S3Objects,
  base: string,
  keep: number,
  calendar: NonNullable<S3Plan["calendar"]>,
  referenceTime: string,
  retired: string[],
  committed: string[],
  readers: { generationId: string }[],
) {
  const listing = await objects.list(base + "/generations/");
  const rows: { id: string; created_at: string; keys: Set<string> }[] = [];
  const marked = new Set<string>();
  for (const entry of listing.filter((v) =>
    v.key.endsWith("/COMMITTED.json"),
  )) {
    const id = entry.key.slice((base + "/generations/").length).split("/")[0];
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw Error("S3 版本身份无效");
    if (retired.includes(id) || !committed.includes(id)) continue;
    if (rows.length >= 200) throw Error("S3 版本规划超过 200 条预算");
    const marker = JSON.parse(
      (await objects.get(entry.key, { maxBytes: 65536 })).toString(),
    );
    const manifestKey = `${base}/generations/${id}/manifest.json`;
    if (marker.manifestKey !== manifestKey || marker.generationId !== id)
      throw Error("S3 提交记录路径无效");
    const bytes = await objects.get(manifestKey, { maxBytes: 16 * 1024 ** 2 });
    if (digest(bytes) !== marker.manifestHash)
      throw Error("S3 保护版本的 manifest 校验失败");
    const raw = JSON.parse(bytes.toString());
    manifestSchema.parse(raw);
    if (
      `${raw.notebookId}/${raw.lineageId}` !== base ||
      raw.generationId !== id ||
      ![1, 2].includes(raw.protocolVersion)
    )
      throw Error("S3 manifest 身份或协议无效");
    const keys = new Set<string>();
    for (const f of [raw.database, ...raw.assets]) {
      if (
        f.path !== "notebook.sqlite" &&
        f.path !== `assets/sha256/${f.sha256.slice(0, 2)}/${f.sha256}.bin`
      )
        throw Error("S3 资源路径无效");
      const parts = f.chunks ?? [
        { sha256: f.sha256, size: f.size, key: f.key },
      ];
      if (parts.reduce((sum: number, c: any) => sum + c.size, 0) !== f.size)
        throw Error("S3 分块大小无效");
      for (const c of parts) {
        const expected =
          !f.chunks && f.path === "notebook.sqlite"
            ? `${base}/databases/${c.sha256}.sqlite`
            : `${base}/objects/sha256/${c.sha256}`;
        if (c.key !== expected || !/^[a-f0-9]{64}$/.test(c.sha256))
          throw Error("S3 分块路径无效");
        keys.add(expected);
      }
    }
    rows.push({ id, created_at: raw.createdAt, keys });
  }
  rows.sort(
    (a, b) =>
      b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
  );
  if (!rows.length) throw Error("没有可清理的已提交 S3 版本");
  const sampled = sampleVersions(rows, keep, calendar, referenceTime);
  const protectedIds = new Set([
    rows[0].id,
    ...sampled.map((v) => v.id),
    ...readers.map((v) => v.generationId),
  ]);
  for (const row of rows.filter((v) => protectedIds.has(v.id)))
    for (const k of row.keys) marked.add(k);
  if (marked.size > 200000) throw Error("S3 保护引用超过预算");
  const remove = rows
    .filter((v) => !protectedIds.has(v.id))
    .map((v) => ({ id: v.id, createdAt: v.created_at }));
  const removing = new Set([...remove.map((v) => v.id), ...retired]);
  const entries = await versions(objects, base);
  const objectsToDelete = entries
    .filter((v) => {
      const generation = v.key.match(
        new RegExp(
          "^" +
            base +
            "/generations/([a-f0-9-]{36})/(manifest|COMMITTED)\\.json$",
        ),
      );
      if (generation) return removing.has(generation[1]);
      const content = new RegExp(
        "^" +
          base +
          "/(objects/sha256/[a-f0-9]{64}|databases/[a-f0-9]{64}\\.sqlite)$",
      ).test(v.key);
      return (
        content &&
        !marked.has(v.key) &&
        v.date > 0 &&
        Date.now() - v.date >= grace
      );
    })
    .map(({ key, versionId, size }) => ({ key, versionId, size }))
    .sort(
      (a, b) =>
        a.key.localeCompare(b.key) || a.versionId.localeCompare(b.versionId),
    );
  if (objectsToDelete.length > 1000)
    throw Error("S3 清理对象版本超过 1000 条预算");
  return {
    remove,
    protected: [...protectedIds].sort(),
    sampled,
    objects: objectsToDelete,
    reclaimBytes: objectsToDelete.reduce((n, v) => n + v.size, 0),
    graceHours: 24,
  };
}

/**
 * Return the current S3 maintenance state (active plan and managed flag).
 *
 * @param objects S3 accessor.
 * @param base Base prefix.
 * @returns Active cleanup plan and whether the scope is managed.
 */
export async function s3RetentionState(objects: S3Objects, base: string) {
  const c = await readControl(objects, base);
  return {
    activePlan: c?.value.plan?.status === "deleting" ? c.value.plan : null,
    managed: !!c,
  };
}

/**
 * Build and persist one S3 cleanup plan (does not perform deletion).
 *
 * @param objects S3 accessor.
 * @param base Base prefix.
 * @param keep Number of most recent versions to keep.
 * @param calendar Raw sampling policy.
 * @param confirmed Whether the caller confirmed initialization.
 * @returns The stored cleanup plan.
 */
export async function previewS3Retention(
  objects: S3Objects,
  base: string,
  keep: number,
  calendar: unknown,
  confirmed: boolean,
) {
  if (!(await readControl(objects, base))) {
    if (!confirmed)
      throw Error(
        "首次启用 S3 维护须确认所有访问该分支的客户端已升级且旧任务已停止",
      );
    await activateControl(objects, base);
  }
  const current = (await readControl(objects, base))!;
  if (current.value.plan?.status === "deleting" || current.value.writers.length)
    throw Error("S3 有活动备份或清理，不能规划");
  const policy = calendarPolicy(calendar);
  const referenceTime = new Date().toISOString();
  const body = await snapshot(
    objects,
    base,
    keep,
    policy,
    referenceTime,
    current.value.retired,
    current.value.committed,
    current.value.readers,
  );
  const plan: S3Plan = {
    id: randomUUID(),
    status: "planned",
    created: Date.now(),
    revision: current.value.revision + 1,
    keep,
    calendar: policy,
    referenceTime,
    ...body,
    cursor: 0,
  };
  await mutateControl(objects, base, (c) => {
    if (c.revision !== current.value.revision)
      throw Error("S3 规划期间版本或保护发生变化，请重新预览");
    c.plan = plan;
  });
  return plan;
}

/**
 * Run one batch of an approved S3 cleanup plan, returning whether it finished.
 *
 * @param objects S3 accessor.
 * @param base Base prefix.
 * @param planId Plan ID to apply.
 * @param confirmed Whether the caller confirmed permanent deletion.
 * @returns Whether the plan completed.
 */
export async function applyS3Retention(
  objects: S3Objects,
  base: string,
  planId: string,
  confirmed: boolean,
) {
  if (!confirmed) throw Error("清理需要显式永久删除确认");
  let current = (await readControl(objects, base))?.value;
  if (!current?.plan || current.plan.id !== planId)
    throw Error("S3 清理计划不存在或已被替换");
  if (current.plan.status === "completed") return { completed: true, planId };
  if (current.plan.status === "planned") {
    const plan = current.plan;
    if (
      Date.now() - plan.created > 600000 ||
      current.revision !== plan.revision ||
      current.writers.length
    )
      throw Error("S3 清理计划过期或保护已改变，请重新预览");
    const body = await snapshot(
      objects,
      base,
      plan.keep,
      plan.calendar,
      plan.referenceTime,
      current.retired,
      current.committed,
      current.readers,
    );
    for (const field of ["remove", "protected", "sampled", "objects"] as const)
      if (JSON.stringify(body[field]) !== JSON.stringify(plan[field]))
        throw Error("S3 清理候选已改变，请重新预览");
    await mutateControl(objects, base, (c) => {
      if (
        c.revision !== plan.revision ||
        c.writers.length ||
        c.plan?.id !== planId
      )
        throw Error("S3 清理计划已改变");
      if (c.retired.length + plan.remove.length > 2000)
        throw Error("S3 退役记录超过预算");
      c.retired.push(...plan.remove.map((v) => v.id));
      c.plan!.status = "deleting";
    });
    current = (await readControl(objects, base))!.value;
  }
  const plan = current.plan!;
  const end = Math.min(plan.cursor + 8, plan.objects.length);
  for (const entry of plan.objects.slice(plan.cursor, end)) {
    // Version IDs are immutable: a late duplicate request can never delete a re-uploaded object.
    await objects.client.send(
      new DeleteObjectCommand({
        Bucket: objects.bucket,
        Key: objects.key(entry.key),
        VersionId: entry.versionId,
      }),
    );
  }
  return mutateControl(objects, base, (c) => {
    if (c.plan?.id !== planId) throw Error("S3 清理计划已替换");
    c.plan.cursor = Math.max(c.plan.cursor, end);
    if (c.plan.cursor >= c.plan.objects.length) c.plan.status = "completed";
    return {
      completed: c.plan.status === "completed",
      planId,
      removed: c.plan.remove.length,
      reclaimedBytes: c.plan.reclaimBytes,
      processedObjects: c.plan.cursor,
    };
  });
}
