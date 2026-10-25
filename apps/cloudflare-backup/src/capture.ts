import { z } from "zod";
import {
  captureManifestSchema,
  captureDigest,
  sha256,
  validateCapture,
} from "@anynote/capture/format.js";
import { localizeBody } from "@anynote/capture/markdown.js";
import { resourceIds } from "@anynote/protocol/markdown.js";
import {
  browseSchema,
  captureTargetSchema,
  captureAcksSchema,
  libraryNoteSchema,
} from "@anynote/protocol/cloud-capture.js";
import type {
  SnapshotManifest,
  WorkerEnv,
  SqlRow,
} from "@anynote/types/runtime.js";
import { gate, state, usable } from "./maintenance.js";

const uuid = z.string().uuid(),
  number = z.number().int().nonnegative().safe();
const response = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
function fail(message: string, status = 400): never {
  throw Object.assign(Error(message), { status });
}
async function bytes(request: Request, max: number) {
  if (Number(request.headers.get("content-length")) > max)
    fail("请求超过预算", 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(),
    parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      total += r.value.length;
      if (total > max) fail("请求超过预算", 413);
      parts.push(r.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}
async function json(request: Request, max = 1024 * 1024 + 16384) {
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(await bytes(request, max)),
  );
}
function secret() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
}
async function tokenHash(value: string) {
  return sha256(new TextEncoder().encode(value));
}

async function manifest(
  env: WorkerEnv,
  generation: SqlRow,
): Promise<SnapshotManifest> {
  const object = await env.BUCKET.get(
    `manifests/${generation.notebook_id}/${generation.id}.json`,
  );
  if (!object) fail("备份清单不可用", 409);
  const data = new Uint8Array(await object.arrayBuffer());
  if ((await sha256(data)) !== generation.manifest_hash)
    fail("备份清单校验失败", 409);
  return JSON.parse(new TextDecoder().decode(data));
}
async function objectJson(
  env: WorkerEnv,
  book: string,
  descriptor: { hash: string; size: number },
) {
  const object = await env.BUCKET.get(`objects/${book}/${descriptor.hash}`);
  if (!object || object.size !== descriptor.size) fail("浏览对象不可用", 409);
  const data = new Uint8Array(await object.arrayBuffer());
  if ((await sha256(data)) !== descriptor.hash) fail("浏览对象校验失败", 409);
  return JSON.parse(new TextDecoder().decode(data));
}

/** These writes are appended to the existing generation publication transaction. */
export async function captureAcknowledgments(
  env: WorkerEnv,
  m: SnapshotManifest,
) {
  if (!m.captureAcks) return [];
  const values = captureAcksSchema.parse(
    await objectJson(env, m.notebookId, m.captureAcks),
  );
  return values.map((ack) =>
    env.DB.prepare(
      "UPDATE captures SET status='backedUp',backed_up_generation=?,claim_id=NULL,claim_until=0 WHERE id=? AND digest=? AND notebook_id=? AND lineage_id=? AND status='applied' AND note_id=? AND applied_seq=? AND applied_seq<=? AND writer_id=? AND writer_epoch=?",
    ).bind(
      m.generationId,
      ack.captureId,
      ack.digest,
      m.notebookId,
      m.lineageId,
      ack.noteId,
      ack.appliedSeq,
      m.snapshotSeq,
      m.deviceId,
      m.writerEpoch,
    ),
  );
}

