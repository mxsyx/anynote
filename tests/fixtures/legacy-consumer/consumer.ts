/**
 * Frozen consumer of the Anynote 0.1 public surface.
 *
 * 设计 §19.2 要求旧插件/旧消费者在新宿主上继续可用，除非明确拒绝。此文件是
 * `legacyConsumers` 清单固定的“旧消费者”：它只使用 0.1.0 已发布的公开导出，
 * 后续版本必须继续通过 `pnpm run test:release:matrix` 的类型检查与运行校验。
 * 如需改变调用面，必须同时在发布矩阵中提升契约版本并更新本 fixture。
 *
 * 该文件在仓库内不编译（`tsconfig*.json` 未包含 `tests/fixtures`）；它由冒烟
 * 脚本复制到只含官方 tarball 的干净项目中，用 `tsc` 编译后实际运行。
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

/** 记录 transport 收到的宿主操作，用于验证命令映射。 */
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

/** 单一已授权 transport，同时承载 SDK 与首方适配器调用。 */
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
  // 其余任务类写入操作统一返回任务句柄。
  return { id: "job" };
};

/** 旧插件通过公开 SDK 调用宿主。 */
const api = createAPI(transport);
const contract = api.contract();
const fetched = (await api.notes.get("note")) as NoteSnapshot;
const page = await api.nodes.list({ limit: 10 });
await api.settings.set("enabled", true);
await api.secrets.set({ provider: "anynote.demo", key: "token" }, "secret");

/** 首方适配器只依赖公开 SDK，旧消费者可继续使用。 */
const adapters: FirstPartyAdapters = createFirstPartyAdapters(transport);
await adapters.whiteboard.get({ notebookId: "nb", noteId: "note" });
await adapters.video.insert({
  notebookId: "nb",
  noteId: "note",
  expectedRevision: 1,
  url: "https://youtu.be/abcdefghijk",
});
await adapters.importer.commit({ notebookId: "nb", previewId: "preview" });

/** 本地备份适配器不接受调用方路径。 */
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
