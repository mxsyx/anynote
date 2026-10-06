import { z } from "zod";
import {
  createHash,
  createPublicKey,
  sign,
  verify,
  type KeyLike,
} from "node:crypto";

/** Structure of a signed extension package (Ed25519). */
export const signedPackageSchema = z
  .object({
    format: z.literal("anynote.extension.v1"),
    algorithm: z.literal("Ed25519"),
    publisher: z.string().min(1).max(120),
    publicKey: z.string().max(1024),
    manifest: z.unknown(),
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();

// Restricted JSON format: object keys are sorted by UTF-16 code units, array order is preserved.
/**
 * Generate a canonical JSON string used for signing.
 *
 * @param value Value to canonicalize.
 * @returns The canonical JSON string.
 */
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value))
    return "[" + value.map(canonicalJSON).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            canonicalJSON((value as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return JSON.stringify(value);
  throw Error("签名包包含无效 JSON 值");
}

/**
 * Build the payload to sign/verify (fixed prefix plus canonical JSON).
 *
 * @param p Signed package without the signature.
 * @returns The payload bytes.
 */
function payload(p: Omit<z.infer<typeof signedPackageSchema>, "signature">) {
  return Buffer.from("Anynote extension signature v1\n" + canonicalJSON(p));
}

/**
 * Validate the signed package structure, publisher public key, and Ed25519 signature, returning the package and public key fingerprint.
 *
 * @param raw Raw signed package.
 * @returns The verified package and public key fingerprint.
 */
export function verifyExtensionPackage(raw: unknown) {
  if (Buffer.byteLength(JSON.stringify(raw)) > 160 * 1024)
    throw Error("签名包超过 160KiB");
  const p = signedPackageSchema.parse(raw);
  const key = createPublicKey(p.publicKey);
  if (key.asymmetricKeyType !== "ed25519")
    throw Error("仅支持 Ed25519 发布者公钥");
  const pem = key.export({ format: "pem", type: "spki" }).toString();
  if (pem !== p.publicKey) throw Error("发布者公钥编码无效");
  const { signature, ...unsigned } = p;
  if (!verify(null, payload(unsigned), key, Buffer.from(signature, "base64")))
    throw Error("扩展签名验证失败");
  const fingerprint = createHash("sha256")
    .update(key.export({ format: "der", type: "spki" }))
    .digest("hex");
  return { package: p, fingerprint };
}

/**
 * Sign an extension package with the publisher private key and self-verify immediately.
 *
 * @param manifest Extension manifest.
 * @param publisher Publisher ID.
 * @param privateKey Publisher private key.
 * @returns The signed package.
 */
export function signExtensionPackage(
  manifest: unknown,
  publisher: string,
  privateKey: KeyLike,
) {
  const key = createPublicKey(privateKey);
  if (key.asymmetricKeyType !== "ed25519") throw Error("仅支持 Ed25519 私钥");
  const unsigned = {
    format: "anynote.extension.v1" as const,
    algorithm: "Ed25519" as const,
    publisher,
    publicKey: key.export({ format: "pem", type: "spki" }).toString(),
    manifest,
  };
  const p = {
    ...unsigned,
    signature: sign(null, payload(unsigned), privateKey).toString("base64"),
  };
  verifyExtensionPackage(p);
  return p;
}

/** Extension URL: an HTTPS URL without credentials or fragments. */
export const extensionURLSchema = z
  .string()
  .max(2048)
  .refine((raw) => {
    try {
      const u = new URL(raw);
      return u.protocol === "https:" && !u.username && !u.password && !u.hash;
    } catch {
      return false;
    }
  }, "扩展地址必须是无凭据、无片段的 HTTPS URL");
