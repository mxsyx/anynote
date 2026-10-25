import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../.build/packages/backend/index.js";
import {
  snapshotBundle,
  restoreSnapshot,
} from "../../.build/packages/backup/cloud-archive.js";
import { objectDescriptors } from "../../.build/packages/protocol/cloud-objects.js";

const day = 86400000;
const base = (state) => `/v1/notebooks/${state.target.notebookId}`;
const post = (client, state, path, body) =>
  client.call(base(state) + path, { method: "POST", body });

async function apply(client, state, plan) {
  for (let batch = 0; batch < 100; batch++) {
    const result = await post(client, state, "/retention/apply", {
      planId: plan.id,
      deviceId: state.target.deviceId,
      writerEpoch: 1,
      confirmed: true,
    });
    if (result.completed) return result;
  }
  throw Error("小规模老化样本清理超过 100 批，保留计划供重试");
}

async function preview(client, state, keep) {
  return post(client, state, "/retention/plan", { ...state.target, keep });
}

export async function agingCapabilities(client) {
  const caps = await client.call("/v1/capabilities");
  assert.ok(caps.schemaVersions.includes(5), "需要 schema v5 部署");
  for (const name of ["maintenance-lifecycle-v1", "transfer-resume-v1"])
    assert.ok(caps.capabilities.includes(name), `服务缺少 ${name}`);
  return caps;
}

