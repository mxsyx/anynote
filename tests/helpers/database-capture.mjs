import { createHash } from "node:crypto";

/** Expose byte sources with the same bounded chunk layout as the core capture API. */
export function databaseCapture(bytes) {
  const buffer = Buffer.from(bytes);
  const source = (data) => ({
    sha256: createHash("sha256").update(data).digest("hex"),
    size: data.length,
    read: async (offset, length) => data.subarray(offset, offset + length),
    stream: async function* () {
      yield data;
    },
  });
  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += 1024 ** 2)
    chunks.push(source(buffer.subarray(offset, offset + 1024 ** 2)));
  return { ...source(buffer), chunks };
}
