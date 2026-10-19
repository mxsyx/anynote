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
          <Button variant="ghost" onClick={onImport} disabled={busy}>
            <Upload size={16} />
            导入 Notebook
          </Button>
          <Button variant="ghost" onClick={onTheme} aria-label="切换主题">
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </Button>
        </div>
      </header>
      <div className="library-intro">
        <span className="eyebrow">YOUR PERSONAL LIBRARY</span>
        <h1>
          私人藏书室<span>藏起日常，翻开想法。</span>
        </h1>
        <p>每一本笔记，都是一处值得回来的地方。</p>
      </div>
      <div className="library-catalog">
        <span>
          全部藏书 <small>{books.length.toString().padStart(2, "0")}</small>
        </span>
        <Button onClick={onCreate} disabled={busy}>
          <Plus size={16} />
          创建 Notebook
        </Button>
      </div>
      <div className="book-grid" aria-label="所有 Notebook">
        {books.map((book, index) => (
          <button
            key={book.id}
            className="book-volume"
            data-tone={index % 4}
            disabled={busy}
            onClick={() => onOpen(book)}
            aria-label={`${book.unavailable ? "恢复" : "打开"} Notebook：${book.name}`}
          >
            <span className="book-cover">
              <span className="cover-edition">
                NOTEBOOK / {String(index + 1).padStart(2, "0")}
              </span>
              <span className="cover-title">{book.name}</span>
              <span className="cover-ornament" aria-hidden="true">
                ✳
              </span>
              <span className="cover-footer">
                {book.unavailable
                  ? "目录不可用 · 点击恢复"
                  : book.external
                    ? "外部藏书"
                    : "私人珍藏"}
                <BookOpen size={18} />
              </span>
            </span>
            <span className="book-caption">
              <strong>{book.name}</strong>
              <span>{book.unavailable ? "恢复笔记本" : "翻开这本笔记"} ↗</span>
            </span>
          </button>
        ))}
        <button className="book-new" onClick={onCreate} disabled={busy}>
          <Plus size={28} strokeWidth={1} />
          <span>新的一本</span>
          <small>给下一个想法留个位置</small>
        </button>
      </div>
      <footer className="library-footer">
        <span>EX LIBRIS · ANYNOTE</span>
        <span>一本一世界，一页一时光。</span>
      </footer>
    </div>
  );
}
