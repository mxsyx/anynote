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
  async get(k) {
    if (!this.objects.has(k)) return null;
    const b = this.objects.get(k);
    return {
      size: b.length,
      body: b,
      arrayBuffer: async () =>
        b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
    };
  }
}
