import { z } from "zod";
import { assertLocalPath } from "@anynote/storage-sqlite/workspace.js";
import type { Storage } from "@anynote/storage-sqlite/index.js";

const snapshotSchema = z
  .object({
    notebookId: z.string().uuid(),
    dir: z.string().min(1).max(4096),
  })
  .strict();
const captureSchema = snapshotSchema.extend({
  signal: z.instanceof(AbortSignal).optional(),
});

function validateDirectory(s: Storage, dir: string) {
  const expected = assertLocalPath(
    s.root,
    "_local/backup-jobs/" + dir.split(/[\\/]/).pop(),
  );
  if (expected !== dir) throw Error("备份暂存目录无效");
}

export function snapshotInput(s: Storage, raw: unknown) {
  const input = snapshotSchema.parse(raw);
  validateDirectory(s, input.dir);
  return input;
}

export function captureInput(s: Storage, raw: unknown) {
  const input = captureSchema.parse(raw);
  validateDirectory(s, input.dir);
  return input;
}
