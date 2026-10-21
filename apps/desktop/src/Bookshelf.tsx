import { useEffect, useState, type CSSProperties } from "react";
import { request } from "./api";
import type { Snapshot } from "@anynote/types";
import type { Notebook } from "@anynote/types";
import { BookOpen, Moon, Plus, Sun, Upload } from "./icons";
import { Button } from "./components/ui/button";

type Props = {
  books: Notebook[];
  busy: boolean;
  dark: boolean;
  onOpen: (book: Notebook) => void;
  onCreate: () => void;
  onImport: () => void;
  onTheme: () => void;
};

/** Stable binding variations keep a volume recognizable when the library changes. */
function binding(id: string): CSSProperties {
  const hash = Array.from(id).reduce(
    (value, char) => (value * 31 + char.charCodeAt(0)) >>> 0,
    0,
  );

  return {
    "--book-height": `${222 + (hash % 38)}px`,
    "--book-width": `${62 + (hash % 13)}px`,
    "--binding": [
      "#583a29",
      "#35483d",
      "#663b36",
      "#384446",
      "#795d3d",
      "#4e3c2f",
    ][hash % 6],
  } as CSSProperties;
}

/** The library entrance presents each registered Notebook as a bound volume. */
export default function Bookshelf({
  books,
  busy,
  dark,
  onOpen,
  onCreate,
  onImport,
  onTheme,
}: Props) {
  const [snapshots, setSnapshots] = useState<Record<string, string>>({});
  let visits: Record<string, number> = {};
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem("anynote.notebooks.visits") || "{}",
    );
    if (stored && typeof stored === "object" && !Array.isArray(stored))
      visits = Object.fromEntries(
        Object.entries(stored).filter(
          ([, value]) => typeof value === "number" && Number.isFinite(value),
        ),
      );
  } catch {
    /* Invalid local preferences do not prevent opening books. */
  }
  const recent = books
    .filter((b) => visits[b.id])
    .sort((a, b) => visits[b.id] - visits[a.id])
    .slice(0, 5);
  const recentIds = recent.map((b) => b.id).join(",");
  useEffect(() => {
    let cancelled = false;
    for (const id of recentIds.split(",").filter(Boolean)) {
      void request<Snapshot[]>("listSnapshots", { notebookId: id })
        .then((rows) => {
          if (!cancelled)
            setSnapshots((previous) => ({
              ...previous,
              [id]: rows?.length
                ? `本地快照：${new Date(rows.reduce((latest, r) => Math.max(latest, r.createdAt), 0)).toLocaleString("zh-CN")}`
                : "尚无本地快照",
            }));
        })
        .catch(() => {
          if (!cancelled)
            setSnapshots((previous) => ({
              ...previous,
              [id]: "快照状态不可用",
            }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [recentIds]);
  return (
    <div className="bookshelf">
      <header className="library-header">
        <span className="library-brand">
          <BookOpen size={23} /> anynote.
        </span>
        <div className="library-actions">
          <Button onClick={onCreate} disabled={busy}>
            <Plus size={16} />
            创建 Notebook
          </Button>
          <Button variant="ghost" onClick={onImport} disabled={busy}>
            <Upload size={16} />
            导入 Notebook
          </Button>
          <Button variant="ghost" onClick={onTheme} aria-label="切换主题">
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </Button>
        </div>
      </header>
      <div className="book-grid" aria-label="所有 Notebook">
        {books.map((book, index) => (
          <button
            key={book.id}
            className="book-volume"
            style={
              {
                ...binding(book.id),
                ...(book.cover_color ? { "--binding": book.cover_color } : {}),
              } as CSSProperties
            }
            title={`${book.name}${book.unavailable ? " · 目录不可用，点击恢复" : book.external ? " · 外部藏书" : ""}`}
            disabled={busy}
            onClick={() => onOpen(book)}
            aria-label={`${book.unavailable ? "恢复" : "打开"} Notebook：${book.name}`}
          >
            <span className="spine-cap" aria-hidden="true" />
            <span className="spine-edition" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="spine-title">{book.name}</span>
            <span className="spine-ornament" aria-hidden="true">
              {book.icon || "❦"}
            </span>
            <span className="spine-footer">
              {book.unavailable ? "待恢复" : book.external ? "外部" : "ANYNOTE"}
            </span>
            <span className="spine-cap" aria-hidden="true" />
          </button>
        ))}
        <button className="book-new" onClick={onCreate} disabled={busy}>
          <Plus size={28} strokeWidth={1} />
          <span>新的一本</span>
          <small>待续</small>
        </button>
      </div>
      {!!recent.length && (
        <section className="recent-notebooks" aria-label="最近 Notebook">
          <h2>最近翻阅</h2>
          {recent.map((book) => (
            <button key={book.id} disabled={busy} onClick={() => onOpen(book)}>
              <strong>
                {book.icon || "❦"} {book.name}
              </strong>
              <span>{new Date(visits[book.id]).toLocaleString("zh-CN")}</span>
              <small>{book.path || "默认知识库目录"}</small>
              <small>
                {snapshots[book.id] || "正在读取快照状态…"} ·
                云端及磁盘备份见工作区备份页
              </small>
            </button>
          ))}
        </section>
      )}
      <footer className="library-footer">
        <span>EX LIBRIS · ANYNOTE</span>
        <span>一本一世界，一页一时光。</span>
      </footer>
    </div>
  );
}
