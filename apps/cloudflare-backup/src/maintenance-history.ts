import type { SqlRow, WorkerEnv } from "@anynote/types/runtime.js";

export const stagingGrace = 7 * 86400000;
const historyAge = 10 * 60 * 1000;
const batchSize = 64;

/** Immutable per-identity receipts live outside the bounded D1 working set. */
const key = (book: string, kind: string, id: string) =>
  `maintenance/${book}/${kind}/${id}.json`;

export async function archived(
  env: WorkerEnv,
  book: string,
  kind: string,
  id: string,
): Promise<SqlRow | null> {
  const object = await env.BUCKET.get(key(book, kind, id));
  if (!object) return null;
  const receipt = JSON.parse(
    new TextDecoder().decode(await object.arrayBuffer()),
  );
  if (
    !receipt ||
    typeof receipt !== "object" ||
    receipt.id !== id ||
    receipt.notebook_id !== book
  )
    throw Error("维护归档身份无效，拒绝重放");
  return receipt;
}

/** Refresh admission before reading upload bytes. Revision changes invalidate cleanup previews. */
export async function touchStaging(env: WorkerEnv, id: string, book: string) {
  const guard = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO transaction_guard SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM notebook_state WHERE notebook_id=? AND maintenance_id IS NULL) AND EXISTS(SELECT 1 FROM generations WHERE id=? AND notebook_id=? AND status='staging') AND NOT EXISTS(SELECT 1 FROM retired_generations WHERE id=?) THEN 1 ELSE 0 END",
    ).bind(guard, book, id, book, id),
    env.DB.prepare(
      "INSERT INTO generation_activity VALUES(?,?) ON CONFLICT(id) DO UPDATE SET touched_at=excluded.touched_at",
    ).bind(id, Date.now()),
    env.DB.prepare(
      "UPDATE notebook_state SET revision=revision+1 WHERE notebook_id=?",
    ).bind(book),
    env.DB.prepare("DELETE FROM transaction_guard WHERE id=?").bind(guard),
  ]);
}

/**
 * Run only while holding the notebook maintenance gate and execution lock.
 * Archive-before-delete is retryable across R2/D1 failures. Receipts deliberately
 * remain in R2: dropping them would permit replay of a retired generation ID.
 * Bounded pages keep old receipts out of generation/reference planning budgets.
 */
export async function archiveHistory(
  env: WorkerEnv,
  book: string,
  activeId: string,
) {
  const groups = [
    {
      table: "retired_generations",
      kind: "retired",
      where:
        "NOT EXISTS(SELECT 1 FROM generations g WHERE g.id=retired_generations.id)",
    },
    {
      table: "writer_claims",
      kind: "claims",
      where:
        "NOT EXISTS(SELECT 1 FROM branches b WHERE b.notebook_id=writer_claims.notebook_id AND b.lineage_id=writer_claims.lineage_id AND b.writer_epoch=writer_claims.new_epoch)",
    },
    {
      table: "retention_plans",
      kind: "plans",
      where: `id<>? AND execution_id IS NULL AND (status='completed' OR (status='planned' AND created_at<?))`,
      bindings: [activeId, Date.now() - historyAge],
    },
  ];
  let pending = false;
  for (const group of groups) {
    const rows = (
      await env.DB.prepare(
        `SELECT * FROM ${group.table} WHERE notebook_id=? AND ${group.where} ORDER BY id LIMIT ?`,
      )
        .bind(book, ...(group.bindings || []), batchSize)
        .all()
    ).results;
    for (const row of rows) {
      await env.BUCKET.put(key(book, group.kind, row.id), JSON.stringify(row));
      await env.DB.prepare(
        `DELETE FROM ${group.table} WHERE id=? AND notebook_id=?`,
      )
        .bind(row.id, book)
        .run();
    }
    pending ||= rows.length === batchSize;
  }
  await env.DB.prepare(
    "DELETE FROM restore_pins WHERE notebook_id=? AND expires_at<=?",
  )
    .bind(book, Date.now())
    .run();
  return pending;
}

/** Expired, unconfirmed previews have no deletion authority; archive bounded pages on preview. */
export async function archivePreviews(env: WorkerEnv, book: string) {
  const cutoff = Date.now() - historyAge;
  const rows = (
    await env.DB.prepare(
      "SELECT * FROM retention_plans WHERE notebook_id=? AND status='planned' AND created_at<? AND execution_id IS NULL ORDER BY created_at LIMIT ?",
    )
      .bind(book, cutoff, batchSize)
      .all()
  ).results;
  for (const row of rows) {
    await env.BUCKET.put(key(book, "plans", row.id), JSON.stringify(row));

    // An apply that started before expiry may have acquired the gate meanwhile.
    await env.DB.prepare(
      "DELETE FROM retention_plans WHERE id=? AND status='planned' AND created_at<? AND execution_id IS NULL",
    )
      .bind(row.id, cutoff)
      .run();
  }
}
