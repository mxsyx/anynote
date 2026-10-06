import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

/**
 * Whether an IP literal is a public address (for SSRF protection).
 *
 * Rejects loopback, private, link-local, reserved, multicast, and similar
 * addresses; for IPv6 only globally routable prefixes are accepted.
 *
 * @param raw IP literal.
 * @returns True when the address is public.
 */
export function isPublicAddress(raw: string) {
  const address = raw.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(address) === 4) {
    const p = address.split(".").map(Number);
    return !(
      p[0] === 0 ||
      p[0] === 10 ||
      p[0] === 127 ||
      p[0] >= 224 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && [0, 168].includes(p[1])) ||
      (p[0] === 198 && [18, 19, 51].includes(p[1])) ||
      (p[0] === 203 && p[1] === 0 && p[2] === 113) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
    );
  }
  if (isIP(address) === 6)
    return (
      /^2[0-9a-f]{3}:/.test(address) &&
      !/^2001:(?:0:|db8:)/.test(address) &&
      !address.startsWith("2002:")
    );
  return false;
}

/**
 * Parse a URL and ensure it resolves to a public address.
 *
 * Only credential-free HTTP(S) URLs are allowed, and every resolved address
 * must be public.
 *
 * @param raw URL to resolve.
 * @returns The parsed URL object and the first DNS record.
 */
export async function resolvePublic(raw: string) {
  const u = new URL(raw);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw Error("仅允许无凭据的 HTTP(S) 地址");
  const hostname = u.hostname.replace(/^\[|\]$/g, "");
  const records = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true });
  if (!records.length || records.some((r) => !isPublicAddress(r.address)))
    throw Error("为保护本机数据，不允许访问私网、回环、链路本地或保留地址");
  return { url: u, record: records[0] };
}

/**
 * Download an HTTP(S) resource with SSRF, redirect, size, and timeout protection.
 *
 * It validates the actual socket remote address before connecting, follows
 * redirects automatically (up to 5 by default), and caps size via both
 * Content-Length and streamed accumulation.
 *
 * @param raw Target URL.
 * @param options Abort signal, size limit, redirect count, allowed protocols, and connection isolation.
 * @returns Response bytes and content-type info.
 */
export async function safeDownload(
  raw: string,
  {
    signal,
    maxBytes = 10 * 1024 * 1024,
    redirects = 5,
    protocols = ["http:", "https:"],
    isolatedConnection = false,
  }: {
    signal?: AbortSignal;
    maxBytes?: number;
    redirects?: number;
    protocols?: readonly string[];
    isolatedConnection?: boolean;
  } = {},
) {
  signal?.throwIfAborted();
  if (!protocols.includes(new URL(raw).protocol))
    throw Error("下载地址协议不允许");
  const { url, record } = await resolvePublic(raw);
  signal?.throwIfAborted();

  return new Promise<{
    data: Buffer;
    mime: string;
    contentType: string;
    url: string;
  }>((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.get(
      url,
      {
        signal,
        ...(isolatedConnection
          ? { agent: false as const, rejectUnauthorized: true }
          : {}),
        timeout: 30000,
        lookup: (host, opts, cb) => {
          if (opts.all) cb(null, [record]);
          else cb(null, record.address, record.family);
        },
        headers: {
          "User-Agent": "Anynote/0.2 (+local-first personal archive)",
          Accept: "*/*",
        },
      },
      async (res) => {
        try {
          if (
            res.statusCode! >= 300 &&
            res.statusCode! < 400 &&
            res.headers.location
          ) {
            res.resume();
            if (redirects <= 0) throw Error("重定向次数超限");
            resolve(
              await safeDownload(new URL(res.headers.location, url).href, {
                signal,
                maxBytes,
                redirects: redirects - 1,
                protocols,
                isolatedConnection,
              }),
            );
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            throw Error("下载失败：HTTP " + res.statusCode);
          }
          if (Number(res.headers["content-length"]) > maxBytes) {
            res.destroy();
            throw Error("资源超过下载上限");
          }
          const chunks = [];
          let size = 0;
          for await (const c of res) {
            signal?.throwIfAborted();
            size += c.length;
            if (size > maxBytes) {
              res.destroy();
              throw Error("资源超过下载上限");
            }
            chunks.push(c);
          }
          resolve({
            data: Buffer.concat(chunks),
            contentType: String(res.headers["content-type"] || ""),
            mime: String(res.headers["content-type"] || "")
              .split(";")[0]
              .toLowerCase(),
            url: url.href,
          });
        } catch (e: any) {
          reject(e);
        }
      },
    );
    req.on("socket", (socket) =>
      socket.once("connect", () => {
        if (!isPublicAddress(socket.remoteAddress || ""))
          req.destroy(Error("连接地址校验失败"));
      }),
    );
    req.on("timeout", () => req.destroy(Error("下载超时")));
    req.on("error", reject);
  });
}
