import { test } from "vitest";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  convertComponents,
  rehypeCaptureCards,
} from "../.build/packages/capture/chatgpt-components.js";
import {
  localizeBody,
  copyMarkdown,
} from "../.build/packages/capture/markdown.js";
import { conversationMarkdown } from "../.build/packages/capture/chatgpt.js";
const requireDesktop = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const React = requireDesktop("react"),
  { renderToStaticMarkup } = requireDesktop("react-dom/server");
const { default: Markdown } = await import(
  requireDesktop.resolve("react-markdown")
);
import { flow, group } from "./fixtures/chatgpt-components.mjs";
function render(body) {
  return renderToStaticMarkup(
    React.createElement(
      Markdown,
      { rehypePlugins: [rehypeCaptureCards] },
      body,
    ),
  );
}
test("ChatGPT cards become portable inline HTML and render in the desktop Markdown pipeline", () => {
  const result = convertComponents(flow);
  assert.deepEqual(result.missing, []);
  assert.ok(!/<(?:box|icon|caption)\b/.test(result.body));
  assert.match(result.body, /padding:12px/);
  assert.match(result.body, /border-radius:16px/);
  assert.match(result.body, /<strong>Git Diff 代码变更<\/strong>/);
  assert.equal((result.body.match(/↓/g) || []).length, 3);
  assert.match(result.body, /background-color:rgba\(22,163,74,0.08\)/);
  assert.equal(localizeBody(result.body, new Map()), result.body);
  assert.equal(copyMarkdown(result.body), result.body);
  const html = render(result.body);
  assert.match(html, /data-anynote-card="1"/);
  assert.match(html, /<strong>运行相关测试并解释原因<\/strong>/);
  assert.ok(!html.includes("&lt;div"));
});
test("card sanitizer drops active HTML and unsafe CSS even on a forged marker", () => {
  const html = render(
    '<div data-anynote-card="1" onclick="alert(1)" style="position:fixed;background:url(https://evil.test);color:red"><script>secret()</script><img src="https://evil.test/x" onerror="evil()"><div style="padding:8px;background:#ffffff">safe</div></div>',
  );
  for (const unsafe of [
    "onclick",
    "onerror",
    "evil.test",
    "secret()",
    "position:fixed",
    "<script",
    "<img",
  ])
    assert.ok(!html.includes(unsafe), unsafe);
  assert.match(html, /padding:8px/);
  assert.match(html, /safe/);
  assert.match(render('<div onclick="evil()">ordinary HTML</div>'), /&lt;div/);
  const inherited = convertComponents(
    '<box background="__proto__" radius="constructor"><icon name="toString" color="constructor"/></box>',
  );
  assert.deepEqual(inherited.missing, []);
  assert.match(render(inherited.body), /\[toString\]/);
  assert.ok(!inherited.body.includes("[object Object]"));
});
test("code and user examples keep component markup verbatim", () => {
  const source = `\`\`\`jsx\n${flow}\n${group}\n\`\`\`\n\n\`${group}\``;
  assert.equal(convertComponents(source).body, source);
  assert.deepEqual(convertComponents(source).missing, []);
  const result = conversationMarkdown({
    id: "fixture",
    title: "fixture",
    currentNode: "user",
    incomplete: false,
    nodes: [
      { id: "user", parent: null, message: { role: "user", text: flow } },
    ],
  });
  assert.ok(result.body.includes(flow));
});
test("image groups require unambiguous rendered groups and retain each actual URL", () => {
  const images = [
    {
      url: "https://images.example.com/a?purpose=inline",
      alt: "First [image]",
    },
    { url: "https://images.example.com/b", alt: "Second" },
  ];
  const result = convertComponents(group, [{ images, incomplete: false }]);
  assert.deepEqual(result.missing, []);
  assert.ok(
    result.body.includes("https://images.example.com/a?purpose=inline"),
  );
  assert.ok(result.body.includes("https://images.example.com/b"));
  assert.ok(!result.body.includes("AsyncImageGroup"));
  assert.equal(convertComponents(group).missing.length, 1);
  assert.equal(
    convertComponents(group + "\n\n" + group, [{ images, incomplete: false }])
      .missing.length,
    2,
  );
  assert.equal(
    convertComponents(group, [
      {
        images: [{ url: "javascript:alert(1)", alt: "bad" }],
        incomplete: false,
      },
    ]).missing.length,
    1,
  );
  const nested = convertComponents(`<box>${group}</box>`, [
    { images, incomplete: false },
  ]);
  assert.deepEqual(nested.missing, []);
  assert.ok(nested.body.indexOf("</div>") < nested.body.indexOf("!["));
});
test("raw HTML cards preserve preformatted code but report unsupported embedded media", () => {
  const result = convertComponents(
    '<div style="padding:8px;color:#333"><pre><code>**literal**\n\nvalue &lt; 3</code></pre><img src="https://example.com/a.png"></div>',
  );
  assert.equal(result.missing.length, 1);
  assert.ok(!result.body.includes("<img"));
  const html = render(result.body);
  assert.match(html, /\*\*literal\*\*/);
  assert.ok(!html.includes("<strong>literal"));
});
