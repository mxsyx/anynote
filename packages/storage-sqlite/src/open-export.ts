import { assetFile, readAsset } from "./assets.js";
import { imageBlock, imageMarkdown } from "@anynote/protocol/image.js";
import { parseBlocks, resourceIds } from "@anynote/protocol/markdown.js";
import { entryLimits } from "@anynote/protocol/import-limits.js";
import { zipSync } from "fflate";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, posix } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SqlDatabase, SqlRow } from "@anynote/types/runtime.js";
import type { Storage } from "./index.js";
import { limits, type ExportEntry } from "./archive-stream.js";

const suffix: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "application/vnd.anynote.whiteboard+json": "excalidraw.json",
};
const sceneMime = "application/vnd.anynote.whiteboard+json";
type Chunks = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
type Sink = (path: string, chunks?: Chunks) => Promise<void>;

/** Stable portable names: full UUID suffixes avoid prefix, case and Unicode collisions. */
function segment(n: SqlRow) {
  if (
    typeof n.id !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      n.id,
    )
  )
    throw Error("导出条目 ID 无效");
  let title =
    n.title
      .normalize("NFC")
      .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_")
      .replace(/[. ]+$/, "") || "未命名";
  title = [...title].reduce(
    (out, char) => (Buffer.byteLength(out + char) <= 64 ? out + char : out),
    "",
  );
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title))
    title = "_" + title;
  return title + "-" + n.id;
}

const link = (from: string, to: string) =>
  posix
    .relative(posix.dirname(from), to)
    .split("/")
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase(),
      ),
    )
    .join("/");

