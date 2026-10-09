import { Storage } from "../../.build/packages/storage-sqlite/index.js";
import { CloudflareClient } from "../../.build/packages/backup/providers.js";
process.once(
  "message",
  async ({ root, target, settings, operation, generationId, fault }) => {
    const storage = new Storage(root);
    storage.secretMemory = new Map([[target.id, settings.secrets]]);
    const park = async () => {
      process.send({ type: "fault-reached" });
      await new Promise(() => {});
    };
    const call = CloudflareClient.prototype.call,
      download = CloudflareClient.prototype.downloadObject;
    CloudflareClient.prototype.call = async function (path, options) {
      const result = await call.call(this, path, options);
      if (
        (fault === "before-commit" && path.endsWith("/backup/plan")) ||
        (fault === "after-commit" && path.endsWith("/commit"))
      )
        await park();
      return result;
    };
    CloudflareClient.prototype.downloadObject = async function (...args) {
      const bytes = await download.apply(this, args);
      if (fault === "restore") await park();
      return bytes;
    };
    try {
      const result = await storage.run(operation, {
          notebookId: target.notebookId,
          targetId: target.id,
          ...(generationId ? { generationId } : {}),
        }),
        job = storage.jobs.get(result.id);
      await job.promise;
      if (job.status !== "completed") throw Error(job.error || job.status);
      process.send({
        type: "completed",
        restoredId: job.restoredId,
        progress: job.progress,
      });
    } catch (e) {
      process.send({ type: "failed", error: e.message });
      process.exitCode = 1;
    } finally {
      storage.close();
      process.disconnect();
    }
  },
);
