import { objectDescriptors } from "@anynote/protocol/cloud-objects.js";
import type { SqlRow, WorkerEnv } from "@anynote/types/runtime.js";
import { calendarPolicy, sampleVersions } from "./retention-policy.js";

/** UUID format for version/lineage IDs. */
const uuid = /^[a-f0-9-]{36}$/i;

/** Grace period for unreferenced objects (24 hours). */
const grace = 24 * 60 * 60 * 1000;

/** Exported grace period constant. */
export const maintenanceGrace = grace;

/**
 * Throw an error (usable in expression position).
 *
 * @param message Error message.
 * @returns Never returns.
 */
function fail(message: string): never {
  throw Error(message);
}

/**
 * Validate an ID format; throws when invalid.
 *
 * @param id Candidate ID.
 * @returns The ID when valid.
 */
const validId = (id: string) => (uuid.test(id || "") ? id : fail("身份无效"));

/**
 * Build a JSON response that disables caching.
 *
 * @param body Response payload.
 * @param status HTTP status code (default 200).
 * @returns JSON response with `Cache-Control: no-store`.
 */
const result = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Read (or initialize) the maintenance state row of a Notebook.
 *
 * @param env Worker environment bindings.
 * @param book Notebook ID.
 * @returns The notebook_state row.
 */
export async function state(env: WorkerEnv, book: string) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO notebook_state(notebook_id) VALUES(?)",
  )
    .bind(book)
    .run();
  return (await env.DB.prepare(
    "SELECT * FROM notebook_state WHERE notebook_id=?",
  )
    .bind(book)
    .first())!;
}

/**
 * Build a conditional-write guard statement: it passes only when the Notebook has no maintenance and the extra condition holds.
 *
 * @param env Worker environment bindings.
 * @param book Notebook ID.
 * @param guardId Guard row ID.
 * @param extra Extra SQL condition (defaults to always true).
 * @param bindings Bindings for the extra condition.
 * @returns Prepared guard statement.
 */
export function gate(
  env: WorkerEnv,
  book: string,
  guardId: string,
  extra = "1",
  bindings: unknown[] = [],
) {
  return env.DB.prepare(
    `INSERT INTO transaction_guard SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM notebook_state WHERE notebook_id=? AND maintenance_id IS NULL) AND (${extra}) THEN 1 ELSE 0 END`,
  ).bind(guardId, book, ...bindings);
}

/**
 * Clear one guard record.
 *
 * @param env Worker environment bindings.
 * @param id Guard row ID.
 * @returns Prepared delete statement.
 */
const clear = (env: WorkerEnv, id: string) =>
  env.DB.prepare("DELETE FROM transaction_guard WHERE id=?").bind(id);

/**
 * Increment the Notebook state revision.
 *
 * @param env Worker environment bindings.
 * @param book Notebook ID.
 * @returns Prepared update statement.
 */
const bump = (env: WorkerEnv, book: string) =>
  env.DB.prepare(
    "UPDATE notebook_state SET revision=revision+1 WHERE notebook_id=?",
  ).bind(book);

/**
 * Look up a branch by Notebook and lineage.
 *
 * @param env Worker environment bindings.
 * @param book Notebook ID.
 * @param lineage Lineage ID.
 * @returns The branch row, or null when absent.
 */
export async function branch(
  env: WorkerEnv,
  book: string,
  lineage: string | null,
) {
  return env.DB.prepare(
    "SELECT * FROM branches WHERE notebook_id=? AND lineage_id=?",
  )
    .bind(book, validId(lineage!))
    .first();
}

/**
 * Whether a generation is still usable (not retired).
 *
 * @param env Worker environment bindings.
 * @param generation Generation row.
 * @returns True when the generation is still usable.
 */
export async function usable(env: WorkerEnv, generation: SqlRow) {
  return !(await env.DB.prepare("SELECT id FROM retired_generations WHERE id=?")
    .bind(generation.id)
    .first());
}

/**
 * Verify that the request comes from the current branch writer (device and epoch match), otherwise throws WRITER_REVOKED.
 *
 * @param env Worker environment bindings.
 * @param book Notebook ID.
 * @param p Request payload carrying lineage/device/epoch.
 * @returns The matching branch row.
 */
