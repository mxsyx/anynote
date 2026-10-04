import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../.build/packages/storage-sqlite/index.js";
import {
  logicalBundle,
  uploadLogical,
  listLogical,
  restoreLogical,
} from "../../.build/packages/backup/logical.js";

// All destructive checks are confined to a freshly created acceptance notebook.
export async function maintenanceScenario({
  client,
  onStep = () => {},
  onPrepared = () => {},
}) {
  const root = mkdtempSync(join(tmpdir(), "anynote-cloud-maintenance-"));
  const s = new Storage(root),
    steps = [];
  async function check(name, work) {
    const step = { name, status: "running" };
    steps.push(step);
    onStep(step, steps);
    const start = performance.now();
    try {
      await work();
      step.status = "passed";
    } catch (e) {
      step.status = "failed";
      throw e;
    } finally {
      step.durationMs = Math.round(performance.now() - start);
      onStep(step, steps);
    }
  }
  try {
    const b = await s.run("createNotebook", { title: "远端维护隔离验收" });
    let n = await s.run("createNode", {
      notebookId: b.id,
      title: "保留验证",
      body: "初版",
    });
    const target = {
      notebookId: b.id,
      lineageId: randomUUID(),
      deviceId: randomUUID(),
      writerEpoch: 1,
    };
    onPrepared({ ...target });
    const base = `/v1/notebooks/${b.id}`;
    const post = (path, body) =>
      client.call(base + path, { method: "POST", body });
    const bundle = async () =>
      Buffer.from(
        (await s.run("exportArchive", { notebookId: b.id })).data,
        "base64",
      );
    const upload = async (tgt = target) => {
      const r = await uploadLogical(client, await bundle(), tgt, {
        generationId: randomUUID(),
        progress: () => {},
        signal: new AbortController().signal,
      });
      tgt.lastGeneration = r.generationId;
      return r.generationId;
    };
    const preview = () =>
      post("/retention/plan", {
        ...target,
        notebookId: undefined,
        lastGeneration: undefined,
        keep: 1,
      });
    let first, latest, p;
    await check("maintenance-preview-and-live-restore-pin", async () => {
      first = await upload();
      n = await s.run("saveNote", {
        notebookId: b.id,
        id: n.id,
        expectedRevision: n.revision,
        body: "保留最新正文",
      });
      latest = await upload();
      const pinId = randomUUID();
      await post(`/backups/${first}/pin`, { pinId });
      assert.equal((await preview()).remove.length, 0);
      await client.call(base + `/backups/${first}/pin`, {
        method: "DELETE",
        body: { pinId },
      });
      p = await preview();
      assert.deepEqual(
        p.remove.map((x) => x.id),
        [first],
      );
      assert.equal(p.objects.length, 0, "新上传对象必须仍在 24 小时宽限期内");
      assert.equal(
        (await listLogical(client, target)).length,
        2,
        "预览不得删除",
      );
    });
    await check(
      "maintenance-stale-preview-is-rejected-before-deletion",
      async () => {
        const pinId = randomUUID();
        await post(`/backups/${first}/pin`, { pinId });
        await assert.rejects(
          post("/retention/apply", {
            planId: p.id,
            deviceId: target.deviceId,
            writerEpoch: 1,
            confirmed: true,
          }),
        );
        assert.equal((await listLogical(client, target)).length, 2);
        await client.call(base + `/backups/${first}/pin`, {
          method: "DELETE",
          body: { pinId },
        });
      },
    );
    await check(
      "maintenance-confirmed-version-deletion-and-kept-head-restore",
      async () => {
        p = await preview();
        let r,
          batches = 0;
        do {
          assert.ok(++batches < 20);
          r = await post("/retention/apply", {
            planId: p.id,
            deviceId: target.deviceId,
            writerEpoch: 1,
            confirmed: true,
          });
        } while (!r.completed);
        assert.deepEqual(
          (await listLogical(client, target)).map((x) => x.id),
          [latest],
        );
        await assert.rejects(
          client.call(base + `/backups/${first}/manifest`),
          (e) => e.status === 404,
        );
        const restored = await s.run("importArchive", {
          data: (await restoreLogical(client, target, latest)).toString(
            "base64",
          ),
        });
        assert.notEqual(restored.id, b.id);
        assert.equal(
          (await s.run("getNote", { notebookId: restored.id, id: n.id })).body,
          n.body,
        );
        assert.equal(
          (await client.call(base + "/retention/state")).activePlan,
          null,
        );
        assert.equal(
          (await post("/retention/apply", { planId: p.id, confirmed: true }))
            .completed,
          true,
        );
      },
    );
    await check(
      "maintenance-takeover-revokes-old-device-and-new-device-commits",
      async () => {
        const claim = {
          lineageId: target.lineageId,
          deviceId: randomUUID(),
          requestId: randomUUID(),
          expectedWriterEpoch: 1,
          expectedHead: latest,
          confirmed: true,
        };
        const taken = await post("/writer/takeover", claim);
        assert.equal(taken.writerEpoch, 2);
        assert.deepEqual(await post("/writer/takeover", claim), taken);
        await assert.rejects(upload(), /WRITER_REVOKED/);
        const next = {
          ...target,
          deviceId: claim.deviceId,
          writerEpoch: taken.writerEpoch,
        };
        n = await s.run("saveNote", {
          notebookId: b.id,
          id: n.id,
          expectedRevision: n.revision,
          body: "接管后正文",
        });
        const head = await upload(next);
        const restored = await s.run("importArchive", {
          data: (await restoreLogical(client, next, head)).toString("base64"),
        });
        assert.equal(
          (await s.run("getNote", { notebookId: restored.id, id: n.id })).body,
          n.body,
        );
      },
    );
    await check(
      "maintenance-calendar-sampling-keeps-month-representative",
      async () => {
        // Dedicated branch with explicitly dated protocol fixtures, not user data.
        const history = {
          ...target,
          lineageId: randomUUID(),
          deviceId: randomUUID(),
          lastGeneration: "",
          writerEpoch: 1,
        };
        const data = logicalBundle(await bundle());
        const now = new Date(),
          previousMonth = new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12),
          );
        const dates = [
          new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 15, 12),
          ),
          new Date(previousMonth.getTime() - 3600000),
          previousMonth,
          new Date(Date.now() - 60000),
        ];
        const ids = [];
        for (const date of dates) {
          const generationId = randomUUID();
          ids.push(generationId);
          const m = {
            ...data.manifest,
            createdAt: date.toISOString(),
            generationId,
            lineageId: history.lineageId,
            deviceId: history.deviceId,
            writerEpoch: 1,
            expectedHead: history.lastGeneration,
          };
          const admission = await post("/backup/plan", m);
          for (const hash of admission.missing)
            await client.uploadObject(
              base + `/backup/${generationId}/objects/${hash}`,
              data.objects.get(hash),
            );
          await post(`/backup/${generationId}/commit`, {
            expectedHead: m.expectedHead,
            writerEpoch: 1,
          });
          history.lastGeneration = generationId;
        }
        const p = await post("/retention/plan", {
          lineageId: history.lineageId,
          deviceId: history.deviceId,
          writerEpoch: 1,
          keep: 1,
          calendar: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 2 },
        });
        assert.ok(
          p.sampled.some(
            (g) => g.id === ids[2] && g.reasons.includes("monthly"),
          ),
        );
        assert.ok(p.remove.some((g) => g.id === ids[1]));
        let result;
        do {
          result = await post("/retention/apply", {
            planId: p.id,
            deviceId: history.deviceId,
            writerEpoch: 1,
            confirmed: true,
          });
        } while (!result.completed);
        assert.deepEqual(
          (await listLogical(client, history)).map((g) => g.id),
          [ids[3], ids[2]],
        );
        const copy = await s.run("importArchive", {
          data: (await restoreLogical(client, history, ids[2])).toString(
            "base64",
          ),
        });
        assert.equal(
          (await s.run("getNote", { notebookId: copy.id, id: n.id })).body,
          n.body,
        );
      },
    );
    return { steps };
  } finally {
    s.close();
    rmSync(root, { recursive: true, force: true });
  }
}