/** Device credentials are intentionally accepted only by these narrowly scoped routes. */
export async function captureRoutes(
  request: Request,
  env: WorkerEnv,
  admin: boolean,
): Promise<Response | null> {
  const url = new URL(request.url),
    path = url.pathname;
  if (
    !/^\/v1\/(pairings|devices|library|captures)(?:\/|$)/.test(path) &&
    !(path === "/v1/capabilities" && !admin)
  )
    return null;
  try {
    if (path === "/v1/pairings/redeem" && request.method === "POST") {
      const { code } = z
        .object({ code: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(await json(request, 1024));
      const hash = await tokenHash(code),
        token = secret(),
        id = crypto.randomUUID(),
        expires = Date.now() + 30 * 86400000;
      const row = await env.DB.prepare(
        "SELECT * FROM capture_pairings WHERE code_hash=? AND expires_at>?",
      )
        .bind(hash, Date.now())
        .first();
      if (!row) fail("配对码无效或已过期", 401);
      const guard = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO transaction_guard SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM capture_pairings WHERE code_hash=? AND expires_at>?) THEN 1 ELSE 0 END",
        ).bind(guard, hash, Date.now()),
        env.DB.prepare("INSERT INTO capture_devices VALUES(?,?,?,?,?,0)").bind(
          id,
          await tokenHash(token),
          row.notebook_id,
          row.lineage_id,
          expires,
        ),
        env.DB.prepare("DELETE FROM capture_pairings WHERE code_hash=?").bind(
          hash,
        ),
        env.DB.prepare("DELETE FROM transaction_guard WHERE id=?").bind(guard),
      ]);
      return response({
        deviceId: id,
        token,
        expiresAt: expires,
        notebookId: row.notebook_id,
        lineageId: row.lineage_id,
      });
    }
    let device: SqlRow | null = null;
    if (!admin) {
      const authorization = request.headers.get("Authorization") || "";
      if (!/^Bearer [a-f0-9]{64}$/.test(authorization)) fail("鉴权失败", 401);
      device = await env.DB.prepare(
        "SELECT * FROM capture_devices WHERE token_hash=? AND revoked=0 AND expires_at>?",
      )
        .bind(await tokenHash(authorization.slice(7)), Date.now())
        .first();
      if (!device) fail("设备授权无效或已过期", 401);
    }
    function scope(book: string, lineage: string) {
      if (
        device &&
        (book !== device.notebook_id || lineage !== device.lineage_id)
      )
        fail("无权访问该笔记本", 403);
    }
    if (path === "/v1/capabilities")
      return response({
        protocolVersion: 1,
        schemaVersions: [5],
        capabilities: ["capture-v1", "browse-snapshot-v1"],
      });
    if (path === "/v1/pairings" && request.method === "POST") {
      if (!admin) fail("需要桌面授权", 403);
      const p = z
        .object({ notebookId: uuid, lineageId: uuid })
        .strict()
        .parse(await json(request, 1024));
      if (
        !(await env.DB.prepare(
          "SELECT 1 FROM branches WHERE notebook_id=? AND lineage_id=? AND head!=''",
        )
          .bind(p.notebookId, p.lineageId)
          .first())
      )
        fail("请先完成一次云备份", 409);
      await env.DB.prepare("DELETE FROM capture_pairings WHERE expires_at<=?")
        .bind(Date.now())
        .run();
      const code = secret(),
        expiresAt = Date.now() + 5 * 60000;
      await env.DB.prepare("INSERT INTO capture_pairings VALUES(?,?,?,?)")
        .bind(await tokenHash(code), p.notebookId, p.lineageId, expiresAt)
        .run();
      return response({ code, expiresAt });
    }
    if (path === "/v1/devices" && request.method === "GET") {
      if (!admin) fail("需要桌面授权", 403);
      return response(
        (
          await env.DB.prepare(
            "SELECT id,notebook_id AS notebookId,lineage_id AS lineageId,expires_at AS expiresAt,revoked FROM capture_devices ORDER BY expires_at DESC LIMIT 100",
          ).all()
        ).results,
      );
    }
    const revoke = path.match(/^\/v1\/devices\/([a-f0-9-]{36})$/);
    if (revoke && request.method === "DELETE") {
      if (!admin) fail("需要桌面授权", 403);
      await env.DB.prepare("UPDATE capture_devices SET revoked=1 WHERE id=?")
        .bind(revoke[1])
        .run();
      return response({ ok: true });
    }
    if (path === "/v1/library/notebooks" && request.method === "GET") {
      const rows = (
        await env.DB.prepare(
          "SELECT b.notebook_id AS notebookId,b.lineage_id AS lineageId,g.id AS generationId,g.created_at AS publishedAt FROM branches b JOIN generations g ON g.id=b.head WHERE g.status='committed' AND (? IS NULL OR (b.notebook_id=? AND b.lineage_id=?)) ORDER BY g.created_at DESC LIMIT 100",
        )
          .bind(
            device?.notebook_id ?? null,
            device?.notebook_id ?? null,
            device?.lineage_id ?? null,
          )
          .all()
      ).results;
      return response(rows);
    }
    const library = path.match(
      /^\/v1\/library\/([a-f0-9-]{36})\/([a-f0-9-]{36})\/([a-f0-9-]{36})\/(tree|notes\/([a-f0-9-]{36})(?:\/resources\/([a-f0-9-]{36}))?)$/,
    );
    if (library && request.method === "GET") {
      const [, book, lineage, generationId, route, noteId, resourceId] =
        library;
      scope(book, lineage);
      const generation = await env.DB.prepare(
        "SELECT * FROM generations WHERE id=? AND notebook_id=? AND lineage_id=? AND status='committed'",
      )
        .bind(generationId, book, lineage)
        .first();
      if (!generation || !(await usable(env, generation)))
        fail("备份版本不可用，请刷新", 409);
      await state(env, book);
      const guard = crypto.randomUUID(),
        pin = `browse.${device?.id || "admin"}.${generationId}`;
      await env.DB.batch([
        gate(
          env,
          book,
          guard,
          "NOT EXISTS(SELECT 1 FROM retired_generations WHERE id=?)",
          [generationId],
        ),
        env.DB.prepare(
          "INSERT INTO restore_pins VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at",
        ).bind(pin, book, generationId, Date.now() + 15 * 60000),
        env.DB.prepare("DELETE FROM transaction_guard WHERE id=?").bind(guard),
      ]);
      const m = await manifest(env, generation);
      if (!m.browse) fail("此备份没有浏览数据，请从桌面发布新备份", 409);
      const browse = browseSchema.parse(m.browse);
      const parent = url.searchParams.get("parentId") || "root",
        page = Number(url.searchParams.get("page") || 0);
      if (
        route === "tree" &&
        ((parent !== "root" && !uuid.safeParse(parent).success) ||
          !Number.isSafeInteger(page) ||
          page < 0)
      )
        fail("目录分页无效");
      const key =
          route === "tree" ? `tree/${parent}/${page}` : `note/${noteId}`,
        entry = browse.objects.find((o) => o.path === key);
      if (!entry) {
        if (route === "tree") return response({ nodes: [], next: null });
        fail("笔记不存在", 404);
      }
      const value = await objectJson(env, book, entry);
      if (!resourceId) return response(value);
      const note = libraryNoteSchema.parse(value),
        resource = note.resources.find((r) => r.id === resourceId);
      if (!resource) fail("资源不属于该笔记版本", 404);
      const object = await env.BUCKET.get(`objects/${book}/${resource.hash}`);
      if (!object || object.size !== resource.size) fail("资源不可用", 409);
      return new Response(object.body as unknown as BodyInit, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(resource.name)}`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (path === "/v1/captures/plan" && request.method === "POST") {
      if (!device) fail("请使用采集设备授权", 403);
      const p = z
        .object({
          manifest: captureManifestSchema,
          target: captureTargetSchema,
        })
        .strict()
        .parse(await json(request));
      scope(p.target.notebookId, p.target.lineageId);
      const generation = await env.DB.prepare(
        "SELECT * FROM generations WHERE id=? AND notebook_id=? AND lineage_id=? AND status='committed'",
      )
        .bind(
          p.target.observedGenerationId,
          p.target.notebookId,
          p.target.lineageId,
        )
        .first();
      if (!generation || !(await usable(env, generation)))
        fail("目录版本已失效，请刷新", 409);
      const digest = await captureDigest(p.manifest),
        prior = await env.DB.prepare("SELECT * FROM captures WHERE id=?")
          .bind(p.manifest.captureId)
          .first();
      if (
        prior &&
        (prior.owner_id !== device.id ||
          prior.digest !== digest ||
          prior.notebook_id !== p.target.notebookId ||
          prior.lineage_id !== p.target.lineageId ||
          prior.parent_id !== p.target.parentId)
      )
        fail("采集身份冲突", 409);
      const count = await env.DB.prepare(
        "SELECT count(*) AS count FROM captures WHERE notebook_id=? AND cleared!=1",
      )
        .bind(p.target.notebookId)
        .first();
      if (!prior && count!.count >= 100)
        fail("云端采集箱已满，请清理已备份的采集副本", 409);
      const guard = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO transaction_guard SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM captures WHERE id=?) OR (SELECT count(*) FROM captures WHERE notebook_id=? AND cleared!=1)<100 THEN 1 ELSE 0 END",
        ).bind(guard, p.manifest.captureId, p.target.notebookId),
        env.DB.prepare(
          "INSERT OR IGNORE INTO captures(id,owner_id,notebook_id,lineage_id,parent_id,observed_generation,digest,manifest_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        ).bind(
          p.manifest.captureId,
          device.id,
          p.target.notebookId,
          p.target.lineageId,
          p.target.parentId,
          p.target.observedGenerationId,
          digest,
          JSON.stringify(p.manifest),
          Date.now(),
        ),
        env.DB.prepare("DELETE FROM transaction_guard WHERE id=?").bind(guard),
      ]);
      const actual = await env.DB.prepare("SELECT * FROM captures WHERE id=?")
        .bind(p.manifest.captureId)
        .first();
      if (
        !actual ||
        actual.owner_id !== device.id ||
        actual.digest !== digest ||
        actual.parent_id !== p.target.parentId
      )
        fail("采集身份冲突", 409);
      const uploaded = (
        await env.DB.prepare(
          "SELECT hash FROM capture_objects WHERE capture_id=?",
        )
          .bind(p.manifest.captureId)
          .all()
      ).results.map((r) => r.hash);
      return response({
        id: p.manifest.captureId,
        status: actual.status,
        missing: (actual.cleared ? [] : [p.manifest.body, ...p.manifest.assets])
          .filter((a) => !uploaded.includes(a.sha256))
          .map((a) => a.sha256),
      });
    }
    if (path === "/v1/captures" && request.method === "GET") {
      if (!device) fail("请使用采集设备授权", 403);
      return response(
        (
          await env.DB.prepare(
            "SELECT id,status,created_at AS createdAt,note_id AS noteId,cleared FROM captures WHERE owner_id=? AND notebook_id=? AND lineage_id=? ORDER BY cleared ASC,created_at DESC LIMIT 100",
          )
            .bind(device.id, device.notebook_id, device.lineage_id)
            .all()
        ).results,
      );
    }
    if (path === "/v1/captures/pending-acks" && request.method === "POST") {
      if (!admin) fail("需要桌面授权", 403);
      const p = z
        .object({ notebookId: uuid, lineageId: uuid })
        .strict()
        .parse(await json(request, 1024));
      return response(
        (
          await env.DB.prepare(
            "SELECT id FROM captures WHERE notebook_id=? AND lineage_id=? AND status='applied' ORDER BY created_at LIMIT 20",
          )
            .bind(p.notebookId, p.lineageId)
            .all()
        ).results.map((r) => r.id),
      );
    }
    if (path === "/v1/captures/claim" && request.method === "POST") {
      if (!admin) fail("需要当前桌面 writer", 403);
      const p = z
        .object({
          notebookId: uuid,
          lineageId: uuid,
          deviceId: uuid,
          writerEpoch: number,
          exclude: z.array(uuid).max(100).default([]),
        })
        .strict()
        .parse(await json(request, 8192));
      const claimId = crypto.randomUUID();
      const row = await env.DB.prepare(
        "UPDATE captures SET claim_id=?,claim_until=?,writer_id=?,writer_epoch=? WHERE id=(SELECT c.id FROM captures c JOIN branches b ON b.notebook_id=c.notebook_id AND b.lineage_id=c.lineage_id WHERE c.notebook_id=? AND c.lineage_id=? AND c.id NOT IN (SELECT value FROM json_each(?)) AND c.status IN ('queued','applied') AND (c.claim_until<? OR c.writer_epoch!=b.writer_epoch OR c.writer_id!=b.writer_id) AND b.writer_id=? AND b.writer_epoch=? ORDER BY c.created_at LIMIT 1) RETURNING *",
      )
        .bind(
          claimId,
          Date.now() + 20 * 60000,
          p.deviceId,
          p.writerEpoch,
          p.notebookId,
          p.lineageId,
          JSON.stringify(p.exclude),
          Date.now(),
          p.deviceId,
          p.writerEpoch,
        )
        .first();
      return response(
        row
          ? {
              id: row.id,
              manifest: JSON.parse(row.manifest_json),
              parentId: row.parent_id,
              targetVersion: row.target_version,
              claimId,
            }
          : null,
      );
    }
    const route = path.match(
      /^\/v1\/captures\/([a-f0-9-]{36})(?:\/(objects\/([a-f0-9]{64})|commit|status|ack|target))?$/,
    );
    if (route) {
      const [, id, operation, hash] = route;
      const row = await env.DB.prepare("SELECT * FROM captures WHERE id=?")
        .bind(id)
        .first();
      if (!row || (device && row.owner_id !== device.id))
        fail("采集不存在", 404);
      scope(row.notebook_id, row.lineage_id);
      const m = captureManifestSchema.parse(JSON.parse(row.manifest_json));
      const descriptor = [m.body, ...m.assets].find((a) => a.sha256 === hash);
      if (!operation && request.method === "DELETE") {
        if (row.status !== "backedUp") fail("只能清理已备份的采集副本", 409);
        await env.DB.prepare(
          "UPDATE captures SET cleared=2 WHERE id=? AND status='backedUp'",
        )
          .bind(id)
          .run();
        for (const asset of [m.body, ...m.assets])
          await env.BUCKET.delete(`captures/${id}/${asset.sha256}`);
        await env.DB.prepare("DELETE FROM capture_objects WHERE capture_id=?")
          .bind(id)
          .run();
        await env.DB.prepare("UPDATE captures SET cleared=1 WHERE id=?")
          .bind(id)
          .run();
        return response({ ok: true });
      }
      if (hash && request.method === "PUT") {
        if (!device || row.status !== "uploading" || !descriptor)
          fail("采集上传状态无效", 409);
        const data = await bytes(request, descriptor.size);
        if (data.length !== descriptor.size || (await sha256(data)) !== hash)
          fail("采集资源校验失败");
        await env.BUCKET.put(`captures/${id}/${hash}`, data);
        await env.DB.prepare(
          "INSERT OR IGNORE INTO capture_objects VALUES(?,?,?)",
        )
          .bind(id, hash, data.length)
          .run();
        return response({ verified: true });
      }
      if (hash && request.method === "GET") {
        if (!descriptor || row.status === "uploading") fail("资源不存在", 404);
        if (row.cleared) fail("采集副本已清理，请查看正式笔记", 410);
        const object = await env.BUCKET.get(`captures/${id}/${hash}`);
        if (!object) fail("资源不可用", 409);
        return new Response(object.body as unknown as BodyInit, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      if (operation === "commit" && request.method === "POST") {
        if (!device) fail("需要采集设备授权", 403);
        if (row.status !== "uploading")
          return response({ id, status: row.status });
        for (const object of [m.body, ...m.assets]) {
          const verified = await env.DB.prepare(
            "SELECT size FROM capture_objects WHERE capture_id=? AND hash=?",
          )
            .bind(id, object.sha256)
            .first();
          if (!verified || verified.size !== object.size)
            fail("采集资源未上传完整", 409);
        }
        const content = await env.BUCKET.get(`captures/${id}/${m.body.sha256}`);
        if (!content) fail("采集正文缺失", 409);
        const body = new TextDecoder("utf-8", { fatal: true }).decode(
          await content.arrayBuffer(),
        );
        await validateCapture({ manifest: m, body });
        if (resourceIds(body).length) fail("采集含已有笔记资源引用");
        localizeBody(body, new Map(m.assets.map((a) => [a.path, a.path])));
        await env.DB.prepare(
          "UPDATE captures SET status='queued' WHERE id=? AND status='uploading'",
        )
          .bind(id)
          .run();
        return response({ id, status: "queued" });
      }
      if (operation === "ack" && request.method === "POST") {
        if (!admin) fail("需要当前桌面 writer", 403);
        const p = z
          .object({
            claimId: uuid,
            targetVersion: number,
            noteId: uuid.optional(),
            appliedSeq: number.optional(),
            needsTarget: z.boolean().optional(),
          })
          .strict()
          .parse(await json(request, 2048));
        if (!p.needsTarget && (!p.noteId || p.appliedSeq === undefined))
          fail("归入回执不完整");
        const result = await env.DB.prepare(
          "UPDATE captures SET status=?,note_id=?,applied_seq=?,claim_until=0 WHERE id=? AND claim_id=? AND target_version=? AND claim_until>? AND status IN ('queued','applied') AND EXISTS(SELECT 1 FROM branches WHERE notebook_id=captures.notebook_id AND lineage_id=captures.lineage_id AND writer_id=captures.writer_id AND writer_epoch=captures.writer_epoch) RETURNING id",
        )
          .bind(
            p.needsTarget ? "needs-target" : "applied",
            p.noteId ?? null,
            p.appliedSeq ?? null,
            id,
            p.claimId,
            p.targetVersion,
            Date.now(),
          )
          .first();
        if (!result) fail("采集领取已失效", 409);
        return response({ ok: true });
      }
      if (operation === "target" && request.method === "POST") {
        const p = z
          .object({ parentId: uuid.nullable(), targetVersion: number })
          .strict()
          .parse(await json(request, 1024));
        const result = await env.DB.prepare(
          "UPDATE captures SET parent_id=?,target_version=target_version+1,status='queued' WHERE id=? AND target_version=? AND status IN ('queued','needs-target') AND claim_until<=? RETURNING target_version",
        )
          .bind(p.parentId, id, p.targetVersion, Date.now())
          .first();
        if (!result) fail("采集正在归入或目标版本已变化", 409);
        return response(result);
      }
      if ((!operation || operation === "status") && request.method === "GET")
        return response({
          id,
          status: row.status,
          cleared: row.cleared,
          manifest: m,
          parentId: row.parent_id,
          targetVersion: row.target_version,
          noteId: row.note_id,
        });
    }
    return response({ error: "不支持的采集操作" }, 404);
  } catch (error) {
    return response(
      { error: error instanceof Error ? error.message : "采集请求失败" },
      (error as { status?: number }).status || 400,
    );
  }
}
