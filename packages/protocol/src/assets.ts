/** Immutable resource identity shared by storage, backup manifests, and restore. */
export interface AssetDescriptor {
  path: string;
  sha256: string;
  size: number;
  mimeType?: string;
}

export function assetPath(hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw Error("资源哈希无效");
  return `assets/sha256/${hash.slice(0, 2)}/${hash}.bin`;
}

export function assertAssets(assets: readonly AssetDescriptor[]) {
  const hashes = new Set<string>();
  let bytes = 0;
  if (!Array.isArray(assets) || assets.length > 100000)
    throw Error("资源清单超限");
  for (const asset of assets) {
    if (
      asset.path !== assetPath(asset.sha256) ||
      hashes.has(asset.sha256) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 0
    )
      throw Error("资源清单包含重复或无效描述");
    hashes.add(asset.sha256);
    bytes += asset.size;
  }
  if (!Number.isSafeInteger(bytes) || bytes > 20 * 1024 ** 3)
    throw Error("资源总大小超限");
  return bytes;
}
