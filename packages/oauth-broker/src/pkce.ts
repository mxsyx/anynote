import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** The verifier/challenge pair needed by the PKCE authorization code flow (design §6.1). */
export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** Base64URL encoding without padding, per RFC 7636 and vendor requirements. */
export const base64url = (bytes: Buffer): string => bytes.toString("base64url");

/**
 * Generate a PKCE verifier and its S256 challenge.
 *
 * The verifier uses 64 random bytes encoded as base64url, falling within the length range
 * of 43-128 characters allowed by RFC 7636, with no characters needing escaping.
 *
 * @returns The verifier/challenge pair.
 */
export function createPkce(): PkcePair {
  const verifier = base64url(randomBytes(64));
  return { verifier, challenge: createCodeChallenge(verifier), method: "S256" };
}

/**
 * Compute the S256 challenge from the verifier.
 *
 * @param verifier PKCE code verifier。
 * @returns The base64url-encoded SHA-256 challenge.
 */
export const createCodeChallenge = (verifier: string): string =>
  base64url(createHash("sha256").update(verifier).digest());

/** Generate an unpredictable OAuth state to defend against callback interception and CSRF. */
export const randomState = (): string => base64url(randomBytes(32));

/**
 * Compare two strings in constant time, avoiding leaking state info via character-by-character comparison.
 *
 * @param a Expected value.
 * @param b Actual value.
 * @returns Whether the two are exactly equal.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8"),
    right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
