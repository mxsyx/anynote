import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** PKCE 授权码流程需要的 verifier/challenge 对（设计 §6.1）。 */
export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** Base64URL 编码，去掉 padding，符合 RFC 7636 与厂商要求。 */
export const base64url = (bytes: Buffer): string => bytes.toString("base64url");

/**
 * 生成 PKCE verifier 及其 S256 challenge。
 *
 * verifier 使用 64 字节随机量并按 base64url 编码，落在 RFC 7636 允许的
 * 43–128 字符区间内且无需要转义的字符。
 *
 * @returns verifier/challenge 对。
 */
export function createPkce(): PkcePair {
  const verifier = base64url(randomBytes(64));
  return { verifier, challenge: createCodeChallenge(verifier), method: "S256" };
}

/**
 * 由 verifier 计算 S256 challenge。
 *
 * @param verifier PKCE code verifier。
 * @returns base64url 编码的 SHA-256 challenge。
 */
export const createCodeChallenge = (verifier: string): string =>
  base64url(createHash("sha256").update(verifier).digest());

/** 生成不可预测的 OAuth state，用于抵御回调截获与 CSRF。 */
export const randomState = (): string => base64url(randomBytes(32));

/**
 * 常量时间比较两个字符串，避免用逐字符比较泄漏 state 信息。
 *
 * @param a 期望值。
 * @param b 实际值。
 * @returns 两者是否完全相等。
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8"),
    right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