async function scope(env: WorkerEnv, book: string, p: SqlRow) {
  const b = await branch(env, book, p.lineageId);
  if (!b) fail("分支不存在");
  if (b.writer_id !== p.deviceId || b.writer_epoch !== p.writerEpoch)
    fail("WRITER_REVOKED");
  return b;
}

/**
 * Build one cleanup plan: protected versions, versions to delete, and protected object keys.
 *
 * @param env Worker environment bindings.
 * @param book Notebook ID.
 * @param lineage Lineage ID being trimmed.
 * @param keep Number of most recent versions to keep.
 * @param calendar Optional daily/weekly/monthly sampling policy.
 * @param referenceTime Reference timestamp for calendar windows.
 * @returns Cleanup plan including removals and reclaimable objects.
 */
async function snapshot(
  env: WorkerEnv,
  book: string,
  lineage: string,
  keep: number,
  calendar?: import("./retention-policy.js").CalendarPolicy,
  referenceTime: string = "",
) {
  const rows = (
    await env.DB.prepare(
      "SELECT g.* FROM generations g WHERE notebook_id=? AND NOT EXISTS(SELECT 1 FROM retired_generations r WHERE r.id=g.id) ORDER BY created_at DESC,id DESC LIMIT 201",
    )
      .bind(book)
      .all()
  ).results;
  if (rows.length > 200) fail("版本规划超过 200 条预算");
  const heads = (
    await env.DB.prepare("SELECT head FROM branches WHERE notebook_id=?")
      .bind(book)
      .all()
  ).results;
  const pins = (
    await env.DB.prepare(
      "SELECT generation_id FROM restore_pins WHERE notebook_id=? AND expires_at>?",
    )
      .bind(book, Date.now())
      .all()
  ).results;
  const protectedIds = new Set([
    ...heads.map((b) => b.head),
    ...pins.map((p) => p.generation_id),
  ]);
  const selected = rows.filter(
    (g) => g.lineage_id === lineage && g.status === "committed",
  );
  const sampled =
    calendar === undefined
      ? undefined
      : sampleVersions(
          selected as { id: string; created_at: string }[],
          keep,
          calendar,
          referenceTime,
        );
  if (sampled) sampled.forEach((g) => protectedIds.add(g.id));
  else selected.slice(0, keep).forEach((g) => protectedIds.add(g.id));
  const remove = selected.filter((g) => !protectedIds.has(g.id)),
    removed = new Set(remove.map((g) => g.id)),
    marked = new Set();

  // Collect every object referenced by retained versions to avoid deleting content still in use.
  for (const g of rows.filter((g) => !removed.has(g.id))) {
    const object = await env.BUCKET.get(`manifests/${book}/${g.id}.json`);
    if (!object) fail("保护版本的 manifest 缺失");
    const bytes = await object.arrayBuffer();
    if ((await sha(bytes)) !== g.manifest_hash)
      fail("保护版本的 manifest 校验失败");
    const m = JSON.parse(new TextDecoder().decode(bytes));
    for (const d of objectDescriptors(m).values()) marked.add(d.hash);
    if (marked.size > 200000) fail("保护引用超过 200000 条预算");
  }
  const objects = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const listed = await env.BUCKET.list({
      prefix: `objects/${book}/`,
      cursor,
      limit: 1000,
    });
    for (const item of listed.objects) {
      const hash = item.key.split("/").pop();
      if (!/^[a-f0-9]{64}$/.test(hash!)) continue;
      if (
        !marked.has(hash) &&
        Date.now() - new Date(item.uploaded).getTime() >= grace
      )
        objects.push({ key: item.key, hash, size: item.size, etag: item.etag });
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
    if (page === 9) fail("对象规划超过 10000 条预算");
  }
  return {
    keep,
    ...(sampled ? { calendar, referenceTime, sampled } : {}),
    remove: remove.map((g) => ({ id: g.id, createdAt: g.created_at })),
    objects: objects.slice(0, 1000),
    protected: [...protectedIds].filter(Boolean),
    staging: rows.filter((g) => g.status === "staging").length,
    reclaimBytes: objects.slice(0, 1000).reduce((s, o) => s + o.size, 0),
    graceHours: 24,
  };
}

/**
 * Compute the SHA-256 hex digest of a byte sequence.
 *
 * @param bytes Source bytes to hash.
 * @returns Lowercase hex digest.
 */
