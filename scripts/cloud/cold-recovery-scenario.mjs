import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../.build/packages/storage-sqlite/index.js";
import { hashFile } from "../../.build/packages/storage-sqlite/archive-stream.js";
export async function coldRecoveryScenario({ settings, onStep = () => {} }) {
  const root = mkdtempSync(join(tmpdir(), "anynote-cold-device-")),
    source = new Storage(join(root, "source")),
    fresh = new Storage(join(root, "fresh")),
    steps = [];
  const record = (name, details = {}) => {
    steps.push({ name, status: "passed", ...details });
    onStep(steps.at(-1), steps);
  };
  const complete = async (s, result) => {
    const job = s.jobs.get(result.id);
    await job.promise;
    assert.equal(job.status, "completed", job.error);
    return job;
  };
  try {
    const book = await source.run("createNotebook", {
        title: "全新设备恢复验收",
      }),
      call = (op, p = {}) => source.run(op, { notebookId: book.id, ...p });
    let note = await call("createNode", {
      title: "云恢复正文",
      body: "第一版本",
    });
    const body =
      ':::anynote{type="future.keep" version="9"}\n{"keep":true}\n:::\n' +
      `[自己](anynote://notebook/${book.id}/note/${note.id})`;
    note = await call("saveNote", {
      id: note.id,
      expectedRevision: 1,
      body,
      tags: ["恢复"],
      favorite: true,
    });
    const trash = await call("createNode", { title: "删除内容" });
    await call("trashNode", { id: trash.id });
    await call("importFile", {
      name: "fixture.png",
      mime: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=",
    });
    const target = await call("configureBackup", {
      name: "源设备验收",
      ...settings.config,
      ...settings.secrets,
    });
    await complete(source, await call("startBackup", { targetId: target.id }));
    const first = (await call("listRemoteBackups", { targetId: target.id }))[0];
    const changed = body + "\n新设备中文正文";
    await call("saveNote", {
      id: note.id,
      expectedRevision: note.revision,
      body: changed,
    });
    await complete(source, await call("startBackup", { targetId: target.id }));
    const second = (
      await call("listRemoteBackups", { targetId: target.id })
    ).find((v) => v.id !== first.id);
    record("source-publishes-two-committed-versions", {
      notebookId: book.id,
      lineageId: target.lineageId,
    });
    source.close();
    rmSync(source.root, { recursive: true, force: true });
    assert.deepEqual(await fresh.run("listNotebooks"), []);
    assert.ok(!existsSync(join(fresh.root, "_local/backup-targets.json")));
    record("all-source-files-and-device-target-config-removed");
    const connection = await fresh.run("configureCloudRecovery", {
      name: "全新设备连接",
      ...settings.config,
      ...settings.secrets,
    });
    const saved = readFileSync(
      join(fresh.root, "_local/recovery-connections.json"),
      "utf8",
    );
    for (const secret of Object.values(settings.secrets))
      if (secret) assert.ok(!saved.includes(secret));
    record("fresh-device-configures-only-cloud-connection");
    const versions = [];
    let cursor;
    for (let i = 0; i < 100; i++) {
      const page = await fresh.run("discoverCloudBackups", {
        connectionId: connection.id,
        ...(cursor ? { cursor } : {}),
      });
      versions.push(...page.backups.filter((v) => v.notebookId === book.id));
      if (
        versions.some((v) => v.id === first.id) &&
        versions.some((v) => v.id === second.id)
      )
        break;
      if (!page.cursor) break;
      cursor = page.cursor;
    }
    assert.ok(
      versions.some((v) => v.id === first.id) &&
        versions.some((v) => v.id === second.id),
    );
    assert.deepEqual(await fresh.run("listNotebooks"), []);
    record("discovers-old-and-new-versions-without-local-notebook-identity");
    for (const [version, expected, history] of [
      [first, body, 2],
      [second, changed, 3],
    ]) {
      const job = await complete(
          fresh,
          await fresh.run("restoreCloudBackup", {
            connectionId: connection.id,
            notebookId: book.id,
            lineageId: target.lineageId,
            generationId: version.id,
          }),
        ),
        id = job.restoredId;
      const actual = await fresh.run("getNote", {
        notebookId: id,
        id: note.id,
      });
      assert.equal(
        actual.body,
        expected.replaceAll(
          `anynote://notebook/${book.id}/`,
          `anynote://notebook/${id}/`,
        ),
      );
      assert.deepEqual(actual.tags, ["恢复"]);
      assert.equal(actual.favorite, 1);
      assert.equal(
        (await fresh.run("history", { notebookId: id, id: note.id })).length,
        history,
      );
      assert.ok(
        (await fresh.run("listNodes", { notebookId: id })).find(
          (n) => n.id === trash.id,
        ).deleted_at,
      );
      for (const asset of fresh.open(id).prepare("SELECT * FROM assets").all())
        assert.equal(
          (await hashFile(fresh.notebookPath(id, asset.path))).sha256,
          asset.hash,
        );
      assert.deepEqual(
        await fresh.run("listBackupTargets", { notebookId: id }),
        [],
      );
      record(
        version.id === first.id
          ? "restores-old-version-full-fidelity"
          : "restores-new-version-full-fidelity",
        { restoredId: id },
      );
    }
    assert.equal((await fresh.run("listNotebooks")).length, 2);
    return steps;
  } finally {
    source.close();
    fresh.close();
    rmSync(root, { recursive: true, force: true });
  }
}
