import TurndownService from "turndown";

/** Shared DOM conversion rules; no Node or fetching dependencies. */
export function markdownConverter(source: string) {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  // Convert HTML tables into GFM tables.
  td.addRule("table", {
    filter: "table",
    replacement: (_, node) => {
      const rows = Array.from(node.querySelectorAll("tr"))
        .filter((r) => {
          let parent = r.parentNode;
          while (parent && parent.nodeName !== "TABLE")
            parent = parent.parentNode;
          return parent === node;
        })
        .map((r) =>
          Array.from(r.children)
            .filter((c) => ["TH", "TD"].includes(c.tagName))
            .map((c) =>
              td
                .turndown(c.innerHTML)
                .replace(/\|/g, "\\|")
                .replace(/\s+/g, " ")
                .trim(),
            ),
        );
      if (!rows.length) return "";
      const width = Math.max(...rows.map((r) => r.length));
      return (
        "\n\n" +
        rows
          .map(
            (r, i) =>
              "| " +
              Array.from({ length: width }, (_, j) => r[j] || "").join(" | ") +
              " |" +
              (i === 0
                ? "\n| " + Array(width).fill("---").join(" | ") + " |"
                : ""),
          )
          .join("\n") +
        "\n\n"
      );
    },
  });

  // Keep http/https/mailto links and already-localized resources; degrade the
  // rest to plain text.
  td.addRule("safe-links", {
    filter: "a",
    replacement: (text, node) => {
      const href = node.getAttribute("href") || "";
      if (
        href.startsWith("anynote-resource:") ||
        href.startsWith("anynote-capture:")
      )
        return `[${text}](${href})`;
      try {
        const url = new URL(href, source);
        if (!["http:", "https:", "mailto:"].includes(url.protocol)) return text;
        return `[${text}](${url.href})`;
      } catch {
        return text;
      }
    },
  });

  return td;
}
