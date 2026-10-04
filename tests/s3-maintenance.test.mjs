import { test } from "vitest";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import {
  S3Objects,
  uploadSnapshot,
  listSnapshots,
  restoreSnapshot,
} from "../.build/packages/backup/providers.js";
import {
  activateControl,
  readControl,
  mutateControl,
  withS3Activity,
  cancelS3Generation,
} from "../.build/packages/backup/s3-control.js";
import {
  previewS3Retention,
  applyS3Retention,
} from "../.build/packages/backup/s3-maintenance.js";
function memory({ versioning = true, ignoreConditions = false } = {}) {
  const objects = new S3Objects(
    {
      endpoint: "https://fixture.invalid",
      bucket: "bucket",
      prefix: "fixture",
    },
    { accessKeyId: "fixture", secretAccessKey: "fixture" },
  );
  const files = new Map(),
    deletes = [];
  let pause;
  const fail = () => {
    throw Object.assign(Error("precondition"), {
      $metadata: { httpStatusCode: 412 },
    });
  };
  objects.client.send = async (command) => {
    const p = command.input,
      name = command.constructor.name,
      items = files.get(p.Key) ?? [],
      latest = items.at(-1);
    if (name === "GetBucketVersioningCommand")
      return { Status: versioning ? "Enabled" : undefined };
    if (name === "PutObjectCommand") {
      if (
        !ignoreConditions &&
        ((p.IfNoneMatch === "*" && latest) ||
          (p.IfMatch && latest?.etag !== p.IfMatch))
      )
        fail();
      const bytes = Buffer.from(p.Body),
        v = {
          bytes,
          id: randomUUID(),
          etag: '"' + createHash("md5").update(bytes).digest("hex") + '"',
          date: new Date(),
        };
      files.set(p.Key, [...items, v]);
      return { ETag: v.etag, VersionId: v.id };
    }
    if (name === "ListObjectsV2Command")
      return {
        IsTruncated: false,
        Contents: [...files]
          .filter(([k, v]) => k.startsWith(p.Prefix) && v.length)
          .map(([Key, versions]) => ({
            Key,
            LastModified: versions.at(-1).date,
            Size: versions.at(-1).bytes.length,
          })),
      };
    if (name === "ListObjectVersionsCommand")
      return {
        IsTruncated: false,
        Versions: [...files]
          .filter(([k]) => k.startsWith(p.Prefix))
          .flatMap(([Key, versions]) =>
            versions.map((v) => ({
              Key,
              VersionId: v.id,
              LastModified: v.date,
              Size: v.bytes.length,
            })),
          ),
      };
    if (name === "DeleteObjectCommand") {
      deletes.push({ ...p });
      if (pause) await pause(p);
      if (!p.VersionId) throw Error("unsafe unversioned delete");
      files.set(
        p.Key,
        items.filter((v) => v.id !== p.VersionId),
      );
      return {};
    }
    const v = p.VersionId ? items.find((v) => v.id === p.VersionId) : latest;
    if (!v)
      throw Object.assign(Error("missing"), {
        $metadata: { httpStatusCode: 404 },
        name: "NoSuchKey",
      });
    if (name === "HeadObjectCommand")
      return { ETag: v.etag, VersionId: v.id, ContentLength: v.bytes.length };
    if (name === "GetObjectCommand")
      return {
        ETag: v.etag,
        VersionId: v.id,
        ContentLength: v.bytes.length,
        Body: Readable.from([v.bytes]),
      };
    throw Error(name);
  };
  return {
    objects,
    files,
    deletes,
    pause(fn) {
      pause = fn;
    },
  };
}
async function fixture(t) {
  const root = mkdtempSync("/tmp/anynote-s3-maintenance-"),
    s = new Storage(root),
    m = memory();
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const b = await s.run("createNotebook", { title: "S3 维护" }),
    n = await s.run("createNode", {
      notebookId: b.id,
      title: "正文",
      body: "初版",
    });
  const target = { notebookId: b.id, lineageId: randomUUID() },
    base = `${b.id}/${target.lineageId}`;
  const upload = async (body) => {
    const note = await s.run("getNote", { notebookId: b.id, id: n.id });
    await s.run("saveNote", {
      notebookId: b.id,
      id: n.id,
      expectedRevision: note.revision,
      body,
    });
    const archive = Buffer.from(
      (await s.run("exportArchive", { notebookId: b.id })).data,
      "base64",
    );
    const id = randomUUID();
    await uploadSnapshot(m.objects, archive, { ...target, generationId: id });
    return id;
  };
  const first = await upload("第一版本"),
    second = await upload("第二版本");
  // Distinct stable UTC dates make latest selection independent of UUID ordering.
  for (const id of [first, second]) {
    const key = m.objects.key(`${base}/generations/${id}/manifest.json`),
      v = m.files.get(key).at(-1),
      raw = JSON.parse(v.bytes);
    raw.createdAt =
      id === first ? "2026-10-01T00:00:00.000Z" : "2026-10-02T00:00:00.000Z";
    v.bytes = Buffer.from(JSON.stringify(raw));
    v.etag = '"' + createHash("md5").update(v.bytes).digest("hex") + '"';
    const marker = m.files
      .get(m.objects.key(`${base}/generations/${id}/COMMITTED.json`))
      .at(-1);
    const r = JSON.parse(marker.bytes);
    r.manifestHash = createHash("sha256").update(v.bytes).digest("hex");
    marker.bytes = Buffer.from(JSON.stringify(r));
    marker.etag =
      '"' + createHash("md5").update(marker.bytes).digest("hex") + '"';
  }
  return { ...m, s, b, n, target, base, first, second, upload };
}
test("capability probes reject disabled versioning and ignored condition headers without deleting user keys", async () => {
  for (const flags of [{ versioning: false }, { ignoreConditions: true }]) {
    const m = memory(flags);
    await assert.rejects(
      activateControl(m.objects, `${randomUUID()}/${randomUUID()}`),
      /版本|条件/,
    );
    assert.ok(m.deletes.every((d) => d.Key.includes("/maintenance/probe-")));
  }
});
test("preview is non-destructive, requires activation confirmation and preserves newest restore", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    previewS3Retention(f.objects, f.base, 1, undefined, false),
    /确认/,
  );
  const p = await previewS3Retention(f.objects, f.base, 1, undefined, true);
  assert.deepEqual(
    p.remove.map((v) => v.id),
    [f.first],
  );
  assert.equal(
    await f.objects.has(`${f.base}/generations/${f.first}/COMMITTED.json`),
    true,
  );
  await assert.rejects(
    applyS3Retention(f.objects, f.base, p.id, false),
    /确认/,
  );
  let r;
  do {
    r = await applyS3Retention(f.objects, f.base, p.id, true);
  } while (!r.completed);
  assert.deepEqual(
    (await listSnapshots(f.objects, f.b.id, f.target.lineageId)).map(
      (v) => v.id,
    ),
    [f.second],
  );
  assert.ok(
    (await restoreSnapshot(f.objects, { ...f.target, generationId: f.second }))
      .length > 0,
  );
  await assert.rejects(
    restoreSnapshot(f.objects, { ...f.target, generationId: f.first }),
    /退役/,
  );
  assert.equal(
    (await applyS3Retention(f.objects, f.base, p.id, true)).completed,
    true,
  );
});
test("reader pins protect old generations and a changed control revision invalidates preview", async (t) => {
  const f = await fixture(t);
  await activateControl(f.objects, f.base);
  await withS3Activity(f.objects, f.base, "reader", f.first, async () => {
    const p = await previewS3Retention(f.objects, f.base, 1, undefined, true);
    assert.equal(p.remove.length, 0);
  });
  const p = await previewS3Retention(f.objects, f.base, 1, undefined, true);
  await mutateControl(f.objects, f.base, () => {});
  await assert.rejects(applyS3Retention(f.objects, f.base, p.id, true), /改变/);
});
test("active writers block cleanup planning and cancelled activities remove only their own protection", async (t) => {
  const f = await fixture(t);
  await activateControl(f.objects, f.base);
  await assert.rejects(
    withS3Activity(f.objects, f.base, "writer", randomUUID(), async () => {
      await assert.rejects(
        previewS3Retention(f.objects, f.base, 1, undefined, true),
        /活动/,
      );
      throw Error("cancelled");
    }),
    /cancelled/,
  );
  assert.equal((await readControl(f.objects, f.base)).value.writers.length, 0);
});
test("delete failure leaves durable plan, concurrent retry is idempotent and blocks new activity", async (t) => {
  const f = await fixture(t),
    p = await previewS3Retention(f.objects, f.base, 1, undefined, true);
  let once = true;
  f.pause(async (d) => {
    if (d.Key.includes("/generations/") && once) {
      once = false;
      throw Error("remote failure");
    }
  });
  await assert.rejects(
    applyS3Retention(f.objects, f.base, p.id, true),
    /remote failure/,
  );
  assert.equal(
    (await readControl(f.objects, f.base)).value.plan.status,
    "deleting",
  );
  await assert.rejects(
    withS3Activity(f.objects, f.base, "writer", randomUUID(), async () => {}),
    /维护/,
  );
  f.pause(undefined);
  const results = await Promise.all([
    applyS3Retention(f.objects, f.base, p.id, true),
    applyS3Retention(f.objects, f.base, p.id, true),
  ]);
  assert.ok(results.every((v) => v.completed));
});
test("aged orphan versions are reclaimed and late duplicate deletes cannot touch a re-upload", async (t) => {
  const f = await fixture(t);
  const key = `${f.base}/objects/sha256/${"a".repeat(64)}`;
  await f.objects.put(key, Buffer.from("orphan"));
  const old = f.files.get(f.objects.key(key)).at(-1);
  old.date = new Date(Date.now() - 48 * 3600000);
  const p = await previewS3Retention(f.objects, f.base, 1, undefined, true);
  assert.ok(p.objects.some((v) => v.versionId === old.id));
  await applyS3Retention(f.objects, f.base, p.id, true);
  await f.objects.put(key, Buffer.from("orphan"));
  const fresh = f.files.get(f.objects.key(key)).at(-1);
  assert.notEqual(fresh.id, old.id);
  await f.objects.client.send({
    constructor: { name: "DeleteObjectCommand" },
    input: { Bucket: "bucket", Key: f.objects.key(key), VersionId: old.id },
  });
  assert.equal((await f.objects.get(key)).toString(), "orphan");
});
test("corrupt protected manifests and out-of-scope stored delete keys fail closed", async (t) => {
  const f = await fixture(t);
  await activateControl(f.objects, f.base);
  const p = await previewS3Retention(f.objects, f.base, 1, undefined, true);
  await mutateControl(f.objects, f.base, (c) => {
    c.plan.objects.push({
      key: "another-notebook/object",
      versionId: randomUUID(),
      size: 1,
    });
  });
  await assert.rejects(applyS3Retention(f.objects, f.base, p.id, true), /范围/);
});
test("managed uploads publish through control, hide unaccepted markers and retain independent scopes", async (t) => {
  const f = await fixture(t);
  await activateControl(f.objects, f.base);
  const third = await f.upload("第三版本");
  assert.ok(
    (await readControl(f.objects, f.base)).value.committed.includes(third),
  );
  await mutateControl(f.objects, f.base, (c) => {
    c.committed = c.committed.filter((id) => id !== third);
  });
  assert.equal(
    (await listSnapshots(f.objects, f.b.id, f.target.lineageId)).some(
      (v) => v.id === third,
    ),
    false,
  );
  await assert.rejects(
    restoreSnapshot(f.objects, { ...f.target, generationId: third }),
    /尚未提交/,
  );
});

test("cancelled generation fences a late writer and frees its durable protection without expiring readers", async (t) => {
  const f = await fixture(t);
  await activateControl(f.objects, f.base);
  const generation = randomUUID();
  let release, started;
  const ready = new Promise((r) => (started = r)),
    waiting = new Promise((r) => (release = r));
  const operation = withS3Activity(
    f.objects,
    f.base,
    "writer",
    generation,
    async () => {
      started();
      await waiting;
      return { generationId: generation };
    },
  );
  await ready;
  await cancelS3Generation(f.objects, f.base, generation);
  release();
  await assert.rejects(operation, /失效/);
  const control = (await readControl(f.objects, f.base)).value;
  assert.equal(control.writers.length, 0);
  assert.ok(control.retired.includes(generation));
  assert.ok(!control.committed.includes(generation));
});
