import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const marker = "anynote-public-network-v1";

// Deploy behind dedicated DNS names on port 443. This stateless service has no
// administrative endpoints, caller-selected delays, or unbounded response sizes.
export function handleRequest(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  if (req.method !== "GET") {
    res.writeHead(405).end();
    return;
  }
  const path = new URL(req.url, "https://service.invalid").pathname
    .split("/")
    .at(-1);
  switch (path) {
    case "text":
      res.end(marker);
      break;
    case "json":
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ marker }));
      break;
    case "boundary":
      res.end("x".repeat(16384));
      break;
    case "length-overflow":
      res.end("x".repeat(16385));
      break;
    case "stream-overflow":
      res.writeHead(200);
      res.write("x".repeat(8192));
      res.end("x".repeat(8193));
      break;
    case "redirect":
      res.writeHead(302, { Location: "text" }).end();
      break;
    case "slow": {
      const timer = setTimeout(() => res.end(marker), 5000);
      res.once("close", () => clearTimeout(timer));
      break;
    }
    default:
      res.writeHead(404).end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const server = createServer(
    {
      cert: readFileSync(process.env.ANYNOTE_NETWORK_TLS_CERT),
      key: readFileSync(process.env.ANYNOTE_NETWORK_TLS_KEY),
    },
    handleRequest,
  );
  server.maxConnections = 32;
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.listen(
    Number(process.env.PORT || 443),
    process.env.HOST || "0.0.0.0",
    () => {
      console.log(
        "Anynote public network acceptance service v1 listening on",
        server.address(),
      );
    },
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      server.close();
      server.closeAllConnections();
    });
}
