import { prepareImport } from "../.build/packages/importer/html.js";
import { canonical } from "../.build/packages/capture/format.js";
import { convertComponents } from "../.build/packages/capture/chatgpt-components.js";
import { flow } from "../tests/fixtures/chatgpt-components.mjs";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
const cases = [
  [
    "basic",
    "<title>标题</title><h1>Heading</h1><p>中文 😀 &amp; <strong>bold</strong> and <em>italic</em>.</p>",
  ],
  [
    "unsafe",
    '<p>Keep <script>alert(1)</script><a href="javascript:alert(1)">unsafe</a> <a href="/safe">safe</a></p><style>body{}</style><form>private<input value="secret"></form>',
  ],
  [
    "table",
    '<table><tr><th>A | B</th><th><strong>C</strong></th></tr><tr><td>x<br>y</td><td><a href="https://example.com/a">Link</a></td></tr><tr><td>short</td></tr></table>',
  ],
  [
    "nested-table",
    "<table><tr><td>outer</td><td><table><tr><td>inner</td></tr></table></td></tr></table>",
  ],
  [
    "lists",
    '<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul><ol start="3"><li>three</li><li>four</li></ol>',
  ],
  [
    "code",
    '<pre><code>if (a &lt; b) {\n  console.log("x");\n}\n</code></pre><p><code>a`b</code></p>',
  ],
  [
    "quote",
    "<blockquote><p>one</p><p>two<br>three</p></blockquote><hr><p>end</p>",
  ],
  [
    "links",
    '<p><a href="/foo?q=1">relative</a> <a href="mailto:hi@example.com">mail</a> <a href="file:///secret">file</a></p>',
  ],
  [
    "unknown",
    '<future-card data-x="1"><p>future text</p></future-card><p>trailing</p>',
  ],
  ["malformed", "<p>one<b>two</p>three<table><td>a<td>b"],
  ["whitespace", "<p>  a\n b <b> bold </b> end&nbsp;中文</p>"],
  [
    "article",
    "<html><head><title>Article</title></head><body><nav>Home Menu</nav><article><h1>Article</h1>" +
      "<p>这是一段足够长的正文，包含有意义的内容和标点，用来验证正文提取。Keep the article content, with several sentences.</p>".repeat(
        12,
      ) +
      "</article><footer>Foot navigation</footer></body></html>",
    "article",
  ],
  ["short-article", "<title>短文</title><p>short content</p>", "article"],
  ["inline-escape", "<p>*star* _under_ [link] \\ slash # hash</p>"],
];
cases.push(
  [
    "code-language",
    '<pre><code class="language-rust">fn main() {}</code></pre>',
  ],
  [
    "markdown-literals",
    "<p># literal</p><p>1. literal</p><p>+ literal</p><p>- literal</p><p>&gt; literal</p>",
  ],
  ["code-runs", "<p><code>a`b`c</code> and <code> x </code></p>"],
);
const results = [];
for (const [name, html, mode = "page"] of cases) {
  const r = await prepareImport({ html, mode });
  try {
    results.push({
      name,
      html,
      mode,
      title: r.title,
      body: r.body,
      fallback: r.report.fallback,
    });
  } finally {
    rmSync(r.stagingDirectory, { recursive: true, force: true });
  }
}
mkdirSync("tests/fixtures/import", { recursive: true });
writeFileSync(
  "tests/fixtures/import/rm07-html.json",
  JSON.stringify(results, null, 2) + "\n",
);
const values = [
  { z: 1, a: [null, true, "😀\n\u2028"], "\ue000": "bmp", "𐀀": "astral" },
  [0, -0, 1e-7, 1e-6, 1e20, 1e21, 9007199254740991],
  { quote: '"\\\b\f\r\t', absent: undefined, optional: null },
];
writeFileSync(
  "tests/fixtures/import/rm07-canonical.json",
  JSON.stringify(
    values.map((value) => ({ value, canonical: canonical(value) })),
    null,
    2,
  ) + "\n",
);
writeFileSync(
  "tests/fixtures/import/rm07-chatgpt.md",
  convertComponents(flow).body,
);
console.log(
  `Generated ${results.length} HTML and ${values.length} canonical cases from the existing TS importer; ChatGPT card fixture preserved.`,
);
