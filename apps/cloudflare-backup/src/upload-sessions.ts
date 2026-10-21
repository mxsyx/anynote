import type { R2MultipartUpload } from "@cloudflare/workers-types";
import type { WorkerEnv } from "@anynote/types/runtime.js";
import { gate } from "./maintenance.js";

export function missingUpload(error: unknown) {
  const e = error as { code?: number; message?: string };
  return e?.code === 10024 || /\(10024\)/.test(e?.message || "");
}

/** Register both transport and verified-copy sessions before sending any part bytes. */
export function uploadSessions(
  env: WorkerEnv,
  book: string,
  generation: string,
) {
  return {
    async created(upload: R2MultipartUpload, key: string) {
      const guard = crypto.randomUUID();
      try {
        await env.DB.batch([
          gate(
            env,
            book,
            guard,
            "EXISTS(SELECT 1 FROM generations g JOIN branches b ON b.notebook_id=g.notebook_id AND b.lineage_id=g.lineage_id WHERE g.id=? AND g.status='staging' AND b.writer_id=g.writer_id AND b.writer_epoch=g.writer_epoch) AND NOT EXISTS(SELECT 1 FROM retired_generations WHERE id=?) AND (SELECT count(*) FROM multipart_sessions WHERE notebook_id=?)<2000",
            [generation, generation, book],
          ),
          env.DB.prepare(
            "INSERT INTO multipart_sessions VALUES(?,?,?,?,?)",
          ).bind(upload.uploadId, book, generation, key, Date.now()),
          env.DB.prepare(
            "UPDATE notebook_state SET revision=revision+1 WHERE notebook_id=?",
          ).bind(book),
          env.DB.prepare("DELETE FROM transaction_guard WHERE id=?").bind(
            guard,
          ),
        ]);
      } catch (error) {
        await upload.abort();
        throw error;
      }
    },
    async exists(id: string, key: string) {
      return !!(await env.DB.prepare(
        "SELECT upload_id FROM multipart_sessions WHERE upload_id=? AND notebook_id=? AND generation_id=? AND object_key=?",
      )
        .bind(id, book, generation, key)
        .first());
    },
    async removed(id: string) {
      await env.DB.prepare(
        "DELETE FROM multipart_sessions WHERE upload_id=? AND notebook_id=?",
      )
        .bind(id, book)
        .run();
    },
  };
}

/** R2 abort is idempotent, including an upload that completed before its cleanup checkpoint. */
export async function abortUpload(
  env: WorkerEnv,
  book: string,
  id: string,
  key: string,
) {
  const row = await env.DB.prepare(
    "SELECT upload_id FROM multipart_sessions WHERE upload_id=? AND notebook_id=? AND object_key=?",
  )
    .bind(id, book, key)
    .first();
  if (!row) return;
  try {
    await env.BUCKET.resumeMultipartUpload(key, id).abort();
  } catch (error) {
    if (!missingUpload(error)) throw error;
  }
  await env.DB.prepare(
    "DELETE FROM multipart_sessions WHERE upload_id=? AND notebook_id=?",
  )
    .bind(id, book)
    .run();
}
