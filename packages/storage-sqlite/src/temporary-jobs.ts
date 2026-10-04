import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import { z } from "zod";
import { DatabaseSync } from "@anynote/types/runtime.js";
import { assertLocalPath } from "./workspace.js";
const record = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(["archive-jobs", "backup-jobs"]),
  })
  .strict();
/** Independent SQLite lease survives directory publication and is released by process exit. */
export function temporaryJob(
  root: string,
  kind: "archive-jobs" | "backup-jobs",
) {
  const id = randomUUID(),
    leases = assertLocalPath(root, "_local/job-leases"),
    base = assertLocalPath(root, "_local/" + kind);
  mkdirSync(leases, { recursive: true });
  mkdirSync(base, { recursive: true });
  const file = assertLocalPath(root, `_local/job-leases/${id}.sqlite`),
    marker = file + ".json",
    dir = assertLocalPath(root, `_local/${kind}/${id}`),
    db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
    mkdirSync(dir);
    writeFileSync(marker, JSON.stringify({ id, kind }), {
      mode: 0o600,
      flush: true,
    });
  } catch (e) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(marker, { force: true });
    rmSync(file, { force: true });
    throw e;
  }
  let released = false;
  return {
    dir,
    release() {
      if (released) return;
      released = true;
      db.close();
      rmSync(marker, { force: true });
      rmSync(file, { force: true });
    },
  };
}
/** Only tracked jobs whose lease can be acquired are abandoned. Never remove an active or legacy directory. */
export function recoverTemporaryJobs(root: string) {
  const leases = assertLocalPath(root, "_local/job-leases");
  if (!existsSync(leases)) return;
  for (const entry of readdirSync(leases, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".sqlite.json")) continue;
    let db: InstanceType<typeof DatabaseSync> | undefined;
    try {
      const marker = assertLocalPath(root, "_local/job-leases/" + entry.name),
        r = record.parse(JSON.parse(readFileSync(marker, "utf8")));
      if (entry.name !== r.id + ".sqlite.json") continue;
      const file = assertLocalPath(root, `_local/job-leases/${r.id}.sqlite`),
        dir = assertLocalPath(root, `_local/${r.kind}/${r.id}`);
      if (!existsSync(file)) continue;
      db = new DatabaseSync(file);
      db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
      rmSync(dir, { recursive: true, force: true });
      db.close();
      db = undefined;
      rmSync(marker, { force: true });
      rmSync(file, { force: true });
    } catch {
      /* Live lease, unsafe path, malformed marker or I/O failure: retain for a later retry. */
    } finally {
      db?.close();
    }
  }
}
