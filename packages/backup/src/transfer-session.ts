import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync, type BackupTarget } from "@anynote/types/runtime.js";
import { assertLocalPath } from "@anynote/storage-sqlite/workspace.js";

/** One durable slot per connection and direction; SQLite releases the lease on process death. */
export class TransferSession {
  readonly dir: string;
  private lease: InstanceType<typeof DatabaseSync>;

  constructor(root: string, target: BackupTarget, kind: "upload" | "download") {
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          kind,
          target.id,
          target.endpoint,
          target.remoteNotebookId || target.notebookId,
          target.lineageId,
          ...(kind === "upload"
            ? [target.deviceId, target.writerEpoch || 1]
            : []),
        ]),
      )
      .digest("hex");
    const base = assertLocalPath(root, "_local/cloud.transfers");
    mkdirSync(base, { recursive: true, mode: 0o700 });
    this.dir = assertLocalPath(root, `_local/cloud.transfers/${key}`);
    this.lease = new DatabaseSync(
      assertLocalPath(root, `_local/cloud.transfers/${key}.sqlite`),
    );
    try {
      this.lease.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      this.lease.close();
      throw error;
    }
  }

  path(name: string) {
    return assertLocalPath(this.dir, name);
  }

  read<T>(key: string): T | undefined {
    const file = this.path(key + ".json");
    if (!existsSync(file)) return;
    try {
      const record = JSON.parse(readFileSync(file, "utf8"));
      return record.format === "anynote.cloud-transfer.v1"
        ? record.value
        : undefined;
    } catch {
      return;
    }
  }

  write(key: string, value: unknown) {
    const file = this.path(key + ".json");
    const temp = this.path(key + ".json.tmp");
    writeFileSync(
      temp,
      JSON.stringify({ format: "anynote.cloud-transfer.v1", value }),
      { mode: 0o600, flush: true },
    );
    renameSync(temp, file);
  }

  /** A changed cut or manifest replaces the entire slot before any bytes are reused. */
  reset() {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { mode: 0o700 });
  }

  close(completed = false) {
    try {
      if (completed) rmSync(this.dir, { recursive: true, force: true });
    } finally {
      this.lease.close();
    }
  }
}

export interface MultipartProgress {
  uploadId: string;
  parts: { partNumber: number; etag: string; sha256: string }[];
}
