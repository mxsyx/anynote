import { imageBlock, imageMarkdown } from "@anynote/protocol/image.js";
import { zipSync } from "fflate";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { parseBlocks, resourceIds } from "@anynote/protocol/markdown.js";
import type { SqlRow } from "@anynote/types/runtime.js";
import type { Storage } from "./index.js";
const suffix: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "application/vnd.anynote.whiteboard+json": "excalidraw.json",
};
export function exportMarkdown(s: Storage, id: string) {
  const db = s.open(id),
    nodes = db
      .prepare(
        "SELECT n.*,t.note_type,t.primary_resource_id,t.head_revision_id,r.body FROM nodes n LEFT JOIN notes t ON t.node_id=n.id LEFT JOIN note_revisions r ON r.id=t.head_revision_id WHERE n.deleted_at IS NULL",
      )
      .all(),
    map = new Map(nodes.map((n) => [n.id, n]));
  const resources = db
      .prepare(
        "SELECT r.id,a.* FROM resources r JOIN assets a ON a.hash=r.asset_hash",
      )
      .all(),
    resourceMap = new Map(resources.map((r) => [r.id, r])),
    paths = new Map(),
    files: Record<string, Uint8Array> = {};
  const resolve = (resourceId: string, head: string) => {
    const current = resourceMap.get(resourceId);
    if (!current) return null;
    const pinned = db
      .prepare(
        "SELECT a.* FROM revision_resources p JOIN assets a ON a.hash=p.asset_hash WHERE p.revision_id=? AND p.resource_id=?",
      )
      .get(head, resourceId);
    return pinned ? { ...current, ...pinned } : current;
  };
  const safe = (n: SqlRow) =>
    n.title
      .normalize("NFC")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/[. ]+$/, "")
      .slice(0, 80) || "未命名";
  for (const n of nodes) {
    const folders = [];
    let cur: SqlRow | undefined = n;
    const seen = new Set();
    while (cur?.parent_id) {
      if (seen.has(cur.id)) throw Error("目录包含循环");
      seen.add(cur.id);
      cur = map.get(cur.parent_id);
      if (!cur) break;
      folders.unshift(safe(cur) + "-" + cur.id.slice(0, 8));
    }
    const ext =
      n.kind === "folder"
        ? ""
        : n.note_type === "markdown"
          ? ".md"
          : "." +
            (suffix[resourceMap.get(n.primary_resource_id)?.mime] || "bin");
    paths.set(
      n.id,
      [...folders, safe(n) + "-" + n.id.slice(0, 8) + ext].join("/"),
    );
  }
  let total = 0;
  const put = (path: string, bytes: Buffer) => {
    total -= files[path]?.length || 0;
    total += bytes.length;
    if (total > 100 * 1024 * 1024) throw Error("开放导出超过 100MB");
    files[path] = bytes;
  };
  const assetPath = (r: SqlRow) =>
    `_assets/${r.hash}.${suffix[r.mime] || "bin"}`;
  const exportResource = (r: SqlRow, head: string) => {
    const dest = assetPath(r);
    if (files[dest]) return dest;
    let bytes = readFileSync(s.notebookPath(id, r.path));
    if (r.mime === "application/vnd.anynote.whiteboard+json") {
      const scene = JSON.parse(bytes.toString());
      for (const [fileId, f] of Object.entries(scene.files || {}) as [
        string,
        SqlRow,
      ][]) {
        const image = resolve(f.resourceId, head);
        if (!image) throw Error("白板图片资源缺失");
        const data = readFileSync(s.notebookPath(id, image.path));
        scene.files[fileId] = {
          id: fileId,
          mimeType: image.mime,
          created: f.created,
          dataURL: `data:${image.mime};base64,${data.toString("base64")}`,
        };
      }
      bytes = Buffer.from(
        JSON.stringify({
          type: "excalidraw",
          version: 2,
          source: "Anynote",
          ...scene,
        }),
      );
    }
    put(dest, bytes);
    return dest;
  };
  for (const n of nodes) {
    if (n.kind === "folder") continue;
    const path = paths.get(n.id);
    if (n.note_type === "markdown") {
      let body = n.body || "";
      for (const resourceId of resourceIds(body)) {
        const r = resolve(resourceId, n.head_revision_id);
        if (r)
          body = body.replaceAll(
            "anynote-resource:" + resourceId,
            posix.relative(
              posix.dirname(path),
              exportResource(r, n.head_revision_id),
            ),
          );
      }
      for (const b of parseBlocks(body).filter((b) => b.kind === "extension")) {
        let replacement = b.source;
        const data = b.data as SqlRow | undefined;
        const image = imageBlock(b.source);
        if (image) {
          const r = resolve(image.resourceId, n.head_revision_id);
          if (r)
            replacement =
              imageMarkdown(
                image,
                posix.relative(
                  posix.dirname(path),
                  exportResource(r, n.head_revision_id),
                ),
              ) + "\n";
        }
        if (
          b.attrs.type === "core.video" &&
          b.attrs.version === "1" &&
          data?.url
        )
          replacement = `[视频链接](${data!.url})\n`;
        if (b.attrs.type === "core.whiteboard" && b.attrs.version === "1")
          replacement =
            [
              ["previewResourceId", "白板预览"],
              ["resourceId", "白板场景"],
            ]
              .map(([key, label]) => {
                const r = resolve(data?.[key], n.head_revision_id);
                return r
                  ? `${key === "previewResourceId" ? "!" : ""}[${label}](${posix.relative(posix.dirname(path), exportResource(r, n.head_revision_id))})`
                  : "";
              })
              .join("\n\n") + "\n";
        body = body.replace(b.source, replacement);
      }
      body = body.replace(
        /anynote:\/\/notebook\/([a-f0-9-]{36})\/note\/([a-f0-9-]{36})(#[^\s)]*)?/gi,
        (whole: string, notebook: string, note: string, anchor = "") =>
          notebook === id && paths.has(note)
            ? posix.relative(posix.dirname(path), paths.get(note)) + anchor
            : whole,
      );
      put(path, Buffer.from(body));
    } else {
      const r = resourceMap.get(n.primary_resource_id);
      if (r) {
        put(path, readFileSync(s.notebookPath(id, r.path)));
        const annotations = db
          .prepare(
            "SELECT * FROM annotations WHERE note_id=? AND deleted_at IS NULL",
          )
          .all(n.id);
        if (annotations.length)
          put(
            path + ".annotations.json",
            Buffer.from(JSON.stringify(annotations, null, 2)),
          );
      }
    }
  }
  put(
    "EXPORT-REPORT.txt",
    Buffer.from(
      "普通 Markdown 导出：仅当前未删除内容。历史、回收站、图片显示尺寸与插件编辑能力不包含；白板为预览与可携带内嵌图片的 Excalidraw 场景，批注为 JSON sidecar。完整恢复请使用 .anynote 导出。",
    ),
  );
  return {
    data: Buffer.from(zipSync(files)).toString("base64"),
    name:
      db.prepare("SELECT name FROM notebook_meta").get()!.name +
      "-markdown.zip",
  };
}
