import type { CSSProperties } from "react";
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
            style={binding(book.id)}
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
              ❦
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
      <footer className="library-footer">
        <span>EX LIBRIS · ANYNOTE</span>
        <span>一本一世界，一页一时光。</span>
      </footer>
    </div>
  );
}
