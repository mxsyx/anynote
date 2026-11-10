import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function rustAgingVerifier(settings) {
  return async ({ state, sample, name, phase }) => {
    const output = resolve("tmp/rm34/aging");
    mkdirSync(output, { recursive: true });
    const root = mkdtempSync(join(output, phase + "-"));
    const executable = resolve("target/debug/examples/cloud_probe");
    const connection = {
      id: randomUUID(),
      name: "RM34 aging",
      endpoint: settings.config.endpoint,
      allowInsecure: false,
    };
    const destination = join(root, "restored");
    const input = join(root, "request.json");
    writeFileSync(
      input,
      JSON.stringify({
        operation: "restore",
        root: join(root, "transfer"),
        connection,
        identity: {
          connectionId: connection.id,
          endpoint: connection.endpoint,
          notebookId: sample.manifest.notebookId,
          lineageId: sample.manifest.lineageId,
          direction: "download",
          writer: null,
        },
        generation: sample.manifest.generationId,
        destination,
      }),
      { mode: 0o600 },
    );
    const child = spawnSync(executable, [input], {
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ANYNOTE_TEST_CLOUD_TOKEN: settings.secrets.token },
    });
    assert.equal(child.status, 0, "Rust aging restore process failed");
    const result = JSON.parse(child.stdout);
    assert.ok(
      !result.error,
      "Rust aging restore rejected the retained snapshot",
    );
    const db = new DatabaseSync(
      join(destination, result.ok.id, "notebook.sqlite"),
      { readOnly: true },
    );
    try {
      const note = db
        .prepare(
          "SELECT body FROM note_revisions JOIN notes ON notes.head_revision_id=note_revisions.id WHERE notes.node_id=?",
        )
        .get(state.noteId);
      assert.equal(note?.body, sample.body);
    } finally {
      db.close();
    }
    const record = state.phases[phase];
    record.rustRestores ||= {};
    record.rustRestores[name] = {
      generationId: sample.manifest.generationId,
      notebookId: result.ok.id,
      verifiedAt: new Date().toISOString(),
      executableSha256: createHash("sha256")
        .update(readFileSync(executable))
        .digest("hex"),
    };
  };
}
