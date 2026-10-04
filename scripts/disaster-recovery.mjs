import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  lstatSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { hostname, platform, arch } from "node:os";
import assert from "node:assert/strict";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { logicalTables } from "../.build/packages/protocol/cloud-objects.js";
import { hashFile } from "../.build/packages/storage-sqlite/archive-stream.js";
const args = process.argv.slice(2),
  mode = args.shift(),
  kitArgument = args.shift(),
  kit = resolve(kitArgument || ".");
if (
  !["prepare", "verify"].includes(mode) ||
  !kitArgument ||
  args.some((v) => v !== "--allow-same-host")
)
  throw Error(
    "用法：node scripts/disaster-recovery.mjs prepare <新验收包目录> | verify <验收包目录> [--allow-same-host]",
  );
function hostIdentity() {
  let machine;
  try {
    machine = readFileSync("/etc/machine-id", "utf8").trim();
  } catch {
    machine = hostname();
  }
  return createHash("sha256")
    .update(platform() + ":" + arch() + ":" + machine)
    .digest("hex");
}
function canonical(value, book) {
  if (typeof value === "string") return value.replaceAll(book, "$NOTEBOOK");
  if (Array.isArray(value)) return value.map((v) => canonical(v, book));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k], book)]),
    );
  return value;
}
async function snapshot(s, book, sourceBook = book) {
  const db = s.open(book),
    tables = {},
    assets = [];
  for (const table of [...logicalTables, "note_text"]) {
    let rows = db.prepare(`SELECT * FROM ${table}`).all();
    if (table === "notebook_meta")
      rows = rows.map((r) => ({
        ...r,
        name: r.name.replace(/（导入）$/, ""),
        id: "$NOTEBOOK",
      }));
    tables[table] = rows
      .map((r) =>
        JSON.stringify(canonical(r, table === "changes" ? sourceBook : book)),
      )
      .sort();
  }
  for (const a of db.prepare("SELECT * FROM assets ORDER BY hash").all()) {
    const hash = await hashFile(s.notebookPath(book, a.path));
    assert.equal(hash.sha256, a.hash);
    assert.equal(hash.size, a.size);
    assets.push({ hash: a.hash, size: a.size, mime: a.mime });
  }
  return { tables, assets };
}
async function complete(s, result) {
  const job = s.jobs.get(result.id);
  await job.promise;
  assert.equal(job.status, "completed", job.error);
  return job;
}
function pdf() {
  const stream = "BT /F1 18 Tf 40 200 Td (Recovery fixture) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n",
    offsets = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  return Buffer.from(
    body +
      "xref\n0 6\n0000000000 65535 f \n" +
      offsets.map((v) => String(v).padStart(10, "0") + " 00000 n \n").join("") +
      `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`,
  );
}
const root = mkdtempSync("/tmp/anynote-disaster-recovery-"),
  s = new Storage(root);
