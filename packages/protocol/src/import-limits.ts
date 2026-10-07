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