// Only freshly allocated notebook IDs are seeded. Persist identity before the
// first remote write, so an interrupted setup still leaves an auditable scope.
export async function seedAging({ client, save = () => {} }) {
  const capabilities = await agingCapabilities(client);
  const root = mkdtempSync(join(tmpdir(), "anynote-cloud-aging-"));
  const storage = new Storage(root);
  try {
    const book = await storage.run("createNotebook", {
      title: "真实老化隔离验收",
    });
    let note = await storage.run("createNode", {
      notebookId: book.id,
      title: "老化保护样本",
      body: "seed",
    });
    const state = {
      format: "anynote.cloud-aging.v1",
      endpoint: client.url,
      createdAt: new Date().toISOString(),
      capabilities,
      status: "seeding",
      target: {
        notebookId: book.id,
        lineageId: randomUUID(),
        deviceId: randomUUID(),
        writerEpoch: 1,
      },
      noteId: note.id,
      samples: {},
      phases: {},
    };
    save(state);
    let head = "";
    for (const name of ["orphan", "pinned", "head", "branch", "staging"]) {
      note = await storage.run("saveNote", {
        notebookId: book.id,
        id: note.id,
        expectedRevision: note.revision,
        body: `${name}: ${randomUUID()}`,
      });
      const data = snapshotBundle(
        Buffer.from(
          (await storage.run("exportArchive", { notebookId: book.id })).data,
          "base64",
        ),
      );
      const manifest = {
        ...data.manifest,
        ...state.target,
        generationId: randomUUID(),
        lineageId: name === "branch" ? randomUUID() : state.target.lineageId,
        expectedHead: name === "branch" ? "" : head,
      };
      state.samples[name] = { manifest, body: note.body };
      save(state);
      const plan = await post(client, state, "/backup/plan", manifest);
      for (const hash of plan.missing)
        await client.uploadObject(
          base(state) + `/backup/${manifest.generationId}/objects/${hash}`,
          data.objects.get(hash),
        );
      if (name !== "staging") {
        await post(client, state, `/backup/${manifest.generationId}/commit`, {
          expectedHead: manifest.expectedHead,
          writerEpoch: 1,
        });
        if (name !== "branch") head = manifest.generationId;
      }
      state.samples[name].uploadedAt = new Date().toISOString();
      save(state);
    }
    const retained = new Set(
      ["pinned", "head", "branch", "staging"].flatMap((name) => [
        ...objectDescriptors(state.samples[name].manifest).keys(),
      ]),
    );
    state.orphanHashes = [
      ...objectDescriptors(state.samples.orphan.manifest).keys(),
    ].filter((hash) => !retained.has(hash));
    assert.ok(state.orphanHashes.length > 0, "样本必须包含独有对象");
    const seedPin = randomUUID();
    const pinned = state.samples.pinned.manifest.generationId;
    await post(client, state, `/backups/${pinned}/pin`, { pinId: seedPin });
    const plan = await preview(client, state, 1);
    assert.deepEqual(
      plan.remove.map((g) => g.id),
      [state.samples.orphan.manifest.generationId],
    );
    assert.equal(plan.objects.length, 0, "新对象必须受 24h 宽限保护");
    state.seedPlan = plan;
    save(state);
    await apply(client, state, plan);
    await client.call(base(state) + `/backups/${pinned}/pin`, {
      method: "DELETE",
      body: { pinId: seedPin },
    });
    // Start the wait after all writes and removal complete. Never backdate R2
    // metadata or server activity, and leave staging untouched between phases.
    state.readyAt = new Date().toISOString();
    state.due24h = new Date(Date.now() + day + 60000).toISOString();
    state.due7d = new Date(Date.now() + 7 * day + 60000).toISOString();
    state.status = "waiting";
    save(state);
    return state;
  } finally {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
}

export async function verifyAging({ client, state, phase, save = () => {} }) {
  assert.equal(state.format, "anynote.cloud-aging.v1");
  assert.equal(state.endpoint, client.url, "样本绑定的 endpoint 不匹配");
  assert.ok(["24h", "7d"].includes(phase), "未知老化阶段");
  assert.ok(
    state.readyAt,
    "样本初始化未完成；保留记录，使用新状态文件重新建立样本",
  );
  if (state.phases[phase]?.status === "passed") return state;
  if (phase === "7d")
    assert.equal(state.phases["24h"]?.status, "passed", "先完成 24h 复验");
  const due = state[phase === "24h" ? "due24h" : "due7d"];
  assert.ok(Number.isFinite(Date.parse(due)), "样本到期时间无效");
  if (Date.now() < Date.parse(due)) return state;
  await agingCapabilities(client);
  const record = (state.phases[phase] ||= { status: "running" });
  const pinId = (record.pinId ||= randomUUID());
  const pinned = state.samples.pinned.manifest.generationId;
  const staging = state.samples.staging.manifest.generationId;
  save(state);
  if (!record.plan) {
    await post(client, state, `/backups/${pinned}/pin`, { pinId });
    const plan = await preview(client, state, 1);
    for (const name of ["pinned", "head", "branch"])
      assert.ok(
        plan.protected.includes(state.samples[name].manifest.generationId),
        `${name} 必须受保护`,
      );
    if (phase === "24h") {
      assert.equal(
        plan.remove.length,
        0,
        "24h 复验必须在 staging 满 7 天前执行",
      );
      assert.equal(plan.staging, 1);
      for (const hash of state.orphanHashes)
        assert.ok(
          plan.objects.some((item) => item.hash === hash),
          "老化孤立对象必须进入清理计划",
        );
      const protectedHashes = new Set(
        objectDescriptors(state.samples.staging.manifest).keys(),
      );
      assert.ok(plan.objects.every((item) => !protectedHashes.has(item.hash)));
    } else {
      assert.equal(plan.expiredStaging, 1);
      assert.deepEqual(
        plan.remove.map((g) => g.id),
        [staging],
      );
    }
    // Save before apply: a lost response must resume the exact same plan,
    // including after the remote maintenance gate has been acquired.
    record.plan = plan;
    save(state);
  }
  record.result = await apply(client, state, record.plan);
  save(state);
  for (const item of record.plan.objects.filter((item) => item.hash))
    await assert.rejects(
      client.call(base(state) + `/objects/${item.hash}`),
      (e) => e.status === 404,
    );
  for (const name of phase === "7d" ? ["orphan", "staging"] : ["orphan"])
    await assert.rejects(
      post(client, state, "/backup/plan", state.samples[name].manifest),
      /GENERATION_RETIRED/,
    );

  const root = mkdtempSync(join(tmpdir(), "anynote-aging-restore-"));
  const storage = new Storage(root);
  try {
    for (const name of ["pinned", "head", "branch"]) {
      const sample = state.samples[name];
      const target = { ...state.target, lineageId: sample.manifest.lineageId };
      const restored = await storage.run("importArchive", {
        data: (
          await restoreSnapshot(client, target, sample.manifest.generationId)
        ).toString("base64"),
      });
      assert.equal(
        (
          await storage.run("getNote", {
            notebookId: restored.id,
            id: state.noteId,
          })
        ).body,
        sample.body,
      );
    }
  } finally {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
  await client.call(base(state) + `/backups/${pinned}/pin`, {
    method: "DELETE",
    body: { pinId },
  });
  record.status = "passed";
  record.finishedAt = new Date().toISOString();
  state.status = phase === "7d" ? "passed" : "waiting";
  save(state);
  return state;
}
