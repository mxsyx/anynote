import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Storage } from "../../.build/packages/storage-sqlite/index.js";
import {
  uploadSnapshot,
  listSnapshots,
  restoreSnapshot,
} from "../../.build/packages/backup/providers.js";
import {
  logicalBundle,
  uploadLogical,
  listLogical,
  restoreLogical,
} from "../../.build/packages/backup/logical.js";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=";
export async function acceptanceScenario({
  provider,
  client,
  onStep = () => {},
  onPrepared = () => {},
}) {
  const root = mkdtempSync(join(tmpdir(), "anynote-cloud-acceptance-"));
  const s = new Storage(root),
    steps = [];
  const check = async (name, work) => {
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
  };
  try {
    const book = await s.run("createNotebook", { title: "真实云验收临时库" });
    const call = (op, p = {}) => s.run(op, { notebookId: book.id, ...p });
    const folder = await call("createNode", {
      kind: "folder",
      title: "测试目录",
    });
    let note = await call("createNode", {
      kind: "note",
      title: "版本一",
      parentId: folder.id,
    });
    note = await call("saveNote", {
      id: note.id,
      expectedRevision: note.revision,
      body: '# 云端往返\n\n中文正文。\n\n:::anynote{type="future.block" version="9" id="opaque"}\n{"keep":"原样保留"}\n:::\n',
      tags: ["云验收"],
      favorite: true,
    });
    note = await call("addResource", {
      id: note.id,
      expectedRevision: note.revision,
      name: "像素.png",
      mime: "image/png",
      data: png,
    });
    const image = await call("importFile", {
      name: "独立图片.png",
      mime: "image/png",
      data: png,
    });
    const trashed = await call("createNode", {
      kind: "note",
      title: "回收站内容",
    });
    await call("trashNode", { id: trashed.id });
    const originalBody = note.body;
    const bundle = Buffer.from((await call("exportArchive")).data, "base64");
    const target = {
      notebookId: book.id,
      lineageId: randomUUID(),
      deviceId: randomUUID(),
    };
    const ids = {
      first: randomUUID(),
      second: randomUUID(),
      interrupted: randomUUID(),
      race: randomUUID(),
    };
    const scope = { ...target, generations: ids };
    onPrepared(scope);
    const verify = async (bytes, expectedBody) => {
      const restored = await s.run("importArchive", {
        data: bytes.toString("base64"),
      });
      assert.notEqual(restored.id, book.id, "恢复必须创建新 Notebook");
      const read = (op, p = {}) => s.run(op, { notebookId: restored.id, ...p });
      const n = await read("getNote", { id: note.id });
      assert.equal(n.body, expectedBody);
      assert.equal(n.title, "版本一");
      assert.deepEqual(n.tags, ["云验收"]);
      assert.equal(n.favorite, 1);
      assert.equal(n.parent_id, folder.id);
      assert.equal(
        (await read("getNote", { id: trashed.id })).deleted_at > 0,
        true,
      );
      assert.equal(
        (await read("getAsset", { id: image.primary_resource_id })).data,
        png,
      );
      const history = await read("history", { id: note.id });
      assert.ok(history.length >= 3);
      assert.ok(
        history.some(
          (revision) =>
            revision.metadata?.title === "版本一" &&
            revision.metadata?.favorite === 1 &&
            revision.metadata?.tags?.includes("云验收"),
        ),
      );
      assert.ok(n.body.includes('"keep":"原样保留"'));
      assert.ok(
        (await read("search", { query: "中文正文" })).some(
          (r) => r.id === note.id,
        ),
      );
      const resourceId = n.body.match(/anynote-resource:([a-f0-9-]{36})/)[1];
      assert.equal(
        (await read("getAsset", { id: resourceId, noteId: n.id })).data,
        png,
      );
    };
    if (provider === "s3") {
      await check("upload-and-verified-commit", async () => {
        await uploadSnapshot(client, bundle, {
          ...target,
          generationId: ids.first,
        });
        assert.ok(
          (await listSnapshots(client, book.id, target.lineageId)).some(
            (g) => g.id === ids.first,
          ),
        );
      });
      await check("restore-content-history-trash-and-assets", async () =>
        verify(
          await restoreSnapshot(client, { ...target, generationId: ids.first }),
          originalBody,
        ),
      );
      await check("unchanged-objects-are-not-uploaded", async () => {
        const result = await uploadSnapshot(client, bundle, {
          ...target,
          generationId: ids.second,
        });
        assert.equal(result.uploaded, 0);
      });
      const changed = await call("saveNote", {
        id: note.id,
        expectedRevision: note.revision,
        body: originalBody + "\n版本二。",
      });
      const nextBundle = Buffer.from(
        (await call("exportArchive")).data,
        "base64",
      );
      await check("interruption-does-not-publish-a-version", async () => {
        const faulty = {
          has: client.has.bind(client),
          get: client.get.bind(client),
          put: async (key, bytes) => {
            if (key.endsWith("/COMMITTED.json"))
              throw Error("INJECTED_BEFORE_COMMIT");
            await client.put(key, bytes);
          },
        };
        await assert.rejects(
          uploadSnapshot(faulty, nextBundle, {
            ...target,
            generationId: ids.interrupted,
          }),
          /INJECTED_BEFORE_COMMIT/,
        );
        assert.ok(
          !(await listSnapshots(client, book.id, target.lineageId)).some(
            (g) => g.id === ids.interrupted,
          ),
        );
        await verify(
          await restoreSnapshot(client, { ...target, generationId: ids.first }),
          originalBody,
        );
      });
      await check("lost-commit-response-and-idempotent-retry", async () => {
        const faulty = {
          has: client.has.bind(client),
          get: client.get.bind(client),
          put: async (key, bytes) => {
            await client.put(key, bytes);
            if (key.endsWith("/COMMITTED.json"))
              throw Error("INJECTED_LOST_RESPONSE");
          },
        };
        await assert.rejects(
          uploadSnapshot(faulty, nextBundle, {
            ...target,
            generationId: ids.interrupted,
          }),
          /INJECTED_LOST_RESPONSE/,
        );
        assert.ok(
          (await listSnapshots(client, book.id, target.lineageId)).some(
            (g) => g.id === ids.interrupted,
          ),
        );
        const retry = await uploadSnapshot(client, nextBundle, {
          ...target,
          generationId: ids.interrupted,
        });
        assert.equal(retry.uploaded, 0);
        assert.equal(
          (await listSnapshots(client, book.id, target.lineageId)).filter(
            (g) => g.id === ids.interrupted,
          ).length,
          1,
        );
        await verify(
          await restoreSnapshot(client, {
            ...target,
            generationId: ids.interrupted,
          }),
          changed.body,
        );
      });
      await check("download-corruption-is-rejected", async () => {
        const corrupt = {
          get: async (key) => {
            const bytes = await client.get(key);
            if (key.includes("/databases/")) {
              const tampered = Buffer.from(bytes);
              tampered[0] ^= 1;
              return tampered;
            }
            return bytes;
          },
        };
        await assert.rejects(
          restoreSnapshot(corrupt, { ...target, generationId: ids.first }),
          /校验失败/,
        );
      });
    } else if (provider === "cloudflare") {
      const base = `/v1/notebooks/${book.id}/backup`,
        logical = logicalBundle(bundle);
      const manifest = (id, head = "") => ({
        ...logical.manifest,
        ...target,
        generationId: id,
        expectedHead: head,
        writerEpoch: 1,
      });
      const commit = (id, head = "") =>
        client.call(`${base}/${id}/commit`, {
          method: "POST",
          body: { expectedHead: head, writerEpoch: 1 },
        });
      let plan, winningHead;
      await check("capabilities-and-staging-invisibility", async () => {
        const capabilities = await client.call("/v1/capabilities");
        assert.equal(capabilities.protocolVersion, 1);
        plan = await client.call(base + "/plan", {
          method: "POST",
          body: manifest(ids.first),
        });
        assert.ok(plan.missing.length > 0);
        assert.equal((await listLogical(client, target)).length, 0);
      });
      await check("missing-and-tampered-objects-cannot-commit", async () => {
        await assert.rejects(
          commit(ids.first),
          (e) => e.status === 409 && e.message === "ASSET_MISSING",
        );
        const hash = plan.missing[0],
          bytes = Buffer.from(logical.objects.get(hash));
        bytes[0] ^= 1;
        await assert.rejects(
          client.uploadObject(`${base}/${ids.first}/objects/${hash}`, bytes),
          (e) => e.status === 400,
        );
      });
      await check("upload-and-lost-commit-response-recovery", async () => {
        for (const hash of plan.missing)
          await client.uploadObject(
            `${base}/${ids.first}/objects/${hash}`,
            logical.objects.get(hash),
          );
        await assert.rejects(
          (async () => {
            await commit(ids.first);
            throw Error("INJECTED_LOST_RESPONSE");
          })(),
          /INJECTED_LOST_RESPONSE/,
        );
        assert.equal(
          (await client.call(`${base}/${ids.first}`)).status,
          "committed",
        );
        await commit(ids.first);
        assert.equal((await listLogical(client, target)).length, 1);
      });
      await check("restore-content-history-trash-and-assets", async () =>
        verify(await restoreLogical(client, target, ids.first), originalBody),
      );
      await check("unchanged-objects-and-idempotency-conflict", async () => {
        const next = await client.call(base + "/plan", {
          method: "POST",
          body: manifest(ids.second, ids.first),
        });
        assert.equal(next.missing.length, 0);
        await commit(ids.second, ids.first);
        await assert.rejects(
          client.call(base + "/plan", {
            method: "POST",
            body: {
              ...manifest(ids.second, ids.first),
              snapshotSeq: logical.manifest.snapshotSeq + 1,
            },
          }),
          (e) => e.status === 409 && e.message === "IDEMPOTENCY_CONFLICT",
        );
      });
      await check(
        "concurrent-head-CAS-only-publishes-one-version",
        async () => {
          await client.call(base + "/plan", {
            method: "POST",
            body: manifest(ids.interrupted, ids.second),
          });
          await client.call(base + "/plan", {
            method: "POST",
            body: manifest(ids.race, ids.second),
          });
          const raced = await Promise.allSettled([
            commit(ids.interrupted, ids.second),
            commit(ids.race, ids.second),
          ]);
          assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1);
          const loser = raced.find((r) => r.status === "rejected");
          assert.equal(loser.reason.status, 409);
          assert.equal(loser.reason.message, "HEAD_CONFLICT");
          winningHead =
            raced[0].status === "fulfilled" ? ids.interrupted : ids.race;
          const losingHead =
            winningHead === ids.interrupted ? ids.race : ids.interrupted;
          scope.casWinner = winningHead;
          onPrepared(scope);
          assert.ok(
            !(await listLogical(client, target)).some(
              (g) => g.id === losingHead,
            ),
          );
          await verify(
            await restoreLogical(client, target, ids.first),
            originalBody,
          );
        },
      );
      await check(
        "changed-content-round-trip-through-public-provider",
        async () => {
          const changed = await call("saveNote", {
            id: note.id,
            expectedRevision: note.revision,
            body: originalBody + "\n版本二。",
          });
          const nextBundle = Buffer.from(
              (await call("exportArchive")).data,
              "base64",
            ),
            generationId = randomUUID();
          scope.generations.changed = generationId;
          onPrepared(scope);
          await uploadLogical(
            client,
            nextBundle,
            { ...target, lastGeneration: winningHead },
            {
              generationId,
              signal: new AbortController().signal,
              progress: () => {},
            },
          );
          await verify(
            await restoreLogical(client, target, generationId),
            changed.body,
          );
        },
      );
    } else throw Error("未知 Provider");
    return { scope, steps };
  } finally {
    s.close();
    rmSync(root, { recursive: true, force: true });
  }
}