/** Produce one note/resource at a time; attachment and embedded-image bytes stay streamed. */
async function renderMarkdown(
  db: SqlDatabase,
  id: string,
  put: Sink,
  signal?: AbortSignal,
) {
  if (
    db
      .prepare("SELECT COUNT(*) AS count FROM nodes WHERE deleted_at IS NULL")
      .get()!.count >
    limits.entries - 2
  )
    throw Error("开放导出条目数超限");
  const nodes = db
    .prepare(
      "SELECT n.*,t.note_type,t.primary_resource_id,t.head_revision_id FROM nodes n LEFT JOIN notes t ON t.node_id=n.id WHERE n.deleted_at IS NULL ORDER BY n.id",
    )
    .all();
  const map = new Map(nodes.map((n) => [n.id, n])),
    paths = new Map<string, string>(),
    emitted = new Set<string>();
  const warnings = new Set<string>();
  const embedded = new Map<string, Record<string, string>>();
  const resourceMap: {
    noteId: string;
    revisionId: string;
    resources: Record<string, string>;
  }[] = [];
  const resolve = (resourceId: string, head: string): SqlRow => {
    const r = db
      .prepare(
        "SELECT r.id,a.* FROM resources r JOIN assets a ON a.hash=COALESCE((SELECT asset_hash FROM revision_resources WHERE revision_id=? AND resource_id=r.id),r.asset_hash) WHERE r.id=?",
      )
      .get(head, resourceId);
    if (!r) throw Error("导出资源缺失：" + resourceId);
    return r;
  };
  const extension = (n: SqlRow) =>
    n.kind === "folder"
      ? ""
      : n.note_type === "markdown"
        ? ".md"
        : "." +
          (suffix[resolve(n.primary_resource_id, n.head_revision_id).mime] ||
            "bin");
  for (const node of nodes) {
    const chain: SqlRow[] = [],
      seen = new Set<string>();
    let cur: SqlRow | undefined = node;
    while (cur && !paths.has(cur.id)) {
      if (seen.has(cur.id)) throw Error("目录包含循环");
      seen.add(cur.id);
      chain.push(cur);
      if (!cur.parent_id) break;
      const parent = map.get(cur.parent_id);
      if (!parent || parent.kind !== "folder")
        throw Error("导出目录父节点无效");
      cur = parent;
    }
    for (const n of chain.reverse()) {
      const name = segment(n) + extension(n);
      let path = n.parent_id ? paths.get(n.parent_id) + "/" + name : name;
      if (Buffer.byteLength(path) > 220) {
        path = "_long/" + name;
        warnings.add("过长目录已映射到 _long；原目录关系见 EXPORT-MAP.json。");
      }
      paths.set(n.id, path);
    }
  }
  async function* verified(r: SqlRow) {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(assetFile(db, r.hash), {
      highWaterMark: 48 * 1024,
      signal,
    })) {
      size += chunk.length;
      if (size > r.size) throw Error("导出资源大小不匹配");
      hash.update(chunk);
      yield chunk;
    }
    if (size !== r.size || hash.digest("hex") !== r.hash)
      throw Error("导出资源 SHA-256 校验失败");
  }
  const copy = async (dest: string, r: SqlRow) => {
    if (emitted.has(dest)) return;
    emitted.add(dest);
    await put(dest, verified(r));
  };
  const exportResource = async (r: SqlRow, head: string) => {
    const dest = `_assets/${r.hash}${r.mime === sceneMime ? "-" + head : ""}.${suffix[r.mime] || "bin"}`;
    if (emitted.has(dest)) return dest;
    if (r.mime !== sceneMime) {
      await copy(dest, r);
      return dest;
    }
    // The scene JSON has the editor's bounded size; large image payloads are encoded in chunks.
    if (r.size > entryLimits.singleFileBytes)
      throw Error("白板场景 JSON 超过 50MiB");
    const scene = JSON.parse(readAsset(db, r.hash).toString());
    await copy(`_assets/${r.hash}.scene.json`, r);
    const images: [string, SqlRow, SqlRow][] = [];
    for (const [fileId, value] of Object.entries(scene.files || {})) {
      const f = value as SqlRow,
        image = resolve(f.resourceId, head);
      const imagePath = `_assets/${image.hash}.${suffix[image.mime] || "bin"}`;
      await copy(imagePath, image);
      const paths = embedded.get(head) || {};
      paths[f.resourceId] = imagePath;
      embedded.set(head, paths);
      images.push([fileId, f, image]);
    }
    const { files: _files, ...rest } = scene;
    async function* portable() {
      const json = JSON.stringify({
        ...rest,
        type: "excalidraw",
        version: 2,
        source: "Anynote",
      });
      yield Buffer.from(json.slice(0, -1) + ',"files":{');
      for (let i = 0; i < images.length; i++) {
        const [fileId, f, image] = images[i];
        yield Buffer.from(
          (i ? "," : "") +
            JSON.stringify(fileId) +
            ":" +
            JSON.stringify({
              id: fileId,
              mimeType: image.mime,
              created: f.created,
            }).slice(0, -1) +
            ',"dataURL":' +
            JSON.stringify("data:" + image.mime + ";base64,").slice(0, -1),
        );
        let tail = Buffer.alloc(0);
        for await (const chunk of verified(image)) {
          const bytes = Buffer.concat([tail, chunk]),
            end = bytes.length - (bytes.length % 3);
          yield Buffer.from(bytes.subarray(0, end).toString("base64"));
          tail = Buffer.from(bytes.subarray(end));
        }
        if (tail.length) yield Buffer.from(tail.toString("base64"));
        yield Buffer.from('"}');
      }
      yield Buffer.from("}}");
    }
    emitted.add(dest);
    await put(dest, portable());
    return dest;
  };
  for (const n of nodes) {
    signal?.throwIfAborted();
    const path = paths.get(n.id)!;
    if (n.kind === "folder") {
      await put(path);
      continue;
    }
    if (n.note_type === "markdown") {
      let body =
        db
          .prepare("SELECT body FROM note_revisions WHERE id=?")
          .get(n.head_revision_id)?.body || "";
      const exported = new Map<string, string>();
      for (const resourceId of resourceIds(body))
        exported.set(
          resourceId,
          await exportResource(
            resolve(resourceId, n.head_revision_id),
            n.head_revision_id,
          ),
        );
      resourceMap.push({
        noteId: n.id,
        revisionId: n.head_revision_id,
        resources: {
          ...Object.fromEntries(exported),
          ...embedded.get(n.head_revision_id),
        },
      });
      body = parseBlocks(body)
        .map((b) => {
          if (b.kind !== "extension") return b.source;
          const data = b.data as SqlRow | undefined,
            image = imageBlock(b.source);
          if (image)
            return (
              imageMarkdown(
                image,
                link(path, exported.get(image.resourceId)!),
              ) + "\n"
            );
          if (
            b.attrs.type === "core.video" &&
            b.attrs.version === "1" &&
            typeof data?.url === "string"
          )
            return `[${String(data.title || "视频链接").replace(/[[\]\\]/g, "")}](${data.url})\n`;
          if (b.attrs.type === "core.whiteboard" && b.attrs.version === "1")
            return (
              [
                ["previewResourceId", "白板预览"],
                ["resourceId", "白板场景"],
              ]
                .map(([key, label]) =>
                  exported.has(data?.[key])
                    ? `${key === "previewResourceId" ? "!" : ""}[${label}](${link(path, exported.get(data![key])!)})`
                    : "",
                )
                .join("\n\n") + "\n"
            );
          warnings.add(
            `保留原始扩展块：${b.attrs.type || "unknown"}@${b.attrs.version || "unknown"}；开放阅读器可能无法渲染。`,
          );
          return b.source;
        })
        .join("");
      for (const [resourceId, dest] of exported)
        body = body.replaceAll(
          "anynote-resource:" + resourceId,
          link(path, dest),
        );
      body = body.replace(
        /anynote:\/\/notebook\/([a-f0-9-]{36})\/note\/([a-f0-9-]{36})(#[^\s)]*)?/gi,
        (whole: string, notebook: string, note: string, anchor = "") => {
          if (notebook === id && paths.has(note))
            return link(path, paths.get(note)!) + anchor;
          warnings.add(
            "跨库或未导出目标链接保留 anynote:// 地址，需要 Anynote 打开。",
          );
          return whole;
        },
      );
      await put(path, [Buffer.from(body)]);
    } else {
      await copy(path, resolve(n.primary_resource_id, n.head_revision_id));
      const annotations = db
        .prepare(
          "SELECT * FROM annotations WHERE note_id=? AND deleted_at IS NULL",
        )
        .all(n.id);
      for (const a of annotations) {
        const r = db
          .prepare("SELECT * FROM assets WHERE hash=?")
          .get(a.target_asset_hash);
        if (!r) throw Error("批注原件缺失");
        await copy(`_assets/${r.hash}.${suffix[r.mime] || "bin"}`, r);
      }
      if (annotations.length)
        await put(path + ".annotations.json", [
          Buffer.from(JSON.stringify(annotations, null, 2)),
        ]);
    }
  }
  await put("EXPORT-MAP.json", [
    Buffer.from(
      JSON.stringify(
        {
          format: "anynote.open-export.v1",
          notebookId: id,
          resources: resourceMap,
          nodes: nodes.map((n) => ({
            id: n.id,
            parentId: n.parent_id,
            title: n.title,
            path: paths.get(n.id),
          })),
        },
        null,
        2,
      ),
    ),
  ]);
  await put("EXPORT-REPORT.txt", [
    Buffer.from(
      "普通 Markdown 导出：仅当前未删除内容。历史、回收站、图片显示尺寸、标签收藏与插件编辑能力不包含；扩展独立状态不包含。白板保留原场景 .scene.json、预览、图片原件与嵌图 Excalidraw 场景；批注为 JSON sidecar，target_asset_hash 对应 _assets 原件。EXPORT-MAP.json 保存目录和名称映射。完整恢复请使用完整 .anynote 导出。\n" +
        [...warnings].join("\n"),
    ),
  ]);
}