const sha = async (bytes: BufferSource) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

/**
 * Handle remote maintenance endpoints: writer lookup/takeover, restore pins, retention preview/cleanup, lock diagnosis, and guarded release of a legacy execution lock.
 *
 * All writes rely on D1 conditional guards (gate) and the state revision for
 * concurrency safety; cleanup advances in cursor-based batches and is
 * retryable, keeping the Notebook-level maintenance lock on failure.
 *
 * @param request Incoming request.
 * @param env Worker environment bindings.
 * @param book Notebook ID.
 * @param tail Path suffix after the notebook segment.
 * @param url Parsed request URL.
 * @param json Parser for the request body.
 * @param executionOwner Actor owning the current execution, if any.
 * @returns The matched response, or `null` when no maintenance endpoint matches.
 */
export async function maintenance(
  request: Request,
  env: WorkerEnv,
  book: string,
  tail: string,
  url: URL,
  json: (request: Request) => Promise<any>,
  executionOwner: string | null = null,
) {
  // Look up the branch writer.
  if (tail === "/writer" && request.method === "GET") {
    const b = await branch(env, book, url.searchParams.get("lineageId"));
    return b
      ? result({
          head: b.head,
          deviceId: b.writer_id,
          writerEpoch: b.writer_epoch,
          lineageId: b.lineage_id,
        })
      : result({ error: "分支不存在" }, 404);
  }

  // Device takeover: bump the writer epoch via CAS, requiring explicit confirmation and the current head.
  if (tail === "/writer/takeover" && request.method === "POST") {
    const p = await json(request);
    validId(p.lineageId);
    validId(p.deviceId);
    validId(p.requestId);
    if (
      p.confirmed !== true ||
      !Number.isSafeInteger(p.expectedWriterEpoch) ||
      p.expectedWriterEpoch < 1 ||
      typeof p.expectedHead !== "string"
    )
      fail("接管需要确认与当前分支版本");
    await state(env, book);
    const b = await branch(env, book, p.lineageId);
    if (!b) fail("分支不存在");
    const prior = await env.DB.prepare("SELECT * FROM writer_claims WHERE id=?")
      .bind(p.requestId)
      .first();
    if (prior) {
      if (
        prior.notebook_id !== book ||
        prior.lineage_id !== p.lineageId ||
        prior.device_id !== p.deviceId ||
        prior.expected_epoch !== p.expectedWriterEpoch ||
        prior.expected_head !== p.expectedHead
      )
        fail("IDEMPOTENCY_CONFLICT");
      if (b.writer_id !== p.deviceId || b.writer_epoch !== prior.new_epoch)
        fail("WRITER_REVOKED");
      return result({
        head: b.head,
        writerEpoch: prior.new_epoch,
        lineageId: p.lineageId,
      });
    }
    const guard = crypto.randomUUID();
    try {
      await env.DB.batch([
        gate(
          env,
          book,
          guard,
          "EXISTS(SELECT 1 FROM branches WHERE notebook_id=? AND lineage_id=? AND head=? AND writer_epoch=?)",
          [book, p.lineageId, p.expectedHead, p.expectedWriterEpoch],
        ),
        env.DB.prepare(
          "UPDATE branches SET writer_id=?,writer_epoch=writer_epoch+1 WHERE notebook_id=? AND lineage_id=?",
        ).bind(p.deviceId, book, p.lineageId),
        env.DB.prepare("INSERT INTO writer_claims VALUES(?,?,?,?,?,?,?)").bind(
          p.requestId,
          book,
          p.lineageId,
          p.deviceId,
          p.expectedWriterEpoch,
          p.expectedHead,
          p.expectedWriterEpoch + 1,
        ),
        bump(env, book),
        clear(env, guard),
      ]);
    } catch {
      return result({ error: "HEAD_CONFLICT_OR_MAINTENANCE" }, 409);
    }
    return result({
      head: p.expectedHead,
      writerEpoch: p.expectedWriterEpoch + 1,
      lineageId: p.lineageId,
    });
  }

  // Restore pin: create/renew/delete a pin that protects versions during an active restore.
  const pin = tail.match(/^\/backups\/([a-f0-9-]{36})\/pin$/);
  if (pin && ["POST", "DELETE"].includes(request.method)) {
    const p = await json(request);
    validId(p.pinId);
    const existing = await env.DB.prepare(
      "SELECT * FROM restore_pins WHERE id=?",
    )
      .bind(p.pinId)
      .first();
    if (
      existing &&
      (existing.notebook_id !== book || existing.generation_id !== pin[1])
    )
      fail("恢复 pin 身份冲突");
    if (request.method === "DELETE") {
      await env.DB.prepare(
        "DELETE FROM restore_pins WHERE id=? AND notebook_id=?",
      )
        .bind(p.pinId, book)
        .run();
      return result({ ok: true });
    }
    await state(env, book);
    const guard = crypto.randomUUID();
    const g = await env.DB.prepare(
      "SELECT * FROM generations WHERE notebook_id=? AND id=? AND status='committed'",
    )
      .bind(book, pin[1])
      .first();
    if (!g || !(await usable(env, g)))
      return result({ error: "版本不存在" }, 404);
    if (existing && existing.expires_at > Date.now()) {
      await env.DB.prepare("UPDATE restore_pins SET expires_at=? WHERE id=?")
        .bind(Date.now() + 3600000, p.pinId)
        .run();
      return result({ pinId: p.pinId });
    }
    try {
      await env.DB.batch([
        gate(
          env,
          book,
          guard,
          "NOT EXISTS(SELECT 1 FROM retired_generations WHERE id=?)",
          [pin[1]],
        ),
        env.DB.prepare(
          "INSERT INTO restore_pins VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at",
        ).bind(p.pinId, book, pin[1], Date.now() + 3600000),
        bump(env, book),
        clear(env, guard),
      ]);
    } catch {
      return result({ error: "MAINTENANCE_IN_PROGRESS" }, 409);
    }
    return result({ pinId: p.pinId });
  }

  // Query the current cleanup state.
  if (tail === "/retention/state" && request.method === "GET") {
    const current = await state(env, book);
    const plan = current.maintenance_id
      ? await env.DB.prepare(
          "SELECT * FROM retention_plans WHERE id=? AND notebook_id=?",
        )
          .bind(current.maintenance_id, book)
          .first()
      : null;
    return result({
      activePlan: plan
        ? {
            id: plan.id,
            lineageId: plan.lineage_id,
            status: plan.status,
            ...JSON.parse(plan.body_json),
          }
        : null,
    });
  }

  // Read-only diagnosis of the current cleanup lock. It never mutates the lock,
  // so an admin can inspect a stuck Notebook before deciding anything.
  if (tail === "/retention/diagnostics" && request.method === "GET") {
    const current = await state(env, book);
    const plan = current.maintenance_id
      ? await env.DB.prepare(
          "SELECT * FROM retention_plans WHERE id=? AND notebook_id=?",
        )
          .bind(current.maintenance_id, book)
          .first()
      : null;
    const executionId = plan?.execution_id || null,
      executionOwner = plan?.execution_owner || null,
      // A pre-coordinator Worker wrote execution_id without an owner identity;
      // the coordinator deliberately never clears such an unowned lock.
      legacyLock = !!plan && !!executionId && !executionOwner;
    return result({
      notebookLocked: !!current.maintenance_id,
      plan: plan
        ? {
            id: plan.id,
            status: plan.status,
            executionId,
            executionOwner,
            objectCursor: plan.object_cursor,
            generationCursor: plan.generation_cursor,
            createdAt: plan.created_at,
          }
        : null,
      legacyLock,
      guidance: legacyLock
        ? "旧版无协调器身份的执行锁不会自动过期。请先确认旧请求已停止，再用 /retention/legacy-lock/release 提供计划与执行身份释放；不得按时间抢占。"
        : null,
    });
  }

  // Administrator release of a legacy execution lock. Only an exact, observed
  // unowned execution lock can be cleared, and the caller must attest that the
  // old requests have stopped; elapsed time is never used as evidence. The
  // Notebook-level gate stays held so backups remain blocked until the plan
  // finishes through the normal idempotent retry.
  if (tail === "/retention/legacy-lock/release" && request.method === "POST") {
    const p = await json(request);
    validId(p.planId);
    validId(p.executionId);
    if (p.confirmed !== true) fail("释放旧维护锁需要显式确认");
    if (p.attestation !== "legacy-requests-stopped")
      fail("释放旧维护锁前必须确认旧请求已停止");
    const guard = crypto.randomUUID();
    try {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO transaction_guard SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM retention_plans p JOIN notebook_state s ON s.notebook_id=p.notebook_id WHERE p.id=? AND p.notebook_id=? AND p.status='deleting' AND p.execution_id=? AND p.execution_owner IS NULL AND s.maintenance_id=p.id) THEN 1 ELSE 0 END",
        ).bind(guard, p.planId, book, p.executionId),
        env.DB.prepare(
          "UPDATE retention_plans SET execution_id=NULL WHERE id=? AND notebook_id=?",
        ).bind(p.planId, book),
        env.DB.prepare(
          "INSERT INTO maintenance_admin_actions VALUES(?,?,?,?,?,?,?)",
        ).bind(
          crypto.randomUUID(),
          book,
          "legacy-lock-release",
          p.planId,
          p.executionId,
          "legacy-requests-stopped",
          Date.now(),
        ),
        clear(env, guard),
      ]);
    } catch {
      // The observed lock already changed (released, taken by the coordinator,
      // or belonging to another Notebook). Never clear it blindly.
      return result({ error: "LEGACY_LOCK_CHANGED" }, 409);
    }
    return result({
      released: true,
      planId: p.planId,
      notebookLocked: true,
      next: "旧执行锁已释放，Notebook 锁保留；请在维护界面重试未完成的清理，由协调器续跑同一计划。",
    });
  }

  // Build a cleanup plan (does not perform deletion).
  if (tail === "/retention/plan" && request.method === "POST") {
    const p = await json(request);
    if (!Number.isInteger(p.keep) || p.keep < 1 || p.keep > 1000)
      fail("保留数量需为 1 到 1000");
    const b = await scope(env, book, p),
      before = await state(env, book);
    if (before.maintenance_id) fail("MAINTENANCE_IN_PROGRESS");
    const body = await snapshot(
        env,
        book,
        p.lineageId,
        p.keep,
        calendarPolicy(p.calendar),
        new Date(Date.now()).toISOString(),
      ),
      after = await state(env, book);
    if (after.revision !== before.revision || after.maintenance_id)
      fail("规划期间版本发生变化");
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO retention_plans(id,notebook_id,lineage_id,writer_id,writer_epoch,state_revision,body_json,status,created_at) VALUES(?,?,?,?,?,?,?,'planned',?)",
    )
      .bind(
        id,
        book,
        p.lineageId,
        b.writer_id,
        b.writer_epoch,
        before.revision,
        JSON.stringify(body),
        Date.now(),
      )
      .run();
    return result({ id, ...body });
  }

  // Apply a cleanup plan: delete objects and generations in batches; retryable and idempotent.
  if (tail === "/retention/apply" && request.method === "POST") {
    const p = await json(request);
    validId(p.planId);
    if (p.confirmed !== true) fail("清理需要显式确认");
    const plan = await env.DB.prepare(
      "SELECT * FROM retention_plans WHERE id=? AND notebook_id=?",
    )
      .bind(p.planId, book)
      .first();
    if (!plan) fail("清理计划不存在");
    if (plan.status === "completed")
      return result({ completed: true, planId: plan.id });
    if (plan.status === "planned")
      await scope(env, book, {
        lineageId: plan.lineage_id,
        deviceId: p.deviceId,
        writerEpoch: p.writerEpoch,
      });
    const body = JSON.parse(plan.body_json);
    if (plan.status === "planned") {
      if (Date.now() - plan.created_at > 10 * 60 * 1000)
        fail("清理计划已过期，请重新预览");
      const current = await snapshot(
        env,
        book,
        plan.lineage_id,
        body.keep,
        body.calendar,
        body.referenceTime,
      );
      if (JSON.stringify(current) !== JSON.stringify(body))
        fail("清理候选或保护引用发生变化，请重新预览");
      const guard = crypto.randomUUID();
      try {
        await env.DB.batch([
          gate(
            env,
            book,
            guard,
            "EXISTS(SELECT 1 FROM notebook_state WHERE notebook_id=? AND revision=?) AND EXISTS(SELECT 1 FROM branches WHERE notebook_id=? AND lineage_id=? AND writer_id=? AND writer_epoch=?)",
            [
              book,
              plan.state_revision,
              book,
              plan.lineage_id,
              p.deviceId,
              p.writerEpoch,
            ],
          ),
          env.DB.prepare(
            "UPDATE notebook_state SET maintenance_id=? WHERE notebook_id=?",
          ).bind(plan.id, book),
          env.DB.prepare(
            "UPDATE retention_plans SET status='deleting' WHERE id=?",
          ).bind(plan.id),
          clear(env, guard),
        ]);
      } catch {
        return result({ error: "PLAN_CHANGED" }, 409);
      }
    } else if ((await state(env, book)).maintenance_id !== plan.id)
      fail("清理状态不匹配");

    // The Notebook-level gate stays held on failure. Retrying the same plan resumes idempotent deletes;
    // it never expires while R2 deletes may still be in flight.
    const execution = crypto.randomUUID(),
      executionGuard = crypto.randomUUID();
    try {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO transaction_guard SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM retention_plans p JOIN notebook_state s ON p.notebook_id=s.notebook_id WHERE p.id=? AND p.execution_id IS NULL AND p.status='deleting' AND s.maintenance_id=p.id) THEN 1 ELSE 0 END",
        ).bind(executionGuard, plan.id),
        env.DB.prepare(
          "UPDATE retention_plans SET execution_id=?,execution_owner=? WHERE id=?",
        ).bind(execution, executionOwner, plan.id),
        clear(env, executionGuard),
      ]);
    } catch {
      return result({ error: "CLEANUP_BUSY" }, 409);
    }
    try {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO retired_generations SELECT id,notebook_id,? FROM generations WHERE notebook_id=? AND id IN (SELECT value FROM json_each(?))",
      )
        .bind(
          plan.id,
          book,
          JSON.stringify(body.remove.map((item: { id: string }) => item.id)),
        )
        .run();
      const cursors = await env.DB.prepare(
        "SELECT object_cursor,generation_cursor FROM retention_plans WHERE id=?",
      )
        .bind(plan.id)
        .first();
      let objectCursor = cursors!.object_cursor,
        generationCursor = cursors!.generation_cursor;
      for (const entry of body.objects.slice(objectCursor, objectCursor + 8)) {
        const head = await env.BUCKET.head(entry.key);
        if (head && head.etag !== entry.etag) fail("对象在清理期间发生变化");
        await env.BUCKET.delete(entry.key);
        objectCursor++;
        await env.DB.batch([
          env.DB.prepare(
            "DELETE FROM asset_catalog WHERE notebook_id=? AND hash=?",
          ).bind(book, entry.hash),
          env.DB.prepare(
            "UPDATE retention_plans SET object_cursor=? WHERE id=?",
          ).bind(objectCursor, plan.id),
        ]);
      }
      if (
        objectCursor < body.objects.length ||
        objectCursor > cursors!.object_cursor
      )
        return result({
          completed: false,
          planId: plan.id,
          processedObjects: objectCursor,
        });
      for (const entry of body.remove.slice(
        generationCursor,
        generationCursor + 8,
      )) {
        await env.BUCKET.delete(`manifests/${book}/${entry.id}.json`);
        generationCursor++;
        await env.DB.batch([
          env.DB.prepare(
            "DELETE FROM generation_deltas WHERE generation_id=?",
          ).bind(entry.id),
          env.DB.prepare("DELETE FROM generations WHERE id=?").bind(entry.id),
          env.DB.prepare(
            "UPDATE retention_plans SET generation_cursor=? WHERE id=?",
          ).bind(generationCursor, plan.id),
        ]);
      }
      if (generationCursor < body.remove.length)
        return result({
          completed: false,
          planId: plan.id,
          processedGenerations: generationCursor,
        });
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE retention_plans SET status='completed' WHERE id=?",
        ).bind(plan.id),
        env.DB.prepare(
          "UPDATE notebook_state SET maintenance_id=NULL,revision=revision+1 WHERE notebook_id=? AND maintenance_id=?",
        ).bind(book, plan.id),
      ]);
      return result({
        completed: true,
        planId: plan.id,
        removed: body.remove.length,
        reclaimedBytes: body.reclaimBytes,
      });
    } finally {
      await env.DB.prepare(
        "UPDATE retention_plans SET execution_id=NULL,execution_owner=NULL WHERE id=? AND execution_id=?",
      )
        .bind(plan.id, execution)
        .run();
    }
  }
  return null;
}
