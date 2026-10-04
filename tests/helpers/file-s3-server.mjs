import { createServer } from "node:http";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
export async function fileS3Server(root) {
  await mkdir(root, { recursive: true });
  const files = new Map(),
    puts = [],
    gets = [];
  let pause;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const key = decodeURIComponent(url.pathname).replace(/^\/bucket\//, "");
      if (req.method === "GET" && url.searchParams.has("list-type")) {
        const prefix = url.searchParams.get("prefix") || "";
        const entries = [...files].filter(([key]) => key.startsWith(prefix));
        res.setHeader("content-type", "application/xml");
        res.end(
          `<ListBucketResult><IsTruncated>false</IsTruncated>${entries.map(([key, info]) => `<Contents><Key>${key}</Key><LastModified>${info.date}</LastModified><Size>${info.size}</Size></Contents>`).join("")}</ListBucketResult>`,
        );
        return;
      }
      if (req.method === "PUT") {
        const file = join(root, createHash("sha256").update(key).digest("hex"));
        await pipeline(req, createWriteStream(file));
        const size = statSync(file).size;
        files.set(key, { file, size, date: new Date().toISOString() });
        puts.push({ key, size });
        if (pause) await pause(key);
        res.setHeader("etag", '"fixture"');
        res.end();
        return;
      }
      const item = files.get(key);
      if (!item) {
        res.writeHead(404, { "content-type": "application/xml" });
        res.end("<Error><Code>NoSuchKey</Code></Error>");
        return;
      }
      if (req.method === "HEAD") {
        res.setHeader("content-length", item.size);
        res.end();
        return;
      }
      if (req.method === "GET") {
        gets.push(key);
        res.setHeader("content-length", item.size);
        await pipeline(createReadStream(item.file), res);
        return;
      }
      if (req.method === "DELETE") {
        files.delete(key);
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(400);
      res.end();
    } catch (e) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(e.message));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    files,
    puts,
    gets,
    pause(fn) {
      pause = fn;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