/** Browser/base64 compatibility entry retains its explicit 100MiB memory budget. */
export async function exportMarkdown(s: Storage, id: string) {
  const files: Record<string, Uint8Array> = {};
  let total = 0;
  await renderMarkdown(s.open(id), id, async (path, chunks) => {
    if (!chunks) {
      files[path + "/"] = Buffer.alloc(0);
      return;
    }
    const parts: Uint8Array[] = [];
    for await (const chunk of chunks) {
      total += chunk.length;
      if (total > entryLimits.legacyArchiveBytes)
        throw Error("浏览器开放导出超过 100MiB；请使用桌面流式导出");
      parts.push(chunk);
    }
    files[path] = Buffer.concat(parts);
  });
  return {
    data: Buffer.from(zipSync(files)).toString("base64"),
    name:
      s.open(id).prepare("SELECT name FROM notebook_meta").get()!.name +
      "-markdown.zip",
  };
}

/** Stage a portable directory with bounded byte buffers and a descriptor-only ZIP plan. */
export async function stageMarkdown(
  db: SqlDatabase,
  id: string,
  dir: string,
  signal: AbortSignal,
  progress: (bytes: number, path: string) => void,
) {
  const entries: ExportEntry[] = [];
  let total = 0;
  await renderMarkdown(
    db,
    id,
    async (path, chunks) => {
      signal.throwIfAborted();
      if (entries.length >= limits.entries) throw Error("开放导出条目数超限");
      const file = join(dir, path);
      await mkdir(chunks ? dirname(file) : file, { recursive: true });
      if (!chunks) {
        entries.push({ path, directory: true, size: 0, sha256: "" });
        return;
      }
      const hash = createHash("sha256");
      let size = 0;
      await pipeline(
        Readable.from(chunks),
        new Transform({
          transform(chunk: Buffer, _, cb) {
            total += chunk.length;
            size += chunk.length;
            if (total > limits.bytes) {
              cb(Error("开放导出超过 20GiB 预算"));
              return;
            }
            hash.update(chunk);
            progress(total, path);
            cb(null, chunk);
          },
        }),
        createWriteStream(file, { flags: "wx", mode: 0o600, flush: true }),
        { signal },
      );
      entries.push({ path, size, sha256: hash.digest("hex") });
    },
    signal,
  );
  return { entries, bytes: total };
}
