/**
 * Frozen consumer of the Anynote 0.1 public surface.
 *
 * Design §19.2 requires old plugins/consumers to keep working on the new host unless explicitly rejected. This file is
 * the "legacy consumer" fixed by the `legacyConsumers` list: it uses only the public exports released in 0.1.0,
 * and later versions must keep passing the type check and runtime validation of `pnpm run test:release:matrix`.
 * If the call surface changes, the contract version must be bumped in the release matrix and this fixture updated.
 *
 * This file is not compiled in the repo (`tsconfig*.json` does not include `tests/fixtures`); a smoke
 * script copies it into a clean project containing only official tarballs, compiles it with `tsc`, and actually runs it.
 */
import {
  apiContractVersion,
  createAPI,
  createLocalBackupAPI,
  sdkVersion,
  type LocalBackupAPI,
  type LocalBackupTask,
  type LocalVerificationReport,
  type NoteSnapshot,
} from "@anynote/plugin-sdk";
import {
  createFirstPartyAdapters,
  firstPartyAdapterCapabilities,
  firstPartyAdapterContractVersion,
  firstPartyAdapterVersion,
  type FirstPartyAdapters,
  type FirstPartyWhiteboardScene,
} from "@anynote/first-party-adapters";

/** Record host operations the transport received, to verify command mapping. */
const calls: { method: string; input: Record<string, unknown> }[] = [];

const note: NoteSnapshot = {
  id: "note",
  title: "旧消费者",
  body: "body",
  revision: 1,
  head_revision_id: "revision",
  tags: [],
  note_type: "markdown",
};

/** A single authorized transport carrying both SDK and first-party adapter calls. */
const transport = async (method: string, input: Record<string, unknown>) => {
  calls.push({ method, input });
  if (method === "getWhiteboard")
    return {
      elements: [],
      appState: {},
      files: {},
    } satisfies FirstPartyWhiteboardScene;
  if (method === "getImportPreview")
    return { status: "completed", progress: "预览已就绪" };
  if (method === "getImportReport") return null;
  if (method === "listTasks")
    return [
      {
        id: "job",
        type: "local-verify",
        notebookId: "nb",
        status: "completed",
        progress: "校验通过",
        createdAt: 0,
        verificationReport: { status: "passed", issues: [] },
      },
    ];
  if (method === "notes.get") return note;
  // Other task-like write operations uniformly return a task handle.
  return { id: "job" };
};

/** A legacy plugin calls the host through the public SDK. */
const api = createAPI(transport);
const contract = api.contract();
const fetched = (await api.notes.get("note")) as NoteSnapshot;
const page = await api.nodes.list({ limit: 10 });
await api.settings.set("enabled", true);
await api.secrets.set({ provider: "anynote.demo", key: "token" }, "secret");

/** The first-party adapter depends only on the public SDK, so legacy consumers can keep using it. */
const adapters: FirstPartyAdapters = createFirstPartyAdapters(transport);
await adapters.whiteboard.get({ notebookId: "nb", noteId: "note" });
await adapters.video.insert({
  notebookId: "nb",
  noteId: "note",
  expectedRevision: 1,
  url: "https://youtu.be/abcdefghijk",
});
await adapters.importer.commit({ notebookId: "nb", previewId: "preview" });

/** The local backup adapter does not accept caller-supplied paths. */
const backup: LocalBackupAPI = createLocalBackupAPI(transport);
const handle = await backup.verify({ notebookId: "nb", targetId: "target" });
const task: LocalBackupTask | null = await backup.getTask(handle.id);
const verification: LocalVerificationReport | undefined =
  task?.verificationReport;

const pick = (method: string) => calls.find((call) => call.method === method)!;
if (fetched.id !== "note" || contract.api !== apiContractVersion)
  throw Error("SDK 调用面不兼容");
if (page.nextCursor !== undefined && typeof page.nextCursor !== "string")
  throw Error("分页游标不透明约定被破坏");
if (pick("getWhiteboard").input.id !== "note")
  throw Error("首方白板适配器映射被破坏");
if (pick("verifyLocalBackup").input.targetId !== "target")
  throw Error("本地备份适配器映射被破坏");
if ("path" in pick("verifyLocalBackup").input)
  throw Error("本地备份适配器不允许调用方路径");
if (verification?.status !== "passed") throw Error("本地校验报告丢失");
if (sdkVersion !== "0.1.0" || apiContractVersion !== 1)
  throw Error("SDK 版本契约被破坏");
if (
  firstPartyAdapterVersion !== "0.1.0" ||
  firstPartyAdapterContractVersion !== 1
)
  throw Error("首方适配器版本契约被破坏");
if (
  !firstPartyAdapterCapabilities.includes("import.commit") ||
  !firstPartyAdapterCapabilities.includes("backup.verify")
)
  throw Error("首方适配器能力清单不完整");

console.log("legacy consumer 0.1: passed");
