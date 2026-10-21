import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Rebuild the local review index using only files listed by the latest runs. */
export function writeVisualGallery(directory) {
  const groups = [
    ["report.json", "", "浏览器 fixture 与设计样张"],
    ["desktop/report.json", "desktop/", "Electron · 临时真实存储"],
  ];
  const sections = groups
    .filter(([file]) => existsSync(join(directory, file)))
    .map(([file, prefix, label]) => {
      const report = JSON.parse(readFileSync(join(directory, file), "utf8"));
      return `<section><h2>${label} · ${report.status || "unknown"}</h2><div class="grid">${report.screenshots.map((name) => `<a href="${prefix}${name}"><img loading="lazy" src="${prefix}${name}" alt="${name}"><span>${name}</span></a>`).join("")}</div></section>`;
    });
  writeFileSync(
    join(directory, "index.html"),
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>G20 视觉验收</title><style>body{margin:24px;background:#f4f4f2;color:#242424;font:14px system-ui}h1{font-size:24px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}a{color:inherit;text-decoration:none}img{width:100%;border:1px solid #ccc}span{display:block;margin:6px 0 16px}</style><h1>G20 · 视觉验收</h1><p>点击缩略图查看原始尺寸。模拟 RPC、真实本地存储与设计样张的证据边界见 G20 报告。</p>${sections.join("")}</html>`,
  );
}
