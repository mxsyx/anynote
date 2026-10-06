import {
  cloudObjectLimit,
  objectDescriptors as descriptors,
  logicalTables,
} from "@anynote/protocol/cloud-objects.js";
import type {
  LogicalManifest,
  SqlRow,
  WorkerEnv,
} from "@anynote/types/runtime.js";
import { gate, maintenance, state, usable } from "./maintenance.js";

export { MaintenanceCoordinator } from "./maintenance-coordinator.js";

/** UUID format for version/lineage/device IDs. */
const uuid = /^[a-f0-9-]{36}$/i;

/** Set of allowed entity tables. */
const tables = new Set<string>(logicalTables);

/** Maximum size of a single object. */
const objectLimit = cloudObjectLimit;

/**
 * Compute the SHA-256 hex digest of a byte sequence.
 *
 * @param bytes Source bytes to hash.
 * @returns Lowercase hex digest.
 */
const digest = async (bytes: BufferSource) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

/**
 * Build a JSON response that disables caching.
 *
 * @param body Response payload.
 * @param status HTTP status code (default 200).
 * @returns JSON response with `Cache-Control: no-store`.
 */
const response = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Read and parse the request body (capped at 5 MiB).
 *
 * @param request Incoming request.
 * @returns Parsed JSON payload.
 */
async function json(request: Request) {
  if (Number(request.headers.get("content-length")) > 5 * 1024 * 1024)
    throw Error("请求预算超限");
  const text = await request.text();
  if (text.length > 5 * 1024 * 1024) throw Error("请求预算超限");
  return JSON.parse(text);
}

/**
 * Read and verify the logical manifest of one generation from R2.
 *
 * @param env Worker environment bindings.
 * @param generation Generation row whose manifest is loaded.
 * @returns Verified manifest document.
 */
