import { Storage } from "../../.build/packages/storage-sqlite/index.js";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  createReadStream,
  statSync,
} from "node:fs";
import { join } from "node:path";
export async function fixture(root) {
  const s = new Storage(join(root, "notebooks"));
  const book = await s.run("createNotebook", { title: "性能与界面验收库" });
  const db = s.open(book.id),
    now = Date.now();
  const node = db.prepare(
      "INSERT INTO nodes(id,parent_id,kind,title,sort_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    ),
    note = db.prepare(
      "INSERT INTO notes(node_id,note_type) VALUES(?,'markdown')",
    ),
    rev = db.prepare(
      "INSERT INTO note_revisions(id,note_id,body,created_at) VALUES(?,?,?,?)",
    );
  const regularBody =
    "# 普通文档\n\n" + "中文验收文档，保持源码与本地保存一致。\n".repeat(900);
  const ids = [],
    folders = [];
  let parent = null;
  db.exec("BEGIN");
  try {
    for (let i = 0; i < 1000; i++) {
      const id = randomUUID();
      folders.push(id);
      node.run(id, parent, "folder", "深层目录 " + i, i, now, now);
      parent = id;
    }
    for (let i = 0; i < 10000; i++) {
      const id = randomUUID(),
        revision = randomUUID();
      ids.push(id);
      const body =
        i === 0 ? regularBody : "# 索引语料\n\n验收唯一目标 " + i + "。";
      node.run(
        id,
        null,
        "note",
        "观测笔记 " + String(i).padStart(5, "0"),
        2000 + i,
        now,
        now,
      );
      note.run(id);
      rev.run(revision, id, body, now);
      db.prepare("UPDATE notes SET head_revision_id=? WHERE node_id=?").run(
        revision,
        id,
      );
      s.recordRevision(db, revision, id);
      s.index(db, id);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  const create = async (title, body, parentId) => {
    let n = await s.run("createNode", {
      notebookId: book.id,
      kind: "note",
      title,
      parentId,
    });
    return s.run("saveNote", {
      notebookId: book.id,
      id: n.id,
      expectedRevision: n.revision,
      body,
    });
  };
  const longTitle =
    "长中文标题：在一千层目录中记录复杂资料与多插件内容，以及本地优先知识库的界面验证".repeat(
      3,
    );
  const complex = await create(
    longTitle,
    "# 内容与边界\n\n中文段落与键盘操作。\n\n```typescript\n" +
      'const longLine = "长代码块不挤出页面"; '.repeat(35) +
      '\n```\n\n![缺失资源](https://invalid.example/missing.png)\n\n:::anynote{type="core.video" version="1" id="video-acceptance"}\n{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}\n:::\n\n:::anynote{type="future.plugin" version="9" id="unknown-acceptance"}\n{"preserve":"未知内容原样保留"}\n:::\n',
    parent,
  );
  const large = await create(
    "超大 Markdown 性能策略",
    "# 大文件\n\n" +
      "大文档中文源码性能验收，禁止整篇预览解析。\n".repeat(26000),
  );
  // A valid 100MiB+ multipage PDF: each page has a different padded content stream.
  const temp = join(root, "sample.pdf"),
    fd = openSync(temp, "w"),
    offsets = [0];
  let position = 0;
  const write = (text) => {
    const b = Buffer.from(text);
    writeSync(fd, b);
    position += b.length;
  };
  const obj = (id, text) => {
    offsets[id] = position;
    write(`${id} 0 obj\n${text}\nendobj\n`);
  };
  const pages = 100,
    payload =
      "%" +
      "x".repeat(1024 * 1024) +
      "\nBT /F1 18 Tf 40 700 Td (Anynote performance page) Tj ET\n";
  write("%PDF-1.4\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(
    2,
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages} >>`,
  );
  obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let i = 0; i < pages; i++) {
    obj(
      4 + i * 2,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    const content = payload.replace(
      "Anynote performance page",
      `Anynote performance page ${i + 1}`,
    );
    obj(
      5 + i * 2,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    );
  }
  const xref = position;
  write(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  for (const offset of offsets.slice(1))
    write(`${String(offset).padStart(10, "0")} 00000 n \n`);
  write(
    `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`,
  );
  closeSync(fd);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(temp)) digest.update(chunk);
  const hash = digest.digest("hex"),
    size = statSync(temp).size,
    path = `assets/sha256/${hash.slice(0, 2)}/${hash}.bin`;
  const asset = join(s.directory(book.id), path);
  mkdirSync(join(asset, ".."), { recursive: true });
  const { copyFileSync } = await import("node:fs");
  copyFileSync(temp, asset);
  const pdf = await s.run("createNode", {
      notebookId: book.id,
      kind: "note",
      title: "100MiB 多页 PDF",
    }),
    resourceId = randomUUID();
  db.exec("BEGIN");
  db.prepare("INSERT INTO assets VALUES(?,?,?,?)").run(
    hash,
    size,
    "application/pdf",
    path,
  );
  db.prepare(
    "INSERT INTO resources(id,asset_hash,original_name) VALUES(?,?,?)",
  ).run(resourceId, hash, "sample.pdf");
  db.prepare(
    "UPDATE notes SET note_type='pdf',primary_resource_id=? WHERE node_id=?",
  ).run(resourceId, pdf.id);
  s.capture(db, pdf.head_revision_id, "", resourceId);
  db.exec("COMMIT");
  s.close();
  return {
    book,
    ids,
    folders,
    complex,
    large,
    pdf,
    resourceId,
    pdfHash: hash,
    pdfBytes: size,
    markdownBytes: Buffer.byteLength(regularBody),
    largeMarkdownBytes: Buffer.byteLength(large.body),
    nodes: 11003,
    pages,
  };
}
