import { assertDatabaseChunks } from "@anynote/protocol/cloud-objects.js";

/** Transform each distinct immutable chunk once, retaining the original order and repeated references. */
export async function mapDatabaseChunks<
  T extends { sha256: string; size: number },
  R extends { sha256: string; size: number },
>(
  database: { sha256: string; size: number; chunks: readonly T[] },
  transform: (chunk: T) => Promise<R>,
) {
  assertDatabaseChunks(database);
  const mapped = new Map<string, R>();
  const chunks: R[] = [];
  for (const chunk of database.chunks) {
    let value = mapped.get(chunk.sha256);
    if (!value) {
      value = await transform(chunk);
      if (value.sha256 !== chunk.sha256 || value.size !== chunk.size)
        throw Error("数据库分块身份或大小不匹配");
      mapped.set(chunk.sha256, value);
    }
    chunks.push(value);
  }
  return { sha256: database.sha256, size: database.size, chunks };
}
