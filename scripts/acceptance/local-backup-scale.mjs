import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir, cpus, totalmem } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { _electron } from "playwright";
import { Storage } from "../../.build/packages/storage-sqlite/index.js";
import { assetPath } from "../../.build/packages/protocol/assets.js";
import { openNotebook } from "./open-notebook.mjs";

/** Real Electron/IPC measurement; fixture creation is excluded from timings. */
export async function localBackupScale(args) {
  const option = (key, fallback) =>
    args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
  const counts = option("--samples", "10000,100000").split(",").map(Number);
  const timeoutMs = Number(option("--timeout-ms", "7200000"));
  assert.ok(counts.every((n) => Number.isInteger(n) && n > 0 && n <= 100000));
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  const reportPath = resolve(
    option("--report-path", "artifacts/local-backup-scale.json"),
  );
  const report = {
    passed: false,
    platform: process.platform,
    cpu: cpus()[0]?.model,
    memoryGiB: totalmem() / 1024 ** 3,
    startedAt: new Date().toISOString(),
    timeoutMs,
    samples: [],
    fixture:
      "g08-v1: deterministic 1KiB assets, 100MiB SQLite, two Notebooks; warm caches",
    boundary:
      "Real Electron renderer, main and storage processes on this host; synthetic data, same local volume. Frame phase labels are the latest IPC observation, not internal phase timestamps. No external-device or low-spec claims.",
  };
  const save = () => {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  };
  save();
  try {
    for (const count of counts) {
      const reuse = option("--reuse-root");
      if (reuse) {
        assert.equal(counts.length, 1);
        assert.match(basename(reuse), /^anynote-g08-desktop-[a-zA-Z0-9]{6}$/);
        assert.equal(realpathSync(reuse), resolve(reuse));
      }
      const root = reuse
        ? resolve(reuse)
        : mkdtempSync(
            join(
              resolve(option("--base-dir", tmpdir())),
              "anynote-g08-desktop-",
            ),
          );
      let electron;
      const sample = {
        count,
        metrics: [],
        reusedFixture: Boolean(reuse),
        root,
      };
      report.samples.push(sample);
      save();
      try {
        const storage = new Storage(join(root, "notebooks"));
        let book, target, note, second;
        try {
          if (reuse) {
            const books = await storage.run("listNotebooks");
            book = books.find((b) => b.name === "G08 scale");
            second = books.find((b) => b.name === "G08 second");
            assert.ok(book && second);
            note = (
              await storage.run("listNodes", { notebookId: book.id })
            ).find((n) => n.kind === "note" && n.title === "Scale");
            assert.ok(note);
            assert.equal(
              storage
                .open(book.id)
                .prepare("SELECT count(*) AS n FROM assets")
                .get().n,
              count,
            );
            [target] = await storage.run("listLocalBackupTargets", {
              notebookId: book.id,
            });
            assert.equal(
              realpathSync(target.path),
              realpathSync(join(root, "disk/AnynoteBackup")),
            );
          } else {
            book = await storage.run("createNotebook", { title: "G08 scale" });
            second = await storage.run("createNotebook", {
              title: "G08 second",
            });
            note = await storage.run("createNode", {
              notebookId: book.id,
              title: "Scale",
              body: "seed",
            });
            const db = storage.open(book.id),
              dir = storage.directory(book.id);
            const insert = db.prepare(
              "INSERT INTO assets(hash,size,mime) VALUES(?,?,?)",
            );
            const resource = db.prepare(
              "INSERT INTO resources(id,asset_hash,original_name) VALUES(?,?,?)",
            );
            db.exec("BEGIN IMMEDIATE");
            for (let i = 0; i < count; i++) {
              const bytes = Buffer.alloc(1024);
              bytes.write(`g08-asset-${i}`);
              const hash = createHash("sha256").update(bytes).digest("hex"),
                path = join(dir, assetPath(hash));
              mkdirSync(dirname(path), { recursive: true });
              writeFileSync(path, bytes);
              insert.run(hash, bytes.length, "application/octet-stream");
              resource.run(randomUUID(), hash, `asset-${i}`);
            }
            const revision = db.prepare(
              "INSERT INTO note_revisions(id,note_id,body,created_at) VALUES(?,?,?,?)",
            );
            while (
              db.prepare("PRAGMA page_count").get().page_count *
                db.prepare("PRAGMA page_size").get().page_size <
              100 * 1024 ** 2
            )
              revision.run(randomUUID(), note.id, "x".repeat(1024 ** 2), 1);
            db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
            const disk = join(root, "disk");
            mkdirSync(disk);
            target = await storage.run("configureLocalBackup", {
              notebookId: book.id,
              path: disk,
            });
            await storage.run("configureLocalBackup", {
              notebookId: second.id,
              path: disk,
            });
          }
          const db = storage.open(book.id);
          sample.databaseBytes =
            db.prepare("PRAGMA page_count").get().page_count *
            db.prepare("PRAGMA page_size").get().page_size;
        } finally {
          storage.close();
        }
        console.log(`Seeded Electron ${count} assets`);
        electron = await _electron.launch({
          args: [".", "--no-sandbox"],
          env: {
            ...process.env,
            ANYNOTE_USER_DATA_DIR: root,
            ANYNOTE_DEV: "",
            ELECTRON_RUN_AS_NODE: "",
          },
        });
        const page = await electron.firstWindow();
        await openNotebook(page);
        await page.bringToFront();
        report.versions = await electron.evaluate(() => process.versions);
        const request = (op, input = {}) =>
          page.evaluate(({ op, input }) => window.anynote.request(op, input), {
            op,
            input,
          });
        const input = { notebookId: book.id, targetId: target.id };
        const manifestPath = join(
          target.path,
          "notebooks",
          book.id,
          ".backup/manifest.json",
        );
        async function measure(
          name,
          op = "startLocalBackup",
          payload = input,
          cancelPhase,
        ) {
          const peaks = {};
          let polling = true;
          const memory = (async () => {
            while (polling) {
              const metrics = await electron.evaluate(({ app }) =>
                app.getAppMetrics(),
              );
              for (const m of metrics) {
                const key = m.name || m.type;
                peaks[key] = Math.max(
                  peaks[key] || 0,
                  m.memory.workingSetSize / 1024,
                );
              }
              await new Promise((r) => setTimeout(r, 100));
            }
          })();
          let result;
          try {
            result = await page.evaluate(
              async ({ op, payload, cancelPhase, timeoutMs }) => {
                const started = performance.now(),
                  frames = [],
                  queries = [],
                  phases = {};
                let last = started,
                  phase = "starting",
                  frameId,
                  running = true;
                const frame = (now) => {
                  if (running) {
                    frames.push({ phase, ms: now - last });
                    last = now;
                    frameId = requestAnimationFrame(frame);
                  }
                };
                frameId = requestAnimationFrame(frame);
                let cancelAt, cancelAckMs, terminalMs, task;
                try {
                  const handle = await window.anynote.request(op, payload);
                  while (performance.now() - started < timeoutMs) {
                    const before = performance.now();
                    [task] = await window.anynote.request("listTasks", {
                      id: handle.id,
                    });
                    queries.push({ phase, ms: performance.now() - before });
                    phase = task.phase || task.status;
                    phases[phase] = (phases[phase] || 0) + 1;
                    if (
                      cancelPhase &&
                      !cancelAt &&
                      phase === cancelPhase &&
                      task.status === "running"
                    ) {
                      cancelAt = performance.now();
                      await window.anynote.request("cancelTask", {
                        id: handle.id,
                      });
                      cancelAckMs = performance.now() - cancelAt;
                    }
                    if (!["running", "committing"].includes(task.status)) {
                      terminalMs = cancelAt
                        ? performance.now() - cancelAt
                        : undefined;
                      break;
                    }
                    await new Promise((r) => setTimeout(r, 20));
                  }
                  // Include the final frame across completion instead of losing its interval.
                  await new Promise(requestAnimationFrame);
                  const stats = (values) => {
                    values.sort((a, b) => a - b);
                    return {
                      samples: values.length,
                      p99Ms:
                        values[
                          Math.min(
                            values.length - 1,
                            Math.floor(values.length * 0.99),
                          )
                        ] || 0,
                      maxMs: values.at(-1) || 0,
                    };
                  };
                  return {
                    durationMs: performance.now() - started,
                    task,
                    phases,
                    cancelAckMs,
                    cancelToTerminalMs: terminalMs,
                    frames: stats(frames.map((f) => f.ms)),
                    queries: stats(queries.map((q) => q.ms)),
                    byPhase: Object.fromEntries(
                      [
                        ...new Set([...frames, ...queries].map((v) => v.phase)),
                      ].map((p) => [
                        p,
                        {
                          frames: stats(
                            frames
                              .filter((f) => f.phase === p)
                              .map((f) => f.ms),
                          ),
                          queries: stats(
                            queries
                              .filter((q) => q.phase === p)
                              .map((q) => q.ms),
                          ),
                        },
                      ]),
                    ),
                  };
                } finally {
                  running = false;
                  cancelAnimationFrame(frameId);
                }
              },
              { op, payload, cancelPhase, timeoutMs },
            );
          } finally {
            polling = false;
            await memory;
          }
          sample.metrics.push({ name, ...result, sampledPeakRssMiB: peaks });
          save();
          console.log(
            `Electron ${count} ${name}: ${Math.round(result.durationMs)}ms, query max ${Math.round(result.queries.maxMs)}ms`,
          );
          assert.equal(
            result.task.status,
            cancelPhase ? "cancelled" : "completed",
            result.task.error,
          );
          if (cancelPhase)
            assert.ok(
              Number.isFinite(result.cancelToTerminalMs),
              "Requested cancellation phase was not observed",
            );
          return result;
        }
        sample.reconciliationRequired = existsSync(
          join(target.path, "notebooks", book.id, ".backup/pending.json"),
        );
        await measure(
          sample.reconciliationRequired
            ? "first-backup-with-reconciliation"
            : "first-backup",
        );
        await measure("unchanged");
        let before = readFileSync(manifestPath, "utf8");
        await measure("cancel-check", "startLocalBackup", input, "检查中");
        assert.equal(readFileSync(manifestPath, "utf8"), before);
        async function edit(body) {
          const current = await request("getNote", {
            notebookId: book.id,
            id: note.id,
          });
          await request("saveNote", {
            notebookId: book.id,
            id: note.id,
            expectedRevision: current.revision,
            body,
          });
        }
        await edit("capture cancellation");
        await measure(
          "cancel-capture",
          "startLocalBackup",
          input,
          "准备数据库",
        );
        assert.equal(readFileSync(manifestPath, "utf8"), before);
        await measure("small-change");
        await measure("two-notebook-group", "startLocalBackupGroup", {
          diskId: target.diskId,
        });
        sample.passed = true;
      } catch (e) {
        sample.error = e.stack;
        save();
        throw e;
      } finally {
        await electron?.close();
        if (!reuse && sample.passed)
          rmSync(root, { recursive: true, force: true });
        else sample.retainedFixture = root;
        save();
      }
    }
    report.passed = true;
  } finally {
    report.finishedAt = new Date().toISOString();
    save();
  }
  console.log(`Electron scale report: ${reportPath}`);
}
