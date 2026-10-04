import {
  createLocalBackupAPI,
  type LocalBackupAPI,
  type LocalBackupTask,
  type LocalVerificationReport,
  type LocalRestoreResult,
} from "../../packages/plugin-sdk/src/index.js";
const api: LocalBackupAPI = createLocalBackupAPI(async () => null);
void api.configure({ notebookId: "id" });
void api.setScope({ diskId: "disk", notebookIds: ["id"] });
void api.setSchedule({
  notebookId: "id",
  targetId: "target",
  enabled: true,
  concurrency: 2,
});
void api.preview({ notebookId: "id", targetId: "target" });
void api.run({ notebookId: "id", targetId: "target", approvalToken: "hash" });
void api.restore({ notebookId: "id", targetId: "target" });
// @ts-expect-error SDK must not accept renderer-controlled target paths.
void api.configure({ notebookId: "id", path: "/untrusted" });
void api.setSchedule({
  notebookId: "id",
  targetId: "target",
  enabled: true,
  // @ts-expect-error Concurrency is bounded by the host contract.
  concurrency: 5,
});
void api
  .run({ notebookId: "id", targetId: "target" })
  // @ts-expect-error The task result is asynchronous, not a task handle property.
  .then((r) => r.copiedFiles);
async function consumer(id: string) {
  const task: LocalBackupTask | null = await api.getTask(id);
  if (!task) return;
  const report: LocalVerificationReport | undefined = task.verificationReport;
  const restored: LocalRestoreResult | undefined = task.restoreResult;
  if (report?.status === "failed")
    for (const issue of report.issues) {
      const path: string = issue.path;
      const code: string = issue.code;
      void path;
      void code;
    }
  if (restored) await api.listTargets({ notebookId: restored.restoredId });
}
void consumer;
