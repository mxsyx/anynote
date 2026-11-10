import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  handleRequest as legacyHandler,
  marker,
} from "../plugin-network/service.mjs";

export const version = "anynote-public-network-v2";
export { marker };
export function handleRequest(req, res) {
  const url = new URL(req.url, "https://service.invalid");
  const path = url.pathname.split("/").at(-1);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  if (req.method !== "GET") {
    res.writeHead(405).end();
    return;
  }
  // Never echo supplied credentials into an acceptance report.
  if (
    ["cookie", "authorization", "proxy-authorization", "referer"].some(
      (k) => req.headers[k],
    )
  ) {
    res.writeHead(400).end("unexpected credentials or referer");
    return;
  }
  const size = Number(url.searchParams.get("size") || 16384);
  if (!Number.isInteger(size) || size < 1 || size > 1048577) {
    res.writeHead(400).end();
    return;
  }
  const target = (name) => {
    const next = new URL(name, url);
    next.search = url.search;
    return next.pathname + next.search;
  };
  switch (path) {
    case "inspect":
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          marker,
          version,
          serviceId: process.env.ANYNOTE_NETWORK_SERVICE_ID,
          credentialsAbsent: true,
        }),
      );
      return;
    case "page":
      res.setHeader("Content-Type", "text/html");
      res.end(
        `<html><head><title>${marker}</title></head><body><article><h1>${marker}</h1><p>${"Controlled public network acceptance content. ".repeat(20)}</p></article></body></html>`,
      );
      return;
    case "redirect-page":
      res.writeHead(302, { Location: target("page") }).end();
      return;
    case "redirect-cookie":
      res
        .writeHead(302, {
          Location: target("inspect"),
          "Set-Cookie": "acceptance.secret=must-not-return; Secure; Path=/",
        })
        .end();
      return;
    case "redirect-private":
      res.writeHead(302, { Location: "https://127.0.0.1/private" }).end();
      return;
    case "redirect-credentials":
      res
        .writeHead(302, { Location: "https://user:secret@127.0.0.1/private" })
        .end();
      return;
    case "redirect-loop":
      res.writeHead(302, { Location: target("redirect-loop") }).end();
      return;
    case "sized":
      res.end("x".repeat(size));
      return;
    case "stream-sized":
      res.writeHead(200);
      res.write("x".repeat(Math.min(8192, size)));
      res.end("x".repeat(Math.max(0, size - 8192)));
      return;
    case "slow-headers":
    case "slow-body": {
      if (path === "slow-body") res.flushHeaders();
      const timer = setTimeout(() => res.end(marker), 12000);
      res.once("close", () => clearTimeout(timer));
      return;
    }
    default:
      legacyHandler(req, res);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (!process.env.ANYNOTE_NETWORK_SERVICE_ID)
    throw new Error("ANYNOTE_NETWORK_SERVICE_ID required");
  const server = createServer(
    {
      cert: readFileSync(process.env.ANYNOTE_NETWORK_TLS_CERT),
      key: readFileSync(process.env.ANYNOTE_NETWORK_TLS_KEY),
    },
    handleRequest,
  );
  server.maxConnections = 32;
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  server.listen(Number(process.env.PORT || 443), process.env.HOST || "0.0.0.0");
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      server.close();
      server.closeAllConnections();
    });
}
