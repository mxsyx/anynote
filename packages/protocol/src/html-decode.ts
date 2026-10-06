/**
 * Decode HTML bytes using the charset declared by the response header or `<meta charset>`.
 *
 * It tries Content-Type, then the page's `<meta charset>`, and falls back to
 * UTF-8 when both are missing or invalid.
 *
 * @param bytes Raw HTML bytes.
 * @param contentType Content-Type from the response header (optional).
 * @returns The decoded HTML string.
 */
export function decodeHtml(bytes: Uint8Array, contentType = "") {
  const prefix = new TextDecoder("latin1").decode(bytes.slice(0, 4096));
  const charset =
    contentType.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] ||
    prefix.match(/<meta\b[^>]*charset\s*=\s*["']?([\w-]+)/i)?.[1] ||
    "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
