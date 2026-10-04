import { extensionDirectorySchema } from "../.build/packages/protocol/extension-directory.js";
import { generateKeyPairSync, createPrivateKey, createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  signExtensionPackage,
  verifyExtensionPackage,
} from "../.build/packages/storage-sqlite/extension-signature.js";
import { installableManifestSchema } from "../.build/packages/storage-sqlite/extension-catalog.js";
const [command, ...args] = process.argv.slice(2);
try {
  if (command === "keygen" && args.length === 1) {
    const pair = generateKeyPairSync("ed25519");
    writeFileSync(
      args[0],
      pair.privateKey.export({ format: "pem", type: "pkcs8" }),
      { mode: 0o600, flag: "wx" },
    );
    console.log("已创建本地私钥；请妥善保存，勿随扩展分发。");
  } else if (command === "sign" && args.length === 4) {
    const [manifestPath, keyPath, publisher, output] = args;
    const bytes = readFileSync(manifestPath);
    if (bytes.length > 128 * 1024) throw Error("扩展定义超过 128KiB");
    const manifest = installableManifestSchema.parse(JSON.parse(bytes));
    const p = signExtensionPackage(
      manifest,
      publisher,
      createPrivateKey(readFileSync(keyPath)),
    );
    writeFileSync(output, JSON.stringify(p, null, 2) + "\n", { flag: "wx" });
    console.log(
      "已生成签名包，公钥指纹：" + verifyExtensionPackage(p).fingerprint,
    );
  } else if (command === "verify" && args.length === 1) {
    const bytes = readFileSync(args[0]);
    if (bytes.length > 160 * 1024) throw Error("签名包超过 160KiB");
    const verified = verifyExtensionPackage(JSON.parse(bytes));
    installableManifestSchema.parse(verified.package.manifest);
    console.log("签名有效，公钥指纹：" + verified.fingerprint);
  } else if (
    command === "directory" &&
    args.length >= 4 &&
    args.length % 2 === 0
  ) {
    const [name, output, ...pairs] = args;
    const entries = [];
    for (let i = 0; i < pairs.length; i += 2) {
      const bytes = readFileSync(pairs[i]);
      if (bytes.length > 160 * 1024) throw Error("签名包超过 160KiB");
      const verified = verifyExtensionPackage(JSON.parse(bytes));
      const manifest = installableManifestSchema.parse(
        verified.package.manifest,
      );
      entries.push({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        runtime: manifest.runtime,
        description: manifest.description,
        permissions: manifest.permissions,
        url: pairs[i + 1],
        checksum: createHash("sha256")
          .update(JSON.stringify(manifest))
          .digest("hex"),
        fingerprint: verified.fingerprint,
      });
    }
    const directory = extensionDirectorySchema.parse({
      format: "anynote.extension-directory.v1",
      name,
      entries,
    });
    const json = JSON.stringify(directory, null, 2) + "\n";
    if (Buffer.byteLength(json) > 256 * 1024) throw Error("目录超过 256KiB");
    writeFileSync(output, json, { flag: "wx" });
    console.log(
      "已生成扩展目录，共 " + entries.length + " 项；尚未发布到网络。",
    );
  } else
    throw Error(
      "用法：keygen <私钥文件> | sign <manifest.json> <私钥文件> <发布者名称> <输出.json> | verify <签名包.json> | directory <目录名称> <输出.json> <签名包.json> <HTTPS 包地址> [...更多包与地址]",
    );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
