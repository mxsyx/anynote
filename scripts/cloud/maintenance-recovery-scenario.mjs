import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { Storage } from "../../.build/packages/storage-sqlite/index.js";
import {
  uploadLogical,
  listLogical,
  restoreLogical,
} from "../../.build/packages/backup/logical.js";
export async function maintenanceRecoveryScenario({
  client,
  interruptDuringApply,
  onStep = () => {},
}) {
  const root = mkdtempSync("/tmp/anynote-maintenance-recovery-"),
    s = new Storage(root),
    steps = [];
  function record(name, details = {}) {
    steps.push({ name, status: "passed", ...details });
    onStep(steps.at(-1), steps);
  }
  try {
    const book = await s.run("createNotebook", { title: "维护硬中断独立验收" }),
      note = await s.run("createNode", {
        notebookId: book.id,
        title: "恢复正文",
        body: "初版",
      });
    const target = {
        notebookId: book.id,
        lineageId: randomUUID(),
        deviceId: randomUUID(),
        writerEpoch: 1,
      },
      base = `/v1/notebooks/${book.id}`;
    for (let i = 0; i < 10; i++) {
      const n = await s.run("getNote", { notebookId: book.id, id: note.id });
      await s.run("saveNote", {
        notebookId: book.id,
        id: note.id,
        expectedRevision: n.revision,
        body: `保留正文 ${i}`,
      });
      const bundle = Buffer.from(
        (await s.run("exportArchive", { notebookId: book.id })).data,
        "base64",
      );
      const result = await uploadLogical(client, bundle, target, {
        generationId: randomUUID(),
        signal: new AbortController().signal,
        progress: () => {},
      });
      target.lastGeneration = result.generationId;
    }
    const capability = await client.call("/v1/capabilities");
    assert.ok(capability.capabilities.includes("maintenance-recovery-v1"));
    record("persistent-maintenance-coordinator-capability");
    const plan = await client.call(base + "/retention/plan", {
      method: "POST",
      body: {
        lineageId: target.lineageId,
        deviceId: target.deviceId,
        writerEpoch: 1,
        keep: 1,
      },
    });
    assert.equal(plan.remove.length, 9);
    await interruptDuringApply({
      planId: plan.id,
      book: book.id,
      apply: () =>
        client.call(base + "/retention/apply", {
          method: "POST",
          body: {
            planId: plan.id,
            deviceId: target.deviceId,
            writerEpoch: 1,
            confirmed: true,
          },
        }),
    });
    record("real-workerd-SIGKILL-with-owned-execution-persisted");
    let finished = false;
    for (let i = 0; i < 160; i++) {
      const result = await client.call(base + "/retention/state");
      if (!result.activePlan) {
        finished = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(finished, "重启后的持久化闹钟未自动完成原清理计划");
    record("durable-alarm-resumes-confirmed-plan-without-client-reapply");
    const kept = await listLogical(client, target);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].id, target.lastGeneration);
    const restored = await s.run("importArchive", {
      data: (await restoreLogical(client, target, kept[0].id)).toString(
        "base64",
      ),
    });
    assert.equal(
      (await s.run("getNote", { notebookId: restored.id, id: note.id })).body,
      "保留正文 9",
    );
    record("retained-head-restores-after-automatic-recovery");
    return steps;
  } finally {
    s.close();
    rmSync(root, { recursive: true, force: true });
  }
}
