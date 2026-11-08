import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { installableManifestSchema } from "../.build/packages/extension-tools/manifest.js";
function emit(path, value) {
  if (process.argv.includes("--check")) {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    if (JSON.stringify(saved) !== JSON.stringify(value))
      throw Error(`fixture mismatch: ${path}`);
  } else writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
const directory = "tests/fixtures/rust-migration/config";
mkdirSync(directory, { recursive: true });
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const known = [
  "reading-preferences",
  "reading-preferences-v2",
  "reading-session",
  "reading-session-v2",
].map((name) => {
  const manifest = installableManifestSchema.parse(
    JSON.parse(
      readFileSync(`packages/plugin-sdk/src/examples/${name}.json`, "utf8"),
    ),
  );
  return {
    manifest,
    checksum: hash(manifest),
    settingsChecksum: manifest.contributes.settings
      ? hash(manifest.contributes.settings)
      : null,
  };
});
emit(`${directory}/known-state-mappings.json`, known);

const { pbkdf2Sync, createCipheriv } = await import("node:crypto");
const plaintext = Buffer.from('{"token":"rm13-public-synthetic-vector"}');
const vectors = ["linux", "macos"].map((platform) => {
  const password = "rm13-public-synthetic-password";
  const key = pbkdf2Sync(
    password,
    "saltysalt",
    platform === "macos" ? 1003 : 1,
    16,
    "sha1",
  );
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return {
    platform,
    password,
    ciphertext: Buffer.concat([
      Buffer.from(platform === "macos" ? "v10" : "v11"),
      cipher.update(plaintext),
      cipher.final(),
    ]).toString("hex"),
    sha256: createHash("sha256").update(plaintext).digest("hex"),
  };
});
const key = Buffer.alloc(32, 0x42),
  nonce = Buffer.alloc(12, 0x24),
  cipher = createCipheriv("aes-256-gcm", key, nonce);
const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
vectors.push({
  platform: "windows",
  key: key.toString("hex"),
  ciphertext: Buffer.concat([
    Buffer.from("v10"),
    nonce,
    body,
    cipher.getAuthTag(),
  ]).toString("hex"),
  sha256: createHash("sha256").update(plaintext).digest("hex"),
});
emit(`${directory}/crypto-vectors.json`, vectors);
