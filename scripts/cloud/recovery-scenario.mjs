import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  existsSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../.build/packages/storage-sqlite/index.js";
import { hashFile } from "../../.build/packages/storage-sqlite/archive-stream.js";
export async function recoveryChild(message) {
  const env = { ...process.env };
  for (const key of [
    "ANYNOTE_CF_TOKEN",
    "ANYNOTE_CF_ENDPOINT",
    "CLOUDFLARE_API_TOKEN",
  ])
    delete env[key];
  const child = fork(
    fileURLToPath(new URL("./recovery-child.mjs", import.meta.url)),
    [],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env,
      execArgv: process.execArgv.filter((arg) => !arg.startsWith("--env-file")),
    },
  );
  const closed = once(child, "exit"),
    timeout = setTimeout(() => child.kill("SIGKILL"), 180000);
  try {
    const reply = await new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
      child.once("exit", () => reject(Error("演练子进程未到达预期检查点")));
      child.send(message);
    });
    if (reply.type === "failed") throw Error(reply.error);
    if (message.fault) {
      assert.equal(reply.type, "fault-reached");
      child.kill("SIGKILL");
      const [, signal] = await closed;
      assert.equal(signal, "SIGKILL");
    } else {
      assert.equal(reply.type, "completed");
      const [code] = await closed;
      assert.equal(code, 0);
    }
    return reply;
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await closed;
    }
  }
}
export async function recoveryScenario({ settings, onStep = () => {} }) {
  const root = mkdtempSync(join(tmpdir(), "anynote-recovery-")),
    data = join(root, "data"),
    steps = [];
  let storage;
  const record = (name, details = {}) => {
    steps.push({ name, status: "passed", ...details });
    onStep(steps.at(-1), steps);
  };
  const open = () => {
    storage = new Storage(data);
    if (target) storage.secretMemory = new Map([[target.id, settings.secrets]]);
    return storage;
  };
  const clean = () => {
    for (const kind of ["backup-jobs", "archive-jobs", "job-leases"]) {
      const dir = join(data, "_local", kind);
      if (existsSync(dir)) assert.deepEqual(readdirSync(dir), []);
    }
  };
  let target, book, note, body;
  const call = (op, p = {}) => storage.run(op, { notebookId: book.id, ...p });
  const child = (operation, fault, generationId) =>
    recoveryChild({
      root: data,
      target,
      settings,
      operation,
      fault,
      generationId,
    });
  try {
    open();
    book = await storage.run("createNotebook", { title: "故障恢复演练" });
    note = await call("createNode", { title: "恢复验证", body: "第一版本" });
    body =
      ':::anynote{type="future.keep" version="9"}\n{"keep":true}\n:::\n' +
      `[自己](anynote://notebook/${book.id}/note/${note.id})`;
    note = await call("saveNote", {
      id: note.id,
      expectedRevision: 1,
      body,
      tags: ["演练"],
      favorite: true,
    });
    const trash = await call("createNode", { title: "删除内容" });
    await call("trashNode", { id: trash.id });
    await call("importFile", {
      name: "fixture.png",
      mime: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=",
    });
    target = await call("configureBackup", {
      name: "恢复演练",
      ...settings.config,
      ...settings.secrets,
    });
    storage.close();
    storage = undefined;
    record("isolated-fixture-created", {
      notebookId: book.id,
      lineageId: target.lineageId,
    });
    await child("startBackup", "before-commit");
    open();
    clean();
    assert.equal(
      (await call("listRemoteBackups", { targetId: target.id })).length,
      0,
    );
    assert.ok((await call("listBackupTargets"))[0].pendingGeneration);
    storage.close();
    storage = undefined;
    await child("startBackup");
    open();
    clean();
    assert.equal(
      (await call("listRemoteBackups", { targetId: target.id })).length,
      1,
    );
    record(
      "SIGKILL-before-publication-restarts-without-visible-partial-version",
    );
    body += "\n提交响应丢失后的版本";
    note = await call("saveNote", {
      id: note.id,
      expectedRevision: note.revision,
      body,
    });
    storage.close();
    storage = undefined;
    await child("startBackup", "after-commit");
    open();
    clean();
    const cursor = (await call("listBackupTargets"))[0],
      versions = await call("listRemoteBackups", { targetId: target.id });
    assert.equal(versions.length, 2);
    assert.ok(cursor.pendingGeneration);
    assert.notEqual(cursor.lastGeneration, cursor.pendingGeneration);
    const committed = cursor.pendingGeneration;
    storage.close();
    storage = undefined;
    const repaired = await child("startBackup");
    assert.match(repaired.progress, /修复本地游标/);
    open();
    clean();
    const confirmed = (await call("listBackupTargets"))[0];
    assert.equal(confirmed.lastGeneration, committed);
    assert.equal(confirmed.pendingGeneration, null);
    assert.equal(
      confirmed.lastAckSeq,
      storage
        .open(book.id)
        .prepare("SELECT content_seq FROM notebook_meta")
        .get().content_seq,
    );
    assert.equal(
      (await call("listRemoteBackups", { targetId: target.id })).length,
      2,
    );
    storage.close();
    storage = undefined;
    record(
      "SIGKILL-after-remote-commit-repairs-cursor-without-duplicate-publication",
    );
    await child("restoreRemoteBackup", "restore", committed);
    open();
    clean();
    assert.equal(storage.registry().length, 1);
    storage.close();
    storage = undefined;
    record(
      "SIGKILL-during-restore-cleans-private-directory-without-registering-copy",
    );
    const restored = await child("restoreRemoteBackup", undefined, committed);
    open();
    clean();
    assert.equal(storage.registry().length, 2);
    const verifyCopy = async (copyId) => {
      const actual = await storage.run("getNote", {
        notebookId: copyId,
        id: note.id,
      });
      assert.equal(
        actual.body,
        body.replaceAll(
          `anynote://notebook/${book.id}/`,
          `anynote://notebook/${copyId}/`,
        ),
      );
      assert.deepEqual(actual.tags, ["演练"]);
      assert.equal(actual.favorite, 1);
      assert.equal(
        (
          await storage.run("history", {
            notebookId: copyId,
            id: note.id,
          })
        ).length,
        3,
      );
      assert.ok(
        (await storage.run("listNodes", { notebookId: copyId })).find(
          (n) => n.id === trash.id,
        ).deleted_at,
      );
      for (const asset of storage
        .open(copyId)
        .prepare("SELECT * FROM assets")
        .all())
        assert.equal(
          (await hashFile(storage.notebookPath(copyId, asset.path))).sha256,
          asset.hash,
        );

      const matches = await storage.run("search", {
        notebookId: copyId,
        query: "提交响应",
      });
      assert.ok(matches.some((n) => n.id === note.id));
    };
    await verifyCopy(restored.restoredId);
    record("retry-restores-body-history-trash-assets-and-rebuilds-search", {
      restoredId: restored.restoredId,
    });
    storage.close();
    storage = undefined;
    renameSync(join(data, book.id), join(root, "offline-source"));
    const offline = await child("restoreRemoteBackup", undefined, committed);
    open();
    clean();
    assert.equal(storage.registry().length, 2);
    await verifyCopy(offline.restoredId);
    record(
      "source-notebook-unavailable-restores-from-cloud-with-retained-device-config",
      { restoredId: offline.restoredId },
    );
    return steps;
  } finally {
    storage?.close();
    rmSync(root, { recursive: true, force: true });
  }
}
