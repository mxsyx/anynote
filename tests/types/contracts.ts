import {
  createAPI,
  type NoteSnapshot,
} from "../../packages/plugin-sdk/src/index.js";
import type {
  ArchiveProgress,
  BackupTarget,
  SqlDatabase,
  Task,
} from "../../packages/types/src/runtime.js";
import type {
  StorageRequest,
  SecretRequest,
} from "../../apps/desktop/electron/ipc.js";

// These assertions are compiled, never executed. An unused expect-error fails tsc.
export async function sdkContracts() {
  const api = createAPI(async () => null);
  const note: NoteSnapshot = await api.notes.get("note-id");
  const revision: number = note.revision;
  await api.settings.set("enabled", true);
  const settings: { enabled: boolean } | null =
    await api.settings.get("options");
  void [revision, settings];
  // @ts-expect-error Conditional writes require an operation ID and revision.
  await api.notes.applyPatch({ id: "note-id", body: "text" });
  await api.assets.addImage({
    id: "note-id",
    expectedRevision: 1,
    name: "image",
    data: "",
    // @ts-expect-error Resource MIME is restricted to supported images.
    mime: "text/html",
  });
  // @ts-expect-error Notebook scope is supplied by the host, never the extension.
  await api.notes.create({ title: "title", notebookId: "another-notebook" });
}

export function runtimeContracts(
  db: SqlDatabase,
  target: BackupTarget,
  job: Task,
) {
  const row = db.prepare("SELECT id FROM nodes").get<{ id: string }>();
  // @ts-expect-error SQLite get can return no row; consumers must narrow it.
  const id: string = row.id;
  if (row) {
    const id: string = row.id;
    void id;
  }
  // @ts-expect-error Unknown providers must not cross the backup boundary.
  target.provider = "unknown-cloud";
  // @ts-expect-error Task byte counters are numeric.
  job.processedBytes = "1 MB";
  const progress: ArchiveProgress = (bytes, path) => {
    const n: number = bytes;
    const s: string = path;
    void [n, s];
  };
  void [id, progress];
}

export function ipcContracts() {
  const invalidRequest: StorageRequest = {
    // @ts-expect-error Renderer requests cannot pose as secret service messages.
    type: "secret",
    id: 1,
    op: "get",
    input: {},
  };
  const invalidSecret: SecretRequest = {
    type: "secret",
    id: 1,
    // @ts-expect-error The secret service only supports get and set.
    op: "delete",
    secretId: "id",
  };
  void [invalidRequest, invalidSecret];
}
