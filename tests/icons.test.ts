import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { Check, LoaderCircle, Search } from "../apps/desktop/src/icons";

const requireDesktop = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const { createElement } = requireDesktop("react");
const { renderToStaticMarkup } = requireDesktop("react-dom/server");

describe("application icons", () => {
  it("inherits control color and keeps decorative icons out of the accessibility tree", () => {
    const markup = renderToStaticMarkup(createElement(Check, { size: 16 }));

    expect(markup).toContain('viewBox="0 0 48 48"');
    expect(markup).toContain('width="16"');
    expect(markup).toContain('height="16"');
    expect(markup).toContain('stroke="currentColor"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('focusable="false"');
  });

  it("allows accessible titles and explicit colors", () => {
    const markup = renderToStaticMarkup(
      createElement(Search, { title: "Search notes", color: "#ffffff" }),
    );

    expect(markup).toContain("<title>Search notes</title>");
    expect(markup).not.toContain('aria-hidden="true"');
    expect(markup).toContain('stroke="#ffffff"');
  });

  it("preserves loading animation and SVG attributes", () => {
    const markup = renderToStaticMarkup(
      createElement(LoaderCircle, {
        size: 14,
        className: "spin",
        "data-testid": "loading",
      }),
    );

    expect(markup).toContain('class="spin"');
    expect(markup).toContain('data-testid="loading"');
    expect(markup).toContain('width="14"');
  });
});
