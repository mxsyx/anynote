import {
  backup,
  DatabaseSync,
  type SqlDatabase,
} from "@anynote/types/runtime.js";

/** Capture committed WAL pages and leave a standalone database that opens without sidecars. */
export async function snapshotDatabase(
  source: SqlDatabase,
  destination: string,
) {
  await backup(source, destination);
  const snapshot = new DatabaseSync(destination);
  try {
    snapshot.exec("PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE;");
  } finally {
    snapshot.close();
  }
}
