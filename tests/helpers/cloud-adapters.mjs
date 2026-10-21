import { createHash, randomUUID } from "node:crypto";
if (!crypto.DigestStream)
  crypto.DigestStream = class extends WritableStream {
    constructor() {
      const hash = createHash("sha256");
      let resolve, reject;
      const digest = new Promise((a, b) => {
        resolve = a;
        reject = b;
      });
      super({
        write(bytes) {
          hash.update(bytes);
        },
        close() {
          const b = hash.digest();
          resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
        },
        abort: reject,
      });
      this.digest = digest;
    }
  };
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
export class D1 {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(
      readFileSync(
        new URL(
          "../../apps/cloudflare-backup/migrations/0001.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    this.db.exec(
      readFileSync(
        new URL(
          "../../apps/cloudflare-backup/migrations/0002.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    this.db.exec(
      readFileSync(
        new URL(
          "../../apps/cloudflare-backup/migrations/0003.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    this.db.exec(
      readFileSync(
        new URL(
          "../../apps/cloudflare-backup/migrations/0004.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  }
  prepare(sql) {
    const self = this;
    let values = [];
    return {
      bind(...v) {
        values = v;
        return this;
      },
      async first() {
        return self.db.prepare(sql).get(...values) || null;
      },
      async all() {
        return { results: self.db.prepare(sql).all(...values) };
      },
      async run() {
        return self.db.prepare(sql).run(...values);
      },
    };
  }
  async batch(statements) {
    this.db.exec("BEGIN");
    try {
      const rows = [];
      for (const p of statements) rows.push(await p.run());
      this.db.exec("COMMIT");
      return rows;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
export class R2 {
  constructor() {
    this.objects = new Map();
    this.uploads = new Map();
    this.metadata = new Map();
  }
  async put(k, b) {
    this.objects.set(k, Buffer.from(b));
    const { createHash } = await import("node:crypto");
    this.metadata.set(k, {
      uploaded: new Date(),
      etag: createHash("md5").update(Buffer.from(b)).digest("hex"),
    });
  }
  async head(k) {
    return this.objects.has(k)
      ? { size: this.objects.get(k).length, ...this.metadata.get(k) }
      : null;
  }
  async delete(k) {
    this.objects.delete(k);
    this.metadata.delete(k);
  }
  async list({ prefix, cursor, limit = 1000 }) {
    const keys = [...this.objects.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort(),
      start = cursor ? Number(cursor) : 0,
      selected = keys.slice(start, start + limit);
    return {
      objects: selected.map((key) => ({
        key,
        size: this.objects.get(key).length,
        ...this.metadata.get(key),
      })),
      truncated: start + limit < keys.length,
      cursor: String(start + limit),
    };
  }
  async createMultipartUpload(key) {
    const id = randomUUID();
    this.uploads.set(id, { key, parts: new Map() });
    return this.resumeMultipartUpload(key, id);
  }
  resumeMultipartUpload(key, uploadId) {
    const state = this.uploads.get(uploadId);
    if (!state || state.key !== key) throw Error("unknown multipart upload");
    return {
      uploadId,
      uploadPart: async (partNumber, body) => {
        const bytes = Buffer.from(await new Response(body).arrayBuffer());
        const etag = createHash("md5").update(bytes).digest("hex");
        state.parts.set(partNumber, { bytes, etag });
        return { partNumber, etag };
      },
      complete: async (parts) => {
        const bytes = parts.map((p) => {
          const actual = state.parts.get(p.partNumber);
          if (actual?.etag !== p.etag) throw Error("multipart part missing");
          return actual.bytes;
        });
        await this.put(key, Buffer.concat(bytes));
        this.uploads.delete(uploadId);
      },
      abort: async () => {
        this.uploads.delete(uploadId);
      },
    };
  }
  async get(k, options = {}) {
    if (!this.objects.has(k)) return null;
    const full = this.objects.get(k);
    const b = options.range
      ? full.subarray(
          options.range.offset,
          options.range.offset + options.range.length,
        )
      : full;
    return {
      size: full.length,
      body: new Response(b).body,
      arrayBuffer: async () =>
        b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
    };
  }
}