let report;
try {
  if (mode === "prepare") {
    if (existsSync(kit))
      throw Error("验收包目录必须尚不存在，避免覆盖已有数据");
    mkdirSync(kit, { recursive: true, mode: 0o700 });
    const b = await s.run("createNotebook", { title: "跨设备灾难恢复验收" }),
      call = (op, p = {}) => s.run(op, { notebookId: b.id, ...p });
    const folder = await call("createNode", {
      kind: "folder",
      title: "深层资料",
    });
    const note = await call("createNode", {
      title: "中文恢复正文",
      parentId: folder.id,
      body: "第一版",
    });
    await call("saveNote", {
      id: note.id,
      expectedRevision: note.revision,
      body: `中文恢复正文 [自己](anynote://notebook/${b.id}/note/${note.id})\n\n:::anynote{type="future.keep" version="9"}\n{"keep":"原样保留"}\n:::\n`,
      tags: ["恢复验收"],
      favorite: true,
    });
    const image = await call("importFile", {
      name: "fixture.png",
      mime: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=",
    });
    const document = await call("importFile", {
      name: "fixture.pdf",
      mime: "application/pdf",
      data: pdf().toString("base64"),
    });
    const resource = await call("getAsset", {
      id: document.primary_resource_id,
    });
    await call("addAnnotation", {
      id: document.id,
      assetHash: resource.hash,
      page: 1,
      selector: [],
      quote: "Recovery fixture",
      body: "恢复后批注一致",
    });
    await call("indexPdf", {
      id: document.id,
      assetHash: resource.hash,
      body: "Recovery fixture",
    });
    await call("trashNode", { id: image.id });
    // Independent fixture data, never writes to a user's notebook.
    s.open(b.id)
      .prepare(
        "INSERT INTO extension_data(extension_id,key,value_json,schema_version,revision) VALUES(?,?,?,?,?)",
      )
      .run(
        "garden.recovery",
        "counter",
        JSON.stringify({ count: 3, unknown: "保留" }),
        1,
        1,
      );
    const expected = await snapshot(s, b.id);
    await complete(
      s,
      await s.run("startExportArchiveFile", {
        notebookId: b.id,
        path: join(kit, "fixture.anynote"),
      }),
    );
    const archive = await hashFile(join(kit, "fixture.anynote"));
    const evidence = {
      format: "anynote.portable-recovery-kit.v1",
      runId: randomUUID(),
      createdAt: new Date().toISOString(),
      sourceHost: hostIdentity(),
      sourcePlatform: platform(),
      sourceArch: arch(),
      sourceNotebook: b.id,
      archive,
      expected,
      searchQuery: "中文恢复正文",
    };
    writeFileSync(
      join(kit, "evidence.json"),
      JSON.stringify(evidence, null, 2) + "\n",
      { mode: 0o600 },
    );
    writeFileSync(
      join(kit, "README.txt"),
      "将整个目录复制到另一台干净设备。准备 Node 24+ 和已构建的 Anynote 仓库，执行：\nnode scripts/disaster-recovery.mjs verify <本目录>\n仅有本包和运行时即可恢复，不读取原设备目录或云凭据。\n本机排练须显式添加 --allow-same-host，报告不会标记为跨设备验收。\n",
    );
    console.log("prepared: " + kit);
  } else {
    if (lstatSync(join(kit, "evidence.json")).size > 10 * 1024 ** 2)
      throw Error("恢复证据超过预算");
    const e = JSON.parse(readFileSync(join(kit, "evidence.json")));
    assert.equal(e.format, "anynote.portable-recovery-kit.v1");
    const same = e.sourceHost === hostIdentity();
    if (same && !args.includes("--allow-same-host"))
      throw Error(
        "检测到同一主机；正式验收需要另一台设备，本机排练须 --allow-same-host",
      );
    report = {
      format: "anynote.portable-recovery-acceptance.v1",
      runId: e.runId,
      status: "running",
      mode: same ? "same-host-rehearsal" : "distinct-host-recovery",
      independentPhysicalDeviceVerified: false,
      sourcePlatform: e.sourcePlatform,
      restorePlatform: platform(),
      restoreArch: arch(),
      sameHost: same,
      checks: [],
      limitations: [
        "主机标识不同只能证明运行环境标识不同，不能自动证明独立物理设备或整机故障；需人工记录设备与故障过程。",
      ],
    };
    assert.deepEqual(await hashFile(join(kit, "fixture.anynote")), e.archive);
    report.checks.push({ name: "归档大小与 SHA-256", status: "passed" });
    const restored = await complete(
      s,
      await s.run("startImportArchiveFile", {
        path: join(kit, "fixture.anynote"),
      }),
    );
    const actual = await snapshot(s, restored.restoredId, e.sourceNotebook);
    for (const table of Object.keys(actual.tables))
      assert.ok(
        JSON.stringify(actual.tables[table]) ===
          JSON.stringify(e.expected.tables[table]),
        `恢复表 ${table} 与证据不一致`,
      );
    assert.ok(
      JSON.stringify(actual.assets) === JSON.stringify(e.expected.assets),
      "附件清单与证据不一致",
    );
    const note = e.expected.tables.notes
      .map((v) => JSON.parse(v))
      .find((v) => v.note_type === "markdown");
    const body = await s.run("getNote", {
      notebookId: restored.restoredId,
      id: note.node_id,
    });
    assert.ok(
      body.body.includes(
        `anynote://notebook/${restored.restoredId}/note/${note.node_id}`,
      ),
      "自链接未映射到新 Notebook",
    );
    report.checks.push({
      name: "正文、目录、标签收藏、历史、回收站、批注和插件数据逐表一致",
      status: "passed",
    });
    report.checks.push({ name: "全部附件大小与 SHA-256", status: "passed" });
    const hits = await s.run("search", {
      notebookId: restored.restoredId,
      query: e.searchQuery,
    });
    assert.ok(hits.length > 0);
    report.checks.push({ name: "恢复后重建搜索", status: "passed" });
    report.status = "passed";
    console.log(report.mode + " — passed");
  }
} catch (e) {
  if (report) {
    report.status = "failed";
    report.error = e.message;
  }
  throw e;
} finally {
  s.close();
  rmSync(root, { recursive: true, force: true });
  if (report) {
    mkdirSync("test-results", { recursive: true });
    writeFileSync(
      "test-results/portable-recovery-acceptance.json",
      JSON.stringify(report, null, 2) + "\n",
    );
  }
}
