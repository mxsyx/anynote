import { describe, it, expect } from "vitest";
import { rendererReport } from "../scripts/build/renderer-report.mjs";

const chunk = (
  fileName,
  imports = [],
  dynamicImports = [],
  isEntry = false,
) => ({
  type: "chunk",
  fileName,
  imports,
  dynamicImports,
  isEntry,
  code: "/* " + fileName + " */",
  modules: {},
});
describe("renderer startup graph", () => {
  it("counts shared static dependencies once, handles cycles, and excludes lazy closures", () => {
    const bundle = {
      "entry.js": chunk(
        "entry.js",
        ["shared.js", "other.js"],
        ["editor.js"],
        true,
      ),
      "other.js": chunk("other.js", ["shared.js"]),
      "shared.js": chunk("shared.js", ["entry.js"]),
      "editor.js": chunk("editor.js", ["vendor.js"]),
      "vendor.js": chunk("vendor.js"),
      "style.css": { type: "asset", fileName: "style.css", source: "body {}" },
    };
    const report = rendererReport(bundle);
    expect(
      report.files
        .filter((file) => file.initial)
        .map((file) => file.file)
        .sort(),
    ).toEqual(["entry.js", "other.js", "shared.js"]);
    expect(report.initialBytes).toBe(
      ["entry.js", "shared.js", "other.js"].reduce(
        (sum, file) => sum + Buffer.byteLength(bundle[file].code),
        0,
      ),
    );
    expect(report.totalBytes).toBeGreaterThan(report.initialBytes);
    expect(report.files).toHaveLength(5);
  });
});
