import { z } from "zod";
import { isIP } from "node:net";
export const scriptNetworkURL = z
  .string()
  .max(2048)
  .refine((raw) => {
    try {
      const u = new URL(raw);
      return (
        u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        !u.hash &&
        !raw.includes("#") &&
        !u.port &&
        !isIP(u.hostname) &&
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
          u.hostname,
        )
      );
    } catch {
      return false;
    }
  }, "网络请求须为无凭据、无片段、标准端口的 HTTPS 域名地址")
  .transform((v) => new URL(v).href);
export const scriptNetworkRequestsSchema = z
  .array(
    z
      .object({
        id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
        url: scriptNetworkURL,
      })
      .strict(),
  )
  .min(1)
  .max(4)
  .refine(
    (v) => new Set(v.map((r) => r.id)).size === v.length,
    "网络请求 ID 重复",
  );
export function validateScriptNetworkResult(raw: unknown) {
  const value = z
    .object({
      url: scriptNetworkURL,
      mime: z.enum(["text/plain", "application/json"]),
      text: z.string().max(16384),
    })
    .strict()
    .parse(raw);
  if (
    Buffer.byteLength(value.text) > 16 * 1024 ||
    Buffer.byteLength(JSON.stringify(value)) > 32 * 1024
  )
    throw Error("网络响应超过预算");
  return value;
}
