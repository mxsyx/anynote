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
