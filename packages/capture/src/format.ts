import { localizeBody } from "./markdown.js";
import { z } from "zod";
import { importLimits } from "@anynote/protocol/import-limits.js";

export const captureLimits = {
  ...importLimits,
  bodyChars: 2_000_000,
  bodyBytes: 8 * 1024 ** 2,
  manifestBytes: 1024 ** 2,
  archiveBytes: 90 * 1024 ** 2,
  entries: 202,
} as const;

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const size = z.number().int().nonnegative().safe();
export const captureAssetSchema = z
  .object({
    path: z.string().regex(/^assets\/[a-f0-9]{64}\.[a-z0-9]{1,10}$/),
    sha256: hash,
    size: size.max(captureLimits.mediaBytes),
    mime: z.string().min(1).max(120),
    name: z.string().min(1).max(240),
  })
  .strict()
  .refine(
    (a) => a.path.startsWith(`assets/${a.sha256}.`),
    "资源路径与哈希不一致",
  );

/** URLs in exported metadata never carry credentials, queries or fragments. */
export function sourceUrl(value: string): string {
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error("来源地址无效");
  url.search = "";
  url.hash = "";
  return url.href;
}

export const captureManifestSchema = z
  .object({
    format: z.literal("anynote.capture"),
    version: z.literal(1),
    captureId: z.string().uuid(),
    title: z.string().min(1).max(240),
    source: z
      .object({
        kind: z.enum(["selection", "chatgpt"]),
        url: z
          .string()
          .max(4000)
          .refine((v) => {
            try {
              return sourceUrl(v) === v;
            } catch {
              return false;
            }
          }),
        capturedAt: z.string().datetime(),
        conversationId: z.string().max(200).optional(),
        messageIds: z.array(z.string().max(200)).max(10000).optional(),
        adapterVersion: z.string().max(40).optional(),
      })
      .strict(),
    body: z
      .object({
        path: z.literal("content.md"),
        sha256: hash,
        size: size.max(captureLimits.bodyBytes),
      })
      .strict(),
    assets: z.array(captureAssetSchema).max(captureLimits.mediaCount),
    missing: z
      .array(
        z
          .object({ name: z.string().max(240), reason: z.string().max(500) })
          .strict(),
      )
      .max(captureLimits.mediaCount),
    complete: z.boolean(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.complete !== (m.missing.length === 0))
      ctx.addIssue({ code: "custom", message: "完整性标志与缺失报告不一致" });
    if (
      m.assets.length + m.missing.length > captureLimits.mediaCount ||
      m.assets.reduce((n, a) => n + a.size, 0) > captureLimits.totalBytes
    )
      ctx.addIssue({ code: "custom", message: "采集媒体超过预算" });
    if (
      new Set(m.assets.map((a) => a.path)).size !== m.assets.length ||
      new Set(m.assets.map((a) => a.sha256)).size !== m.assets.length
    )
      ctx.addIssue({ code: "custom", message: "采集包有重复资源" });
  });

export type CaptureManifest = z.infer<typeof captureManifestSchema>;
export type CaptureAsset = z.infer<typeof captureAssetSchema>;
export interface Capture {
  manifest: CaptureManifest;
  body: string;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** WebCrypto buffers only one bounded object, never the entire media bundle. */
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export function manifestBytes(value: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(
    canonical(captureManifestSchema.parse(value)),
  );
  if (bytes.length > captureLimits.manifestBytes)
    throw Error("采集清单超过预算");
  return bytes;
}

export async function validateCapture(capture: Capture) {
  const manifest = captureManifestSchema.parse(capture.manifest);
  manifestBytes(manifest);
  const bytes = new TextEncoder().encode(capture.body);
  if (
    capture.body.length > captureLimits.bodyChars ||
    bytes.length !== manifest.body.size ||
    (await sha256(bytes)) !== manifest.body.sha256
  )
    throw Error("采集正文大小或哈希不匹配");
  localizeBody(
    capture.body,
    new Map(manifest.assets.map((a) => [a.path, a.path])),
  );
  return manifest;
}

export async function captureDigest(manifest: CaptureManifest) {
  return sha256(manifestBytes(manifest));
}
