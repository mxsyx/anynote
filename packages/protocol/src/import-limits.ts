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
