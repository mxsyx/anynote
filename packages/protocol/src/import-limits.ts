/**
 * Size/count budgets and preview limits shared by the web importer and the
 * pre-submit preview, so the reported budget is the one actually enforced.
 */
export const importLimits = {
  /** Maximum accepted HTML size. */
  htmlBytes: 10 * 1024 * 1024,
  /** Maximum number of images localized in one import. */
  mediaCount: 200,
  /** Maximum size of a single localized media resource. */
  mediaBytes: 20 * 1024 * 1024,
  /** Maximum total size of localized media. */
  totalBytes: 80 * 1024 * 1024,
  /** Maximum characters of converted Markdown returned for the pre-submit preview. */
  previewChars: 20000,
};

/** Defaults also serve as hard ceilings: task overrides may only tighten them. */
export const importBudget = {
  concurrency: 4,
  responseBytes: importLimits.mediaBytes,
  responseMs: 30_000,
  htmlBytes: importLimits.htmlBytes,
  mediaBytes: importLimits.mediaBytes,
  totalBytes: importLimits.totalBytes,
  mediaCount: importLimits.mediaCount,
  decodeBytes: 40_000_000 * 4,
};

export type ImportBudget = typeof importBudget;

export function resolveImportBudget(
  input: Partial<ImportBudget> = {},
): ImportBudget {
  const resolved = { ...importBudget };
  for (const [key, value] of Object.entries(input)) {
    if (
      !Object.hasOwn(importBudget, key) ||
      !Number.isSafeInteger(value) ||
      value! < 1 ||
      value! > importBudget[key as keyof ImportBudget]
    )
      throw Error(`导入预算无效：${key}`);
    resolved[key as keyof ImportBudget] = value!;
  }
  return resolved;
}

/** Entry-specific hard ceilings. Streaming archive capacity does not raise IPC budgets. */
export const entryLimits = {
  singleFileBytes: 50 * 1024 ** 2,
  legacyArchiveBytes: 100 * 1024 ** 2,
  transferRecordBytes: 100 * 1024 ** 2,
  transferAssetBytes: 100 * 1024 ** 2,
  transferNodes: 10000,
  streamingBytes: 20 * 1024 ** 3,
};

export const entryBudgetHint = `普通单文件导入 ${entryLimits.singleFileBytes / 1024 ** 2} MiB；浏览器归档、旧 API、本地快照及浏览器 Markdown 导出 ${entryLimits.legacyArchiveBytes / 1024 ** 2} MiB；跨库转移最多 ${entryLimits.transferNodes} 个条目，记录与附件各 ${entryLimits.transferAssetBytes / 1024 ** 2} MiB。桌面流式归档与 Markdown 导出最多 ${entryLimits.streamingBytes / 1024 ** 3} GiB，不代表所有入口支持此大小。网页导入：HTML ${importLimits.htmlBytes / 1024 ** 2} MiB、单资源/响应 ${importBudget.mediaBytes / 1024 ** 2} MiB、总量 ${importBudget.totalBytes / 1024 ** 2} MiB（含原始 HTML）、${importBudget.mediaCount} 项、${importBudget.concurrency} 路并发、每响应 ${importBudget.responseMs / 1000} 秒、单图解码 ${importBudget.decodeBytes / 4 / 1000000} MP。`;
