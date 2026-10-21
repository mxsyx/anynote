import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Storage } from "./index.js";

const uuid = z.string().uuid();
const revision = z.number().int().positive();
const base = z.object({ notebookId: uuid, id: uuid });
const createInput = base
  .extend({
    expectedRevision: revision,
    body: z.string().min(1).max(2_000_000),
    reason: z.string().max(1000).optional(),
  })
  .strict();
const changeInput = base.extend({ proposalId: uuid }).strict();
const proposalFields = z.object({
  id: uuid,
  noteId: uuid,
  expectedRevision: revision,
  before: z.string().max(2_000_000),
  after: z.string().min(1).max(2_000_000),
  reason: z.string().max(1000),
  createdAt: z.number().int().nonnegative(),
});
const proposalSchema = z.discriminatedUnion("status", [
  proposalFields.extend({ status: z.literal("proposed") }).strict(),
  proposalFields
    .extend({ status: z.literal("applied"), appliedRevision: revision })
    .strict(),
  proposalFields
    .extend({ status: z.literal("undone"), appliedRevision: revision })
    .strict(),
]);

// Preserve storage metadata while validating the fields exposed to proposal consumers.
const noteSchema = z
  .object({
    id: uuid,
    title: z.string(),
    body: z.string().max(2_000_000),
    revision,
    head_revision_id: uuid,
    tags: z.array(z.string()),
    note_type: z.string(),
  })
  .passthrough();
export type ProposalNote = z.infer<typeof noteSchema>;

/** Validated persisted proposal; applied revisions exist only after application. */
export type Proposal = z.infer<typeof proposalSchema>;
export type ProposalOperation =
  | "proposePatch"
  | "applyProposal"
  | "undoProposal";

/**
 * Handle AI proposal generation, application, and undo.
 *
 * Proposals are stored in `extension_data`; both apply and undo use
 * revision-conditional writes so a note modified after the proposal is never
 * overwritten by mistake. Operations include `proposePatch`, `applyProposal`,
 * and `undoProposal`.
 *
 * @param s Storage service.
 * @param op Operation name.
 * @param raw Raw operation payload.
 * @param save Save-note function used to apply patches.
 * @returns The operation result.
 */
export function proposalOperation(
  s: Storage,
  op: ProposalOperation,
  raw: unknown,
  save: import("./operations.js").SaveNote,
): Proposal | ProposalNote {
  if (!["proposePatch", "applyProposal", "undoProposal"].includes(op))
    throw Error("未知提案操作");

  if (op === "proposePatch") {
    const p = createInput.parse(raw),
      db = s.open(p.notebookId),
      note = noteSchema.parse(s.get(db, p.id));
    if (note.revision !== p.expectedRevision)
      throw Error("版本冲突：提案基于旧版本");
    const proposal = proposalSchema.parse({
      id: randomUUID(),
      noteId: p.id,
      expectedRevision: note.revision,
      before: note.body,
      after: p.body,
      reason: p.reason || "用户授权的整理提案",
      status: "proposed",
      createdAt: Date.now(),
    });
    db.prepare(
      "INSERT INTO extension_data(extension_id,key,value_json) VALUES(?,?,?)",
    ).run("anynote.ai.proposals", proposal.id, JSON.stringify(proposal));
    return proposal;
  }

  const p = changeInput.parse(raw),
    db = s.open(p.notebookId),
    note = noteSchema.parse(s.get(db, p.id));
  const row = db
    .prepare(
      "SELECT value_json FROM extension_data WHERE extension_id=? AND key=?",
    )
    .get<{ value_json: string }>("anynote.ai.proposals", p.proposalId);
  if (!row) throw Error("提案不存在");
  const proposal = proposalSchema.parse(JSON.parse(row.value_json));
  if (proposal.id !== p.proposalId || proposal.noteId !== p.id)
    throw Error("提案目标不匹配");

  if (op === "applyProposal") {
    if (proposal.status === "applied") return note;
    if (
      proposal.status !== "proposed" ||
      note.revision !== proposal.expectedRevision
    )
      throw Error("版本冲突：请重新生成提案");
    return noteSchema.parse(
      save(
        s,
        db,
        { ...p, expectedRevision: proposal.expectedRevision },
        proposal.after,
        [],
        "ai-proposal",
        (saved) => {
          const applied: Proposal = {
            ...proposal,
            status: "applied",
            appliedRevision: revision.parse(saved.revision),
          };
          db.prepare(
            "UPDATE extension_data SET value_json=?,revision=revision+1 WHERE extension_id=? AND key=?",
          ).run(JSON.stringify(applied), "anynote.ai.proposals", proposal.id);
        },
      ),
    );
  }

  if (
    proposal.status !== "applied" ||
    note.revision !== proposal.appliedRevision
  )
    throw Error("笔记已有新修改，不能直接撤销此提案");
  return noteSchema.parse(
    save(
      s,
      db,
      { ...p, expectedRevision: proposal.appliedRevision },
      proposal.before,
      [],
      "ai-undo",
      () => {
        const undone: Proposal = { ...proposal, status: "undone" };
        db.prepare(
          "UPDATE extension_data SET value_json=?,revision=revision+1 WHERE extension_id=? AND key=?",
        ).run(JSON.stringify(undone), "anynote.ai.proposals", proposal.id);
      },
    ),
  );
}
