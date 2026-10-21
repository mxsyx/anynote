import { join } from "node:path";
import { createHash } from "node:crypto";
import { TransferSession } from "../../.build/packages/backup/transfer-session.js";
import { cachedDownload } from "../../.build/packages/backup/transfer-download.js";

const [root, rawTarget] = process.argv.slice(2);
const session = new TransferSession(root, JSON.parse(rawTarget), "download");
const bytes = Buffer.alloc(32 * 1024 ** 2, 7);
await cachedDownload(
  session,
  {
    async downloadObject(_path, { range }) {
      if (range.offset) process.kill(process.pid, "SIGKILL");
      return bytes.subarray(range.offset, range.offset + range.size);
    },
  },
  "/asset",
  join(root, "result"),
  {
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  },
  new AbortController().signal,
  () => {},
);
