import { z } from "zod";
import type { Storage } from "./index.js";
const uuid = z.string().uuid();
export function placeNode(s: Storage, raw: unknown) {
  const p = z
      .object({
        notebookId: uuid,
        id: uuid,
        parentId: uuid.nullable(),
        beforeId: uuid.nullable(),
        expectedRevision: z.number().int().positive(),
      })
      .strict()
      .parse(raw),
    db = s.open(p.notebookId),
    node = s.node(db, p.id);
  if (node.revision !== p.expectedRevision)
    throw Error("版本冲突：请刷新目录后重试");
  s.parent(db, p.parentId, p.id);
  if (p.beforeId === p.id) throw Error("不能以自身作为排序锚点");
  const siblings = db
      .prepare(
        "SELECT id,sort_key FROM nodes WHERE parent_id IS ? AND deleted_at IS NULL AND id<>? ORDER BY sort_key,id",
      )
      .all(p.parentId, p.id),
    position = p.beforeId
      ? siblings.findIndex((n) => n.id === p.beforeId)
      : siblings.length;
  if (position < 0) throw Error("排序目标不在所选目录");
  return s.tx(db, p.id, "place", () => {
    let left = position ? siblings[position - 1].sort_key : 0,
      right =
        position < siblings.length ? siblings[position].sort_key : left + 2048;
    if (right - left < 2 || !Number.isSafeInteger(right) || left < 0) {
      siblings.forEach((n, i) =>
        db
          .prepare("UPDATE nodes SET sort_key=? WHERE id=?")
          .run((i + 1) * 1024, n.id),
      );
      left = position * 1024;
      right = (position + 1) * 1024;
    }
    const key = Math.floor(left + (right - left) / 2);
    db.prepare(
      "UPDATE nodes SET parent_id=?,sort_key=?,revision=revision+1,updated_at=? WHERE id=?",
    ).run(p.parentId, key, Date.now(), p.id);
    return s.get(db, p.id);
  });
}
