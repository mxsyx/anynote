import { open } from "node:fs/promises";
/** Read-only byte source; supports offset reads to reuse resumable transfers. */
export interface ScopedReadSource {
  size: number;
  /** Read by offset/length; the returned byte count may be smaller than the requested length. */
  read(offset: number, length: number): Promise<Uint8Array>;
  /** Full sequential stream (for upload), cancellable via `signal`. */
  stream(signal?: AbortSignal): AsyncIterable<Uint8Array>;
}

/** Read chunk size for the sequential stream; unrelated to the protocol chunk budget, affecting only memory use. */
const streamChunkBytes = 1024 * 1024;

/**
 * Build a read-only byte source that reads by offset.
 *
 * @param file Absolute path of the source file (held only by the core, never given to extensions).
 * @param size File size.
 * @returns The read-only source.
 */
export function fileSource(
  file: string,
  size: number,
  base = 0,
): ScopedReadSource {
  return {
    size,
    async read(offset: number, length: number) {
      if (offset < 0 || length <= 0 || offset >= size) return new Uint8Array();
      const handle = await open(file, "r");
      try {
        const want = Math.min(length, size - offset),
          buffer = Buffer.alloc(want);
        let position = 0;
        while (position < want) {
          const { bytesRead } = await handle.read(
            buffer,
            position,
            want - position,
            base + offset + position,
          );
          if (!bytesRead) break;
          position += bytesRead;
        }
        return buffer.subarray(0, position);
      } finally {
        await handle.close();
      }
    },
    async *stream(signal?: AbortSignal) {
      const handle = await open(file, "r");
      try {
        let offset = 0;
        while (offset < size) {
          signal?.throwIfAborted();
          const buffer = Buffer.alloc(
              Math.min(streamChunkBytes, size - offset),
            ),
            { bytesRead } = await handle.read(
              buffer,
              0,
              buffer.length,
              base + offset,
            );
          if (!bytesRead) break;
          offset += bytesRead;
          yield buffer.subarray(0, bytesRead);
        }
      } finally {
        await handle.close();
      }
    },
  };
}