async function loadManifest(
  env: WorkerEnv,
  generation: SqlRow,
): Promise<LogicalManifest> {
  const object = await env.BUCKET.get(
    `manifests/${generation.notebook_id}/${generation.id}.json`,
  );
  if (!object) throw Error("manifest 缺失");
  const bytes = await object.arrayBuffer();
  if ((await digest(bytes)) !== generation.manifest_hash)
    throw Error("manifest 校验失败");
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Cloudflare Worker: single-user self-hosted logical backup service (D1 metadata + R2 objects).
export default {
  async fetch(request: Request, env: WorkerEnv) {
    try {
      if (!env.APP_TOKEN)
        return response({ error: "服务未配置 APP_TOKEN" }, 503);

      // Constant-time Bearer token comparison.
      const supplied = request.headers.get("Authorization") || "",
        expected = "Bearer " + env.APP_TOKEN;
      let mismatch = supplied.length ^ expected.length;
      for (let i = 0; i < expected.length; i++)
        mismatch |= (supplied.charCodeAt(i) || 0) ^ expected.charCodeAt(i);
      if (mismatch) return response({ error: "鉴权失败" }, 401);

      const url = new URL(request.url),
        path = url.pathname;

      // Capability negotiation.
      if (path === "/v1/capabilities" && request.method === "GET")
        return response({
          protocolVersion: 1,
          schemaVersions: [2],
          capabilities: [
            "logical-incremental",
            "conditional-head",
            "writer-takeover",
            "retention-gc",
            "calendar-retention",
            ...(env.MAINTENANCE ? ["maintenance-recovery-v1"] : []),
            "maintenance-admin-v1",
            "restore-pin",
            "chunked-assets-v1",
            "backup-discovery-v1",
          ],
          objectMaxBytes: objectLimit,
        });

      // Cross-notebook/lineage version discovery (paginated).
      if (path === "/v1/backups" && request.method === "GET") {
        const raw = url.searchParams.get("cursor");
        if (raw && raw.length > 1000) throw Error("分页参数无效");
        const cursor = raw ? JSON.parse(raw) : null;
        if (
          cursor &&
          (typeof cursor.createdAt !== "string" ||
            cursor.createdAt.length > 100 ||
            !uuid.test(cursor.id))
        )
          throw Error("分页参数无效");
        const rows = (
          await env.DB.prepare(
            "SELECT g.* FROM generations g WHERE g.status='committed' AND NOT EXISTS(SELECT 1 FROM retired_generations r WHERE r.id=g.id) " +
              (cursor
                ? "AND (g.created_at<? OR (g.created_at=? AND g.id<?)) "
                : "") +
              "ORDER BY g.created_at DESC,g.id DESC LIMIT 11",
          )
            .bind(
              ...(cursor
                ? [cursor.createdAt, cursor.createdAt, cursor.id]
                : []),
            )
            .all()
        ).results;
        const backups = [],
          warnings = [];
        for (const row of rows.slice(0, 10)) {
          try {
            const m = await loadManifest(env, row);
            if (
              m.notebookId !== row.notebook_id ||
              m.generationId !== row.id ||
              m.lineageId !== row.lineage_id ||
              !Array.isArray(m.assets)
            )
              throw Error("版本身份不匹配");
            backups.push({
              id: row.id,
              notebookId: row.notebook_id,
              lineageId: row.lineage_id,
              name:
                typeof m.notebookName === "string"
                  ? m.notebookName.slice(0, 240)
                  : "Notebook " + row.notebook_id.slice(0, 8),
              createdAt: row.created_at,
              snapshotSeq: row.snapshot_seq,
              assets: m.assets.length,
            });
          } catch {
            warnings.push("一个已提交版本无法读取或校验，已跳过：" + row.id);
          }
        }
        const last = rows[Math.min(rows.length, 10) - 1];
        return response({
          backups,
          warnings,
          cursor:
            rows.length > 10
              ? JSON.stringify({ createdAt: last.created_at, id: last.id })
              : null,
        });
      }

      const match = path.match(/^\/v1\/notebooks\/([a-f0-9-]{36})(.*)$/i);
      if (!match) return response({ error: "接口不存在" }, 404);
      const notebookId = match[1],
        tail = match[2];

      // Retention requests are serialized by the per-notebook maintenance coordinator.
      if (
        tail === "/retention/apply" &&
        request.method === "POST" &&
        env.MAINTENANCE
      )
        return env.MAINTENANCE.get(
          env.MAINTENANCE.idFromName(notebookId),
        ).fetch(
          request as unknown as import("@cloudflare/workers-types").Request,
        );

      const managed = await maintenance(
        request,
        env,
        notebookId,
        tail,
        url,
        json,
      );
      if (managed) return managed;

      // Backup planning: validate protocol and writer, register a staging generation, and return missing objects.
      if (tail === "/backup/plan" && request.method === "POST") {
        const m = await json(request);
        if (
          m.format !== "anynote.logical" ||
          m.protocolVersion !== 1 ||
          m.schemaVersion !== 2 ||
          m.notebookId !== notebookId ||
          !uuid.test(m.generationId) ||
          !uuid.test(m.lineageId) ||
          !uuid.test(m.deviceId) ||
          typeof m.expectedHead !== "string" ||
          !Number.isInteger(m.writerEpoch) ||
          m.writerEpoch < 1 ||
          !Number.isInteger(m.snapshotSeq) ||
          m.snapshotSeq < 0 ||
          !Array.isArray(m.entities) ||
          m.entities.length > 200000 ||
          !Array.isArray(m.assets) ||
          m.assets.length > 10000
        )
          throw Error("备份协议无效");
        const entityKeys = new Set();
        for (const e of m.entities) {
          if (
            !tables.has(e.table) ||
            typeof e.key !== "string" ||
            e.key.length > 1000 ||
            entityKeys.has(e.key)
          )
            throw Error("逻辑实体无效或重复");
          entityKeys.add(e.key);
        }
        const objects = descriptors(m);
        await env.DB.prepare(
          "INSERT OR IGNORE INTO branches(notebook_id,lineage_id,writer_id) VALUES(?,?,?)",
        )
          .bind(notebookId, m.lineageId, m.deviceId)
          .run();
        const branch = (await env.DB.prepare(
          "SELECT * FROM branches WHERE notebook_id=? AND lineage_id=?",
        )
          .bind(notebookId, m.lineageId)
          .first())!;
        if (
          branch.writer_id !== m.deviceId ||
          branch.writer_epoch !== m.writerEpoch
        )
          return response({ error: "WRITER_REVOKED" }, 409);
        await state(env, notebookId);
        if (
          await env.DB.prepare("SELECT id FROM retired_generations WHERE id=?")
            .bind(m.generationId)
            .first()
        )
          return response({ error: "GENERATION_RETIRED" }, 409);
        const body = new TextEncoder().encode(JSON.stringify(m)),
          manifestHash = await digest(body);
        const prior = await env.DB.prepare(
          "SELECT * FROM generations WHERE id=?",
        )
          .bind(m.generationId)
          .first();
        if (prior && prior.manifest_hash !== manifestHash)
          return response({ error: "IDEMPOTENCY_CONFLICT" }, 409);
        if (!prior && branch.head !== m.expectedHead)
          return response({ error: "HEAD_CONFLICT" }, 409);
        await env.BUCKET.put(
          `manifests/${notebookId}/${m.generationId}.json`,
          body,
        );
        const admission = crypto.randomUUID();
        try {
          await env.DB.batch([
            gate(
              env,
              notebookId,
              admission,
              "EXISTS(SELECT 1 FROM branches WHERE notebook_id=? AND lineage_id=? AND writer_id=? AND writer_epoch=?) AND NOT EXISTS(SELECT 1 FROM retired_generations WHERE id=?)",
              [
                notebookId,
                m.lineageId,
                m.deviceId,
                m.writerEpoch,
                m.generationId,
              ],
            ),
            env.DB.prepare(
              "INSERT OR IGNORE INTO generations VALUES(?,?,?,'staging',?,?,?,?,?,?)",
            ).bind(
              m.generationId,
              notebookId,
              m.lineageId,
              m.expectedHead,
              m.deviceId,
              m.writerEpoch,
              m.snapshotSeq,
              manifestHash,
              m.createdAt,
            ),
            env.DB.prepare(
              "UPDATE notebook_state SET revision=revision+1 WHERE notebook_id=?",
            ).bind(notebookId),
            env.DB.prepare("DELETE FROM transaction_guard WHERE id=?").bind(
              admission,
            ),
          ]);
        } catch {
          return response({ error: "WRITER_REVOKED_OR_MAINTENANCE" }, 409);
        }
        const missing = [];
        for (const d of objects.values()) {
          const record = await env.DB.prepare(
            "SELECT * FROM asset_catalog WHERE notebook_id=? AND hash=? AND verified=1",
          )
            .bind(notebookId, d.hash)
            .first();
          const head = record
            ? await env.BUCKET.head(`objects/${notebookId}/${d.hash}`)
            : null;
          if (!head || head.size !== d.size) missing.push(d.hash);
        }
        return response({
          generationId: m.generationId,
          missing,
          status: prior?.status || "staging",
        });
      }

      // Object upload: validate length and SHA-256, write to R2, and record the verified object.
      const upload = tail.match(
        /^\/backup\/([a-f0-9-]{36})\/objects\/([a-f0-9]{64})$/,
      );
      if (upload && request.method === "PUT") {
        const generation = await env.DB.prepare(
          "SELECT * FROM generations WHERE id=? AND notebook_id=?",
        )
          .bind(upload[1], notebookId)
          .first();
        if (!generation || generation.status !== "staging")
          throw Error("上传 grant 不存在或已提交");
        if (!(await usable(env, generation)))
          return response({ error: "GENERATION_RETIRED" }, 409);
        const owner = await env.DB.prepare(
          "SELECT * FROM branches WHERE notebook_id=? AND lineage_id=?",
        )
          .bind(notebookId, generation.lineage_id)
          .first();
        if (
          !owner ||
          owner.writer_id !== generation.writer_id ||
          owner.writer_epoch !== generation.writer_epoch
        )
          return response({ error: "WRITER_REVOKED" }, 409);
        if ((await state(env, notebookId)).maintenance_id)
          return response({ error: "MAINTENANCE_IN_PROGRESS" }, 409);
        const manifest = await loadManifest(env, generation),
          object = descriptors(manifest).get(upload[2]);
        if (!object) throw Error("对象未获得此版本授权");
        if (Number(request.headers.get("content-length")) > objectLimit)
          throw Error("对象超过20MB");
        const bytes = await request.arrayBuffer();
        if (
          bytes.byteLength !== object.size ||
          bytes.byteLength > objectLimit ||
          (await digest(bytes)) !== upload[2]
        )
          throw Error("对象 SHA-256 校验失败");
        await env.BUCKET.put(`objects/${notebookId}/${upload[2]}`, bytes);
        await env.DB.prepare(
          "INSERT INTO asset_catalog VALUES(?,?,?,1) ON CONFLICT(notebook_id,hash) DO UPDATE SET size=excluded.size,verified=1",
        )
          .bind(notebookId, upload[2], bytes.byteLength)
          .run();
        return response({ verified: true });
      }

      // Commit: verify object completeness, compute the entity delta, and atomically publish the branch head via CAS.
      const commit = tail.match(/^\/backup\/([a-f0-9-]{36})\/commit$/);
      if (commit && request.method === "POST") {
        const generation = await env.DB.prepare(
          "SELECT * FROM generations WHERE id=? AND notebook_id=?",
        )
          .bind(commit[1], notebookId)
          .first();
        if (!generation) throw Error("版本不存在");
        if (!(await usable(env, generation)))
          return response({ error: "GENERATION_RETIRED" }, 409);
        if (generation.status === "committed")
          return response({
            generationId: generation.id,
            snapshotSeq: generation.snapshot_seq,
          });
        const expected = await json(request);
        if (
          expected.expectedHead !== generation.expected_head ||
          expected.writerEpoch !== generation.writer_epoch
        )
          return response({ error: "HEAD_CONFLICT" }, 409);
        const m = await loadManifest(env, generation);
        for (const d of descriptors(m).values()) {
          const head = await env.BUCKET.head(`objects/${notebookId}/${d.hash}`),
            catalog = await env.DB.prepare(
              "SELECT verified FROM asset_catalog WHERE notebook_id=? AND hash=?",
            )
              .bind(notebookId, d.hash)
              .first();
          if (!head || head.size !== d.size || !catalog?.verified)
            return response({ error: "ASSET_MISSING" }, 409);
        }
        let previous: import("@anynote/types/runtime.js").Entity[] = [];
        if (generation.expected_head) {
          const base = await env.DB.prepare(
            "SELECT * FROM generations WHERE id=? AND notebook_id=? AND status='committed'",
          )
            .bind(generation.expected_head, notebookId)
            .first();
          if (!base) throw Error("base generation 不存在");
          previous = (await loadManifest(env, base)).entities;
        }
        const previousMap = new Map(previous.map((e) => [e.key, e.hash])),
          current = new Set(m.entities.map((e) => e.key));
        const changes: {
          key: string;
          table: string;
          hash: string | null;
          operation: string;
        }[] = m.entities
          .filter((e) => previousMap.get(e.key) !== e.hash)
          .map((e) => ({
            key: e.key,
            table: e.table,
            hash: e.hash,
            operation: "upsert",
          }));
        for (const e of previous)
          if (!current.has(e.key))
            changes.push({
              key: e.key,
              table: e.table,
              hash: null,
              operation: "delete",
            });
        for (let start = 0; start < changes.length; start += 80) {
          await env.DB.batch(
            changes
              .slice(start, start + 80)
              .map((e) =>
                env.DB.prepare(
                  "INSERT OR REPLACE INTO generation_deltas VALUES(?,?,?,?,?)",
                ).bind(generation.id, e.key, e.table, e.hash, e.operation),
              ),
          );
        }
        try {
          await env.DB.batch([
            env.DB.prepare(
              "INSERT INTO transaction_guard SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM branches WHERE notebook_id=? AND lineage_id=? AND head=? AND writer_id=? AND writer_epoch=?) AND EXISTS(SELECT 1 FROM notebook_state WHERE notebook_id=? AND maintenance_id IS NULL) AND NOT EXISTS(SELECT 1 FROM retired_generations WHERE id=?) THEN 1 ELSE 0 END",
            ).bind(
              generation.id,
              notebookId,
              generation.lineage_id,
              generation.expected_head,
              generation.writer_id,
              generation.writer_epoch,
              notebookId,
              generation.id,
            ),
            env.DB.prepare(
              "UPDATE branches SET head=? WHERE notebook_id=? AND lineage_id=?",
            ).bind(generation.id, notebookId, generation.lineage_id),
            env.DB.prepare(
              "UPDATE generations SET status='committed' WHERE id=?",
            ).bind(generation.id),
            env.DB.prepare(
              "UPDATE notebook_state SET revision=revision+1 WHERE notebook_id=?",
            ).bind(notebookId),
            env.DB.prepare("DELETE FROM transaction_guard WHERE id=?").bind(
              generation.id,
            ),
          ]);
        } catch {
          return response({ error: "HEAD_CONFLICT" }, 409);
        }
        return response({
          generationId: generation.id,
          snapshotSeq: generation.snapshot_seq,
        });
      }

      // List committed versions of a branch.
      if (tail === "/backups" && request.method === "GET") {
        const lineage = url.searchParams.get("lineageId");
        if (!uuid.test(lineage || "")) throw Error("lineageId 无效");
        const rows = await env.DB.prepare(
          "SELECT id,created_at AS createdAt,snapshot_seq AS snapshotSeq FROM generations WHERE notebook_id=? AND lineage_id=? AND status='committed' AND NOT EXISTS(SELECT 1 FROM retired_generations r WHERE r.id=generations.id) ORDER BY created_at DESC LIMIT 100",
        )
          .bind(notebookId, lineage)
          .all();
        return response({ items: rows.results });
      }

      // Read the manifest of a committed version.
      const manifest = tail.match(/^\/backups\/([a-f0-9-]{36})\/manifest$/);
      if (manifest && request.method === "GET") {
        const generation = await env.DB.prepare(
          "SELECT * FROM generations WHERE notebook_id=? AND id=? AND status='committed'",
        )
          .bind(notebookId, manifest[1])
          .first();
        if (!generation || !(await usable(env, generation)))
          return response({ error: "版本未提交" }, 404);
        return response(await loadManifest(env, generation));
      }

      // Download a verified object.
      const object = tail.match(/^\/objects\/([a-f0-9]{64})$/);
      if (object && request.method === "GET") {
        const verified = await env.DB.prepare(
          "SELECT verified FROM asset_catalog WHERE notebook_id=? AND hash=?",
        )
          .bind(notebookId, object[1])
          .first();
        if (!verified?.verified) return response({ error: "对象未验证" }, 404);
        const data = await env.BUCKET.get(`objects/${notebookId}/${object[1]}`);
        if (!data) return response({ error: "对象缺失" }, 404);
        return new Response(
          data.body as unknown as ReadableStream<Uint8Array>,
          {
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Length": String(data.size),
              "Cache-Control": "private,no-store",
            },
          },
        );
      }

      // Query one generation's status (to confirm after a lost commit response).
      const status = tail.match(/^\/backup\/([a-f0-9-]{36})$/);
      if (status && request.method === "GET") {
        const generation = await env.DB.prepare(
          "SELECT id,status,snapshot_seq AS snapshotSeq FROM generations WHERE id=? AND notebook_id=?",
        )
          .bind(status[1], notebookId)
          .first();
        return generation && (await usable(env, generation))
          ? response(generation)
          : response({ error: "版本不存在" }, 404);
      }
      return response({ error: "接口不存在" }, 404);
    } catch (e: any) {
      return response({ error: e.message || "请求失败" }, 400);
    }
  },
};
