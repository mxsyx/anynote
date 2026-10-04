import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Storage } from "@anynote/storage-sqlite/index.js";
import type { SqlRow } from "@anynote/types/runtime.js";
const input = z
  .object({
    notebookId: z.string().uuid(),
    id: z.string().uuid(),
    expectedRevision: z.number().int().positive().optional(),
    body: z.string().max(2_000_000).optional(),
    reason: z.string().max(1000).optional(),
    proposalId: z.string().uuid().optional(),
  })
  .strict();
export function proposalOperation(
  s: Storage,
  op: string,
  raw: unknown,
  save: import("@anynote/storage-sqlite/operations.js").SaveNote,
) {
  const p = input.parse(raw),
    db = s.open(p.notebookId),
    note = s.get(db, p.id);
  if (op === "proposePatch") {
    if (!p.body) throw Error("提案内容为空");
    if (note.revision !== p.expectedRevision)
      throw Error("版本冲突：提案基于旧版本");
    const proposal = {
      id: randomUUID(),
      noteId: p.id,
      expectedRevision: note.revision,
      before: note.body,
      after: p.body,
      reason: p.reason || "用户授权的整理提案",
      status: "proposed",
      createdAt: Date.now(),
    };
    db.prepare(
      "INSERT INTO extension_data(extension_id,key,value_json) VALUES(?,?,?)",
    ).run("anynote.ai.proposals", proposal.id, JSON.stringify(proposal));
    return proposal;
  }
  const row = db
    .prepare(
      "SELECT value_json FROM extension_data WHERE extension_id=? AND key=?",
    )
    .get("anynote.ai.proposals", p.proposalId!);
  if (!row) throw Error("提案不存在");
  const proposal = JSON.parse(row.value_json);
  if (proposal.noteId !== p.id) throw Error("提案目标不匹配");
  if (op === "applyProposal") {
    if (proposal.status === "applied") return note;
    if (
      proposal.status !== "proposed" ||
      note.revision !== proposal.expectedRevision
    )
      throw Error("版本冲突：请重新生成提案");
    return save(
      s,
      db,
      { ...p, expectedRevision: proposal.expectedRevision },
      proposal.after,
      [],
      "ai-proposal",
      (saved: SqlRow) => {
        proposal.status = "applied";
        proposal.appliedRevision = saved.revision;
        db.prepare(
          "UPDATE extension_data SET value_json=?,revision=revision+1 WHERE extension_id=? AND key=?",
        ).run(JSON.stringify(proposal), "anynote.ai.proposals", proposal.id);
      },
    );
  }
  if (
    proposal.status !== "applied" ||
    note.revision !== proposal.appliedRevision
  )
    throw Error("笔记已有新修改，不能直接撤销此提案");
  return save(
    s,
    db,
    { ...p, expectedRevision: proposal.appliedRevision },
    proposal.before,
    [],
    "ai-undo",
    () => {
      proposal.status = "undone";
      db.prepare(
        "UPDATE extension_data SET value_json=?,revision=revision+1 WHERE extension_id=? AND key=?",
      ).run(JSON.stringify(proposal), "anynote.ai.proposals", proposal.id);
    },
  );
}
