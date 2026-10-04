import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  openSync,
  writeSync,
  closeSync,
  realpathSync,
} from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { tmpdir, cpus, totalmem } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import assert from "node:assert/strict";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { captureLocalNotebook } from "../.build/packages/backup/local-capture.js";
import {
  LocalBackupService,
  initializeTarget,
  inspectFilesystem,
  hashFile,
} from "../.build/packages/backup-local/index.js";
const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  assert.ok(
    args[i + 1] && !args[i + 1].startsWith("--"),
    `${name} requires a value`,
  );
  return args[i + 1];
}
const base = resolve(option("--base-dir", tmpdir()));
const concurrency = Number(option("--concurrency", "2"));
assert.ok([1, 2, 3, 4].includes(concurrency));
const samples = option("--samples", "1000:100,10000:100,100000:100,1000:1024")
  .split(",")
  .map((raw) => {
    assert.match(raw, /^\d+:\d+$/);
    const [assets, databaseMiB] = raw.split(":").map(Number);
    assert.ok(
      assets >= 1 &&
        assets <= 100000 &&
        databaseMiB >= 1 &&
        databaseMiB <= 1024,
    );
    return { assets, databaseMiB };
  });
const round = (n) => Number(n.toFixed(2));
function pdf(id, bytes) {
  const content = Buffer.alloc(bytes, 32);
  content.write(
    `% Synthetic PDF ${id}\nBT /F1 12 Tf 50 700 Td (Local backup benchmark ${id}) Tj ET\n`,
  );
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
      content,
      Buffer.from("\nendstream"),
    ]),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const parts = [Buffer.from("%PDF-1.4\n")],
    offsets = [0];
  let length = parts[0].length;
  objects.forEach((object, i) => {
    offsets.push(length);
    const part = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      Buffer.from(object),
      Buffer.from("\nendobj\n"),
    ]);
    parts.push(part);
    length += part.length;
  });
  parts.push(
    Buffer.from(
      `xref\n0 6\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
        .join(
          "",
        )}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}
async function worker(sample) {
  const resumeRoot = option("--resume-root");
  const resume = resumeRoot
    ? JSON.parse(readFileSync(resolve(option("--resume-report")), "utf8"))
    : undefined;
  if (resumeRoot) {
    assert.equal(dirname(resolve(resumeRoot)), base);
    assert.match(
      basename(resumeRoot),
      /^anynote-local-benchmark-[a-zA-Z0-9]{6}$/,
    );
    assert.equal(realpathSync(resumeRoot), resolve(resumeRoot));
    assert.deepEqual(resume.inProgress.sample, sample);
    const expectedStages = [
      "first-backup",
      "unchanged",
      "small-change",
      "full-verification",
      "restore",
    ];
    assert.ok(
      [4, 5].includes(resume.inProgress.metrics.length),
      "Resume requires a completed full verification checkpoint",
    );
    assert.deepEqual(
      resume.inProgress.metrics.map((m) => m.name),
      expectedStages.slice(0, resume.inProgress.metrics.length),
    );
    assert.equal(resume.inProgress.metrics[3].result.status, "passed");
    if (resume.inProgress.root)
      assert.equal(resolve(resume.inProgress.root), resolve(resumeRoot));
  }
  const root = resumeRoot
      ? resolve(resumeRoot)
      : mkdtempSync(join(base, "anynote-local-benchmark-")),
    s = new Storage(join(root, "source"));
  const metrics = resume ? [...resume.inProgress.metrics] : [];
  let captureMs = 0,
    observePhase;
  try {
    const filesystem = await inspectFilesystem(root);
    const estimated =
      sample.databaseMiB * 1024 ** 2 * 5 +
      sample.assets * 2048 * 3 +
      4 * 1024 ** 3;
    assert.ok(
      filesystem.availableBytes > estimated,
      "Insufficient space for isolated benchmark",
    );
    const book = resume
      ? (await s.run("listNotebooks"))[0]
      : await s.run("createNotebook", { title: "Local backup benchmark" });
    assert.equal(book.name, "Local backup benchmark");
    const note = resume
      ? (await s.run("listNodes", { notebookId: book.id })).find(
          (n) => n.kind === "note",
        )
      : await s.run("createNode", {
          notebookId: book.id,
          title: "Benchmark fixture",
          body: "seed",
        });
    const db = s.open(book.id),
      source = s.directory(book.id);
    const insertAsset = db.prepare("INSERT INTO assets VALUES(?,?,?,?)"),
      insertResource = db.prepare(
        "INSERT INTO resources(id,asset_hash,original_name) VALUES(?,?,?)",
      );
    const largePDFs = Math.min(8, Math.max(1, Math.ceil(sample.assets / 1000)));
    function register(path, hash, size, mime) {
      insertAsset.run(hash, size, mime, path);
      insertResource.run(randomUUID(), hash, "benchmark");
    }
    function add(bytes, mime = "application/octet-stream") {
      const hash = createHash("sha256").update(bytes).digest("hex"),
        path = `assets/sha256/${hash.slice(0, 2)}/${hash}.bin`;
      mkdirSync(join(source, path, ".."), { recursive: true });
      writeFileSync(join(source, path), bytes);
      register(path, hash, bytes.length, mime);
    }
    const seedStarted = performance.now();
    if (!resume) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (let i = 0; i < sample.assets; i++) {
          if (i < largePDFs) add(pdf(i, 8 * 1024 ** 2), "application/pdf");
          else {
            const b = Buffer.alloc(1024);
            b.write(`attachment-${i}`);
            add(b);
          }
          if (i > 0 && i % 10000 === 0)
            console.log(
              `seed ${sample.assets}:${sample.databaseMiB}: ${i} assets`,
            );
        }
        const revision = db.prepare(
            "INSERT INTO note_revisions(id,note_id,body,created_at) VALUES(?,?,?,?)",
          ),
          body = "x".repeat(1024 ** 2);
        while (
          db.prepare("PRAGMA page_count").get().page_count *
            db.prepare("PRAGMA page_size").get().page_size <
          sample.databaseMiB * 1024 ** 2
        )
          revision.run(randomUUID(), note.id, body, Date.now());
        db.exec("COMMIT");
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
    const databaseBytes =
      db.prepare("PRAGMA page_count").get().page_count *
      db.prepare("PRAGMA page_size").get().page_size;
    mkdirSync(join(root, "disk"), { recursive: true });
    const target = await initializeTarget(join(root, "disk"), [s.root]),
      engine = new LocalBackupService();
    const dest = join(target.path, "notebooks", book.id);
    const capture = async () => {
      const dir = mkdtempSync(join(root, "capture-")),
        start = performance.now();
      try {
        const c = await captureLocalNotebook(s, book.id, dir);
        captureMs += performance.now() - start;
        c.release = async () => rmSync(dir, { recursive: true, force: true });
        return c;
      } catch (e) {
        rmSync(dir, { recursive: true, force: true });
        throw e;
      }
    };
    const run = (extra = {}) => {
      const { onProgress, ...options } = extra;
      return engine.backup(target, book.id, capture, {
        sources: [s.root],
        concurrency,
        readRevision: () =>
          s.run("readLocalBackupRevision", { notebookId: book.id }),
        ...options,
        onProgress: (p) => {
          observePhase?.(p);
          onProgress?.(p);
        },
      });
    };
    async function measure(name, fn) {
      const delay = monitorEventLoopDelay({ resolution: 20 });
      delay.enable();
      let rss = process.memoryUsage().rss;
      const timer = setInterval(() => {
        rss = Math.max(rss, process.memoryUsage().rss);
      }, 50);
      const started = performance.now(),
        capturedBefore = captureMs;
      const phaseWallMs = {};
      let phase, phaseStarted;
      const finishPhase = () => {
        if (phase)
          phaseWallMs[phase] =
            (phaseWallMs[phase] || 0) + performance.now() - phaseStarted;
      };
      observePhase = (p) => {
        if (p.phase !== phase) {
          finishPhase();
          phase = p.phase;
          phaseStarted = performance.now();
        }
      };

      try {
        const result = await fn();
        finishPhase();
        const metric = {
          phaseWallMs: Object.fromEntries(
            Object.entries(phaseWallMs).map(([phase, ms]) => [
              phase,
              round(ms),
            ]),
          ),
          name,
          segment: resume ? "resumed-process" : "initial-process",
          durationMs: round(performance.now() - started),
          captureMs: round(captureMs - capturedBefore),
          sampledPeakRssMiB: round(
            Math.max(rss, process.memoryUsage().rss) / 1024 ** 2,
          ),
          processPeakRssMiB: round(process.resourceUsage().maxRSS / 1024),
          eventLoopP99Ms: round(delay.percentile(99) / 1e6),
          eventLoopMaxMs: round(delay.max / 1e6),
          result,
        };
        metrics.push(metric);
        process.send?.({ kind: "progress", sample, root, metrics });
        console.log(
          `${sample.assets}:${sample.databaseMiB} ${name}: ${metric.durationMs} ms`,
        );
        return result;
      } finally {
        observePhase = undefined;
        clearInterval(timer);
        delay.disable();
      }
    }
    const seedMs = resume ? null : round(performance.now() - seedStarted);
    const atLimit = sample.assets === 100000;
    const dropOneResource = () =>
      db
        .prepare(
          "DELETE FROM resources WHERE id=(SELECT id FROM resources ORDER BY id LIMIT 1)",
        )
        .run();
    if (!resume) {
      const first = await measure("first-backup", () => run());
      assert.equal(first.copiedFiles, sample.assets + 2);
      const unchanged = await measure("unchanged", () => run());
      assert.equal(unchanged.copiedBytes, 0);
      assert.equal(unchanged.captureSkipped, true);
      if (atLimit) dropOneResource();
      add(Buffer.from("small-change"));
      const changed = await measure("small-change", () => run());
      assert.equal(changed.copiedFiles, 2);
      assert.equal(changed.skippedFiles, sample.assets + (atLimit ? 0 : 1));
      await measure("full-verification", async () => {
        let report;
        await engine.verify(target, book.id, undefined, (r) => {
          report = r;
        });
        assert.equal(report.status, "passed");
        return {
          status: report.status,
          checkedFiles: report.checkedFiles,
          checkedBytes: report.checkedBytes,
        };
      });
    } else {
      const manifest = JSON.parse(
        readFileSync(join(dest, ".backup/manifest.json"), "utf8"),
      );
      assert.equal(manifest.notebookId, book.id);
      assert.equal(manifest.targetId, target.id);
      assert.deepEqual(
        manifest.revision,
        resume.inProgress.metrics[2].result.revision,
      );
      assert.equal(manifest.files.length, sample.assets + (atLimit ? 0 : 1));
    }
    rmSync(join(root, "restore"), { recursive: true, force: true });
    if (!metrics.some((m) => m.name === "restore"))
      await measure("restore", async () => {
        const path = join(root, "restore");
        mkdirSync(path);
        const m = await engine.restore(target, book.id, path);
        assert.equal(
          await hashFile(join(path, "notebook.sqlite")),
          m.database.sha256,
        );
        return { assets: m.files.length, databaseBytes: m.database.size };
      });
    rmSync(join(root, "restore"), { recursive: true, force: true });
    // Add a streamed 1GiB cancellation fixture without keeping its bytes in memory.
    const block = Buffer.alloc(1024 ** 2, 42),
      hash = createHash("sha256");
    for (let i = 0; i < 1024; i++) hash.update(block);
    const digest = hash.digest("hex"),
      path = `assets/sha256/${digest.slice(0, 2)}/${digest}.bin`;
    mkdirSync(join(source, path, ".."), { recursive: true });
    const fd = openSync(join(source, path), "w");
    try {
      for (let i = 0; i < 1024; i++)
        assert.equal(writeSync(fd, block), block.length);
    } finally {
      closeSync(fd);
    }
    if (!db.prepare("SELECT 1 FROM resources WHERE asset_hash=?").get(digest)) {
      if (atLimit) dropOneResource();
      db.prepare("INSERT OR IGNORE INTO assets VALUES(?,?,?,?)").run(
        digest,
        1024 ** 3,
        "application/octet-stream",
        path,
      );
      insertResource.run(randomUUID(), digest, "benchmark");
    }
    const before = readFileSync(join(dest, ".backup/manifest.json"), "utf8");
    await measure("cancel-large-file", async () => {
      const controller = new AbortController();
      let abortAt;
      await assert.rejects(
        run({
          signal: controller.signal,
          onProgress: (p) => {
            if (
              !controller.signal.aborted &&
              p.phase === "复制中" &&
              p.copiedBytes > 0
            ) {
              abortAt = performance.now();
              controller.abort();
            }
          },
        }),
        () => controller.signal.aborted,
      );
      const abortToReturnMs = round(performance.now() - abortAt);
      assert.ok(abortAt);
      assert.equal(
        readFileSync(join(dest, ".backup/manifest.json"), "utf8"),
        before,
      );
      assert.equal(
        await hashFile(join(dest, "notebook.sqlite")),
        JSON.parse(before).database.sha256,
      );
      return {
        cancelled: true,
        abortToReturnMs,
        oldDatabasePreserved: true,
      };
    });
    return {
      passed: true,
      sample: {
        ...sample,
        databaseBytes,
        largePDFs,
        smallFileBytes: 1024,
        pdfBytes: 8 * 1024 ** 2,
        cancelFixtureBytes: 1024 ** 3,
        smallChangeMode: atLimit
          ? "replace-one-resource-to-respect-100000-limit"
          : "add-one-resource",
      },
      filesystem,
      seedMs,
      metrics,
      uiResponse:
        "not measured; event-loop metrics describe the Node benchmark process",
      temporaryDataRemoved: true,
      resumed: Boolean(resume),
    };
  } finally {
    s.close();
    rmSync(root, { recursive: true, force: true });
  }
}
if (args.includes("--worker")) {
  try {
    const result = await worker(samples[0]);
    process.send(result);
  } catch (e) {
    process.send({ passed: false, sample: samples[0], error: e.stack });
    process.exitCode = 1;
  } finally {
    process.disconnect();
  }
} else {
  const resumeReport = option("--resume-report");
  const reportPath = resolve(
    option(
      "--report-path",
      resumeReport || "artifacts/local-backup-benchmark.json",
    ),
  );
  mkdirSync(join(reportPath, ".."), { recursive: true });
  const report = resumeReport
    ? JSON.parse(readFileSync(resolve(resumeReport), "utf8"))
    : {
        passed: false,
        startedAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
        cpu: cpus()[0]?.model,
        logicalCPUs: cpus().length,
        totalMemoryGiB: round(totalmem() / 1024 ** 3),
        baseDirectory: base,
        concurrency,
        requestedSamples: samples,
        cacheCondition: "warm OS caches; no cache eviction; one run per stage",
        boundary:
          "Same-host source and target. No USB/HDD, cold-cache or renderer UI performance claims.",
        samples: [],
      };
  if (resumeReport) {
    assert.equal(report.passed, false);
    assert.deepEqual(report.requestedSamples, samples);
    assert.equal(report.baseDirectory, base);
    assert.equal(report.concurrency, concurrency);
    assert.ok(
      option("--resume-root"),
      "--resume-report requires the interrupted fixture root",
    );
    report.resumedAt = new Date().toISOString();
    delete report.finishedAt;
  }
  let usedResume = false;
  const save = () =>
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  save();
  try {
    for (const sample of samples) {
      if (
        report.samples.some(
          (s) =>
            s.passed &&
            s.sample.assets === sample.assets &&
            s.sample.databaseMiB === sample.databaseMiB,
        )
      )
        continue;
      const resuming = Boolean(resumeReport && !usedResume);
      usedResume ||= resuming;
      let result;
      const child = fork(
        fileURLToPath(import.meta.url),
        [
          "--worker",
          "--samples",
          `${sample.assets}:${sample.databaseMiB}`,
          "--base-dir",
          base,
          "--concurrency",
          String(concurrency),
          ...(resuming
            ? [
                "--resume-root",
                resolve(option("--resume-root")),
                "--resume-report",
                resolve(resumeReport),
              ]
            : []),
        ],
        { stdio: ["ignore", "inherit", "inherit", "ipc"] },
      );
      child.on("message", (r) => {
        if (r.kind === "progress") {
          report.inProgress = r;
          save();
        } else result = r;
      });
      const [code] = await once(child, "exit");
      assert.ok(result, "Benchmark worker exited without a report");
      delete report.inProgress;
      report.samples.push(result);
      save();
      assert.equal(code, 0, result.error);
      assert.equal(result.passed, true, result.error);
    }
    report.passed = true;
  } finally {
    report.finishedAt = new Date().toISOString();
    save();
  }
  console.log(`Local backup benchmark passed: ${reportPath}`);
}
