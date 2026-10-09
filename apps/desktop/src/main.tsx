import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  BookOpen,
  Search,
  Clock,
  Star,
  Trash2,
  Folder,
  FolderOpen,
  FolderPlus,
  FileText,
  Plus,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  ArrowUpRight,
  PanelLeft,
  PanelRight,
  MoreHorizontal,
  Check,
  Download,
  Upload,
  Settings,
  Sun,
  Moon,
  X,
  Leaf,
  Code2,
  Eye,
  Image as ImageIcon,
  File,
  Hash,
  History,
  HardDrive,
  Puzzle,
  Move,
  RotateCcw,
  LoaderCircle,
  Maximize2,
} from "lucide-react";

import type {
  Notebook,
  NoteNode,
  Revision,
  Snapshot,
  SearchResult,
  SearchResponse,
} from "@anynote/types";
import { request, base64, download } from "./api";
import { seed } from "./seed";
import ImportReport from "./ImportReport";
import DocumentView, { type BoardBlock } from "./DocumentView";
import ImportDialog from "./ImportDialog";
import TaskCenter from "./TaskCenter";
import ExtensionCommands from "./ExtensionCommands";
import ExtensionPage from "./ExtensionPage";
import Backlinks from "./Backlinks";
import LocalCleanup from "./LocalCleanup";
import Diagnostics from "./Diagnostics";
import BackupTargets from "./BackupTargets";
import CloudBackup from "./CloudBackup";
import LocalBackup from "./LocalBackup";
import CloudRecovery from "./CloudRecovery";
import RecoveryWizard from "./RecoveryWizard";
import SourceEditor from "./SourceEditor";
import NotebookTransferDialog from "./NotebookTransferDialog";
import "./styles.css";
const RichEditor = lazy(() => import("./RichEditor"));
const WhiteboardEditor = lazy(() => import("./WhiteboardEditor"));
const PdfReader = lazy(() => import("./PdfReader"));
const ImageReader = lazy(() => import("./ImageReader"));
/** Main workspace view. */
type View =
  | "notes"
  | "recent"
  | "favorites"
  | "trash"
  | "backup"
  | "extensions"
  | "settings";

/** Modal dialog request (type and optional target node). */
type Modal = {
  type:
    | "note"
    | "folder"
    | "notebook"
    | "rename"
    | "move"
    | "tags"
    | "video"
    | "renameNotebook";
  target?: NoteNode;
};

/**
 * Format a timestamp as "month day".
 *
 * @param t Timestamp in milliseconds.
 * @returns The formatted date.
 */
const date = (t: number) =>
  new Date(t).toLocaleDateString("zh-CN", { month: "long", day: "numeric" });

/**
 * Return the icon matching a node type.
 *
 * @param n Node.
 * @param size Icon size.
 * @returns The icon element.
 */
const icon = (n: NoteNode, size = 16) =>
  n.kind === "folder" ? (
    <Folder size={size} />
  ) : n.note_type === "image" ? (
    <ImageIcon size={size} />
  ) : n.note_type === "pdf" ? (
    <File size={size} />
  ) : (
    <FileText size={size} />
  );
/** App root component: Notebook/note navigation, editing, search, backup, and extension entry points. */
function App() {
  const [importOpen, setImportOpen] = useState(false),
    [tasksOpen, setTasksOpen] = useState(false),
    [board, setBoard] = useState<BoardBlock | null>(null),
    [pdfAnchor, setPdfAnchor] = useState<{
      noteId: string;
      anchor: string;
    } | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const [books, setBooks] = useState<Notebook[]>([]),
    [book, setBook] = useState<Notebook | null>(null),
    [nodes, setNodes] = useState<NoteNode[]>([]),
    [active, setActive] = useState<NoteNode | null>(null),
    [view, setView] = useState<View>("notes"),
    [expanded, setExpanded] = useState<Set<string>>(new Set()),
    [mode, setMode] = useState<"preview" | "source" | "rich">("preview"),
    [panel, setPanel] = useState<"outline" | "history" | null>(null),
    [revisions, setRevisions] = useState<Revision[]>([]),
    [snapshots, setSnapshots] = useState<Snapshot[]>([]),
    [status, setStatus] = useState("已保存至本地"),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [busy, setBusy] = useState(false),
    [searchOpen, setSearchOpen] = useState(false),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<SearchResult[]>([]),
    [searchScope, setSearchScope] = useState("current"),
    [searchType, setSearchType] = useState(""),
    [searchTag, setSearchTag] = useState(""),
    [searchFolder, setSearchFolder] = useState(""),
    [searchAge, setSearchAge] = useState(""),
    [searching, setSearching] = useState(false),
    [searchInfo, setSearchInfo] = useState<SearchResponse | null>(null),
    [searchIndex, setSearchIndex] = useState(0),
    [modal, setModal] = useState<Modal | null>(null),
    [recovery, setRecovery] = useState<Notebook | null>(null),
    [transfer, setTransfer] = useState<{
      node: NoteNode;
      mode: "copy" | "move";
    } | null>(null),
    [field, setField] = useState(""),
    [menu, setMenu] = useState(false),
    [switcher, setSwitcher] = useState(false),
    [sidebar, setSidebar] = useState(true),
    [dark, setDark] = useState(
      localStorage.getItem("anynote-theme") === "dark",
    ),
    [tagFilter, setTagFilter] = useState<string | null>(null),
    [asset, setAsset] = useState<{
      data: string;
      mime: string;
      bytes: Uint8Array;
      url: string;
      hash: string;
      size?: number;
    } | null>(null),
    [treeScroll, setTreeScroll] = useState(0),
    [treeHeight, setTreeHeight] = useState(450);
  const [dropHint, setDropHint] = useState<{
    id: string;
    position: "before" | "after" | "inside";
  } | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const treeSelection = useRef<string | null>(null);
  const treeFocusSequence = useRef(0);
  const focusBeforeDialog = useRef<HTMLElement | null>(null);
  useEffect(() => {
    /**
     * Remember the focused element before the dialog opens so focus can be restored on close.
     *
     * @param e Focus event.
     */
    const remember = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[role=dialog]")) focusBeforeDialog.current = target;
    };
    document.addEventListener("focusin", remember);
    const narrow = window.matchMedia("(max-width: 760px)");

    /** Collapse the sidebar by default on narrow screens. */
    const resize = () => {
      if (narrow.matches) setSidebar(false);
    };
    resize();
    narrow.addEventListener("change", resize);
    return () => {
      document.removeEventListener("focusin", remember);
      narrow.removeEventListener("change", resize);
    };
  }, []);
  // Report a metered/save-data network so the backup pause policy can defer
  // automatic backups on metered connections; battery state arrives from the
  // desktop main process. A missing Network Information API stays "unknown".
  useEffect(() => {
    const connection = (navigator as { connection?: any }).connection;
    if (!connection) return;
    const report = () =>
      void request("reportBackupEnvironment", {
        metered: !!connection.saveData,
      }).catch(() => {});
    report();
    connection.addEventListener?.("change", report);
    return () => connection.removeEventListener?.("change", report);
  }, []);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  useEffect(() => {
    const el = treeRef.current;
    if (!el) return;

    // Track the tree height for the long-list virtual scrolling window calculation.
    const observer = new ResizeObserver(() => setTreeHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [sidebar]);
  const current = useRef<NoteNode | null>(null),
    bookRef = useRef<Notebook | null>(null),
    dirty = useRef(false),
    saveQueue = useRef(Promise.resolve()),
    composition = useRef(false),
    fileInput = useRef<HTMLInputElement>(null),
    archiveInput = useRef<HTMLInputElement>(null),
    sourceRef = useRef<HTMLDivElement>(null),
    recent = useRef<string[]>(
      JSON.parse(localStorage.getItem("anynote-recent") || "[]"),
    );
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("anynote-theme", dark ? "dark" : "light");
  }, [dark]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(t);
  }, [toast]);
  /**
   * Normalize an exception into a displayable error message.
   *
   * @param e Thrown value.
   */
  const report = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));

  /**
   * Re-fetch the node tree of the given Notebook.
   *
   * @param id Notebook ID.
   */
  const reload = useCallback(async (id: string) => {
    setNodes(await request<NoteNode[]>("listNodes", { notebookId: id }));
  }, []);

  /**
   * Flush pending saves serially.
   *
   * `saveQueue` preserves write order; it is skipped during IME composition or
   * when not dirty.
   */
  const flush = useCallback(() => {
    const next = saveQueue.current.then(async () => {
      if (
        composition.current ||
        !dirty.current ||
        !current.current ||
        !bookRef.current
      )
        return;
      const draft = { ...current.current },
        notebookId = bookRef.current.id;
      setStatus("正在保存…");
      try {
        const saved = await request<NoteNode>("saveNote", {
          notebookId,
          id: draft.id,
          title: draft.title,
          body: draft.body,
          tags: draft.tags,
          favorite: !!draft.favorite,
          expectedRevision: draft.revision,
        });
        if (current.current?.id === saved.id) {
          const latest = current.current;
          const unchanged =
            latest.body === draft.body &&
            latest.title === draft.title &&
            JSON.stringify(latest.tags) === JSON.stringify(draft.tags) &&
            latest.favorite === draft.favorite;
          current.current = {
            ...latest,
            revision: saved.revision,
            updated_at: saved.updated_at,
          };
          dirty.current = !unchanged;
          setActive({ ...current.current });
          setStatus(unchanged ? "已保存至本地" : "有修改待保存");
        }
        if (bookRef.current?.id === notebookId)
          setNodes((items) =>
            items.map((n) =>
              n.id === saved.id
                ? {
                    ...n,
                    title: saved.title,
                    tags: saved.tags,
                    favorite: saved.favorite,
                    revision: saved.revision,
                    updated_at: saved.updated_at,
                  }
                : n,
            ),
          );
      } catch (e) {
        setStatus("保存失败 · 草稿已保留");
        report(e);
        throw e;
      }
    });
    saveQueue.current = next.catch(() => {});
    return next;
  }, []);
  /**
   * Modify the current note in place and mark it dirty.
   *
   * @param patch Fields to change.
   */
  const edit = (patch: Partial<NoteNode>) => {
    if (!current.current) return;
    current.current = { ...current.current, ...patch };
    dirty.current = true;
    setActive({ ...current.current });
    setStatus("有修改待保存");
  };
  useEffect(() => {
    if (!dirty.current || composition.current) return;
    const timer = setTimeout(() => {
      void flush().catch(() => {});
    }, 650);
    return () => clearTimeout(timer);
  }, [active, flush]);
  useEffect(() => {
    /** Try to save when the window loses focus. */
    const handler = () => {
      void flush().catch(() => {});
    };

    /**
     * Prompt the user to confirm leaving when there are unsaved changes.
     *
     * @param e Before-unload event.
     */
    const unload = (e: BeforeUnloadEvent) => {
      if (dirty.current) {
        e.preventDefault();
      }
    };
    window.addEventListener("blur", handler);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("blur", handler);
      window.removeEventListener("beforeunload", unload);
    };
  }, [flush]);
  const modeSequence = useRef(0);
  const contentRef = useRef<HTMLElement>(null);
  const scrollAnchor = useRef<number | null>(null);

  // Restore the reading position (as a relative ratio) after a mode switch so
  // long documents do not jump back to the top between preview/source/rich.
  useLayoutEffect(() => {
    const ratio = scrollAnchor.current;
    if (ratio == null) return;
    scrollAnchor.current = null;
    /** Apply the saved ratio once the mode's column has a real scroll range. */
    const apply = () => {
      const el = contentRef.current;
      if (!el) return false;
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 0) return false;
      const behavior = el.style.scrollBehavior;
      el.style.scrollBehavior = "auto";
      el.scrollTop = Math.round(ratio * max);
      el.style.scrollBehavior = behavior;
      return true;
    };
    // The new mode lays out asynchronously, so its scroll range may still be
    // empty; retry until the ratio lands, then stop instead of fighting the user.
    if (apply()) return;
    let frame = 0,
      ticks = 0;
    const retry = () => {
      if (!apply() && ticks++ < 30) frame = requestAnimationFrame(retry);
    };
    frame = requestAnimationFrame(retry);
    return () => cancelAnimationFrame(frame);
  }, [mode]);

  // Opening another note resets the viewport and drops any pending anchor.
  useLayoutEffect(() => {
    scrollAnchor.current = null;
    contentRef.current?.scrollTo({ top: 0 });
  }, [active?.id]);

  /**
   * Switch between preview/source/rich modes; very large bodies fall back to source.
   *
   * @param next Target mode.
   */
  const switchMode = async (next: "preview" | "source" | "rich") => {
    if (composition.current) return;
    const sequence = ++modeSequence.current,
      id = current.current?.id;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    try {
      await flush();
      if (sequence !== modeSequence.current || id !== current.current?.id)
        return;
      const target: "preview" | "source" | "rich" =
        new Blob([current.current?.body || ""]).size > 1024 ** 2
          ? "source"
          : next;
      if (target === mode) return;
      // Capture the reading position only when a real switch is about to happen,
      // so no stale anchor survives a no-op or sequence-cancelled switch.
      const el = contentRef.current;
      if (el) {
        const max = el.scrollHeight - el.clientHeight;
        scrollAnchor.current = max > 0 ? el.scrollTop / max : 0;
      }
      const started = performance.now();
      setMode(target);
      // Record the conversion latency once the new mode has painted. Only the
      // mode name and duration are sent, never any document content.
      requestAnimationFrame(() =>
        request("reportDiagnostic", {
          category: "editor",
          name: "editor.mode",
          outcome: "ok",
          code: target,
          durationMs: Math.round(performance.now() - started),
          notable: true,
        }).catch(() => {}),
      );
    } catch (e) {
      report(e);
    }
  };
  /**
   * Open a note: flush pending saves first, then load the body, expand ancestors, and record the recent visit.
   *
   * @param n Note node to open.
   * @param b Target Notebook.
   * @param anchor Optional PDF return anchor to restore in the reader.
   */
  const openNote = useCallback(
    async (n: NoteNode, b = bookRef.current, anchor = "") => {
      if (!b) return;
      try {
        await flush();
        const note = await request<NoteNode>("getNote", {
          notebookId: b.id,
          id: n.id,
        });
        current.current = note;
        dirty.current = false;
        // Anchor is keyed by note so a later tree-navigation cannot consume a
        // stale PDF return position.
        setPdfAnchor(anchor ? { noteId: n.id, anchor } : null);
        setActive(note);
        if (new Blob([note.body || ""]).size > 1024 ** 2) setMode("source");
        setView("notes");
        setTagFilter(null);
        setMenu(false);
        setSearchOpen(false);
        setStatus("已保存至本地");
        setError("");
        recent.current = [
          n.id,
          ...recent.current.filter((id) => id !== n.id),
        ].slice(0, 50);
        localStorage.setItem("anynote-recent", JSON.stringify(recent.current));
        let parent = n.parent_id;
        setExpanded((prev) => {
          const next = new Set(prev),
            seen = new Set<string>();
          while (parent && !seen.has(parent)) {
            seen.add(parent);
            next.add(parent);
            parent = nodeById.get(parent)?.parent_id || null;
          }
          return next;
        });
      } catch (e) {
        report(e);
      }
    },
    [flush, nodeById],
  );
  /**
   * Switch the current Notebook: flush, load the node tree, and open the first note.
   *
   * @param b Notebook to switch to.
   */
  const switchBook = async (b: Notebook) => {
    await flush();
    const items = await request<NoteNode[]>("listNodes", { notebookId: b.id });
    bookRef.current = b;
    setBook(b);
    setSwitcher(false);
    current.current = null;
    setActive(null);
    setView("notes");
    setTagFilter(null);
    localStorage.setItem("anynote-book", b.id);
    setNodes(items);
    setExpanded(
      new Set(items.filter((n) => n.kind === "folder").map((n) => n.id)),
    );
    const first = items.find((n) => n.kind === "note" && !n.deleted_at);
    if (first) await openNote(first, b);
  };
  /**
   * Accept a note created by a first-party hosted command: refresh the node tree and open it.
   *
   * @param note Created note.
   */
  const acceptHostedNote = async (note: NoteNode) => {
    const targetBook = book;
    if (!targetBook) return;
    await flush();
    if (bookRef.current?.id !== targetBook.id) return;
    const nodes = await request<NoteNode[]>("listNodes", {
      notebookId: targetBook.id,
    });
    if (bookRef.current?.id !== targetBook.id) return;
    setNodes(nodes);
    await openNote(note, targetBook);
    setView("notes");
    setToast("已创建阅读记录");
  };
  /**
   * Open a cross-database reference link (switching Notebooks first if needed).
   *
   * @param notebookId Target Notebook ID.
   * @param noteId Target note ID.
   * @param anchor Optional PDF return anchor carried by the link.
   */
  const openReference = async (
    notebookId: string,
    noteId: string,
    anchor = "",
  ) => {
    try {
      const targetBook = books.find((b) => b.id === notebookId);
      if (!targetBook) throw Error("链接所属 Notebook 尚未打开");
      const target = await request<NoteNode>("getNote", {
        notebookId,
        id: noteId,
      });
      if (target.deleted_at) throw Error("链接目标已在回收站");
      if (bookRef.current?.id !== notebookId) await switchBook(targetBook);
      await openNote(target, targetBook, anchor);
    } catch (e) {
      report(e);
    }
  };
  /**
   * Handle body links: internal anynote references, in-page anchors, or external links.
   *
   * @param href Link target.
   */
  const followLink = (href: string) => {
    const match = href.match(
      /^anynote:\/\/notebook\/([a-f0-9-]{36})\/note\/([a-f0-9-]{36})(?:#([^\s]+))?$/i,
    );
    if (match) {
      void openReference(match[1], match[2], match[3] || "");
      return;
    }
    if (href.startsWith("#"))
      document
        .getElementById(href.slice(1))
        ?.scrollIntoView({ behavior: "smooth" });
    else if (/^(https?:|mailto:)/.test(href))
      window.open(href, "_blank", "noopener,noreferrer");
  };
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let list = await request<Notebook[]>("listNotebooks");
        if (!list.length) {
          await seed();
          list = await request("listNotebooks");
        }
        if (cancelled) return;
        setBooks(list);
        const preferred =
          list.find(
            (b) =>
              b.id === localStorage.getItem("anynote-book") && !b.unavailable,
          ) || list.find((b) => !b.unavailable);
        // When every Notebook is unavailable, open the recovery wizard instead of a failed switch.
        if (preferred) {
          await switchBook(preferred);
          // Startup consistency inspection: read-only, budgeted and cancellable,
          // so it never blocks opening the Notebook.
          void request("inspectIntegrity", {
            notebookId: preferred.id,
          }).catch(() => {});
        } else if (list[0]) setRecovery(list[0]);
      } catch (e) {
        report(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!searchOpen || !book) return;
    let cancelled = false,
      requestId: string | undefined;
    setResults([]);
    setSearchInfo(null);
    setSearching(true);
    const timer = setTimeout(async () => {
      requestId = crypto.randomUUID();
      try {
        const data = await request<SearchResponse>("searchWorkspace", {
          requestId,
          query,
          ...(searchScope !== "all"
            ? {
                notebookIds: [
                  searchScope === "current" ? book.id : searchScope,
                ],
              }
            : {}),
          ...(searchType ? { noteType: searchType } : {}),
          ...(searchTag.trim() ? { tag: searchTag.trim() } : {}),
          ...(searchFolder ? { folderId: searchFolder } : {}),
          ...(searchAge
            ? { updatedAfter: Date.now() - Number(searchAge) * 86400000 }
            : {}),
          limit: query.trim() ? 100 : 20,
        });
        if (!cancelled && !data.cancelled) {
          setResults(data.results);
          setSearchInfo(data);
          setSearchIndex(0);
        }
      } catch (e) {
        if (!cancelled) report(e);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (requestId)
        void request("cancelSearch", { requestId }).catch(() => {});
    };
  }, [
    query,
    searchOpen,
    book,
    nodes,
    searchScope,
    searchType,
    searchTag,
    searchFolder,
    searchAge,
  ]);
  useEffect(() => {
    if (panel !== "history" || !active || !book) return;
    request<Revision[]>("history", { notebookId: book.id, id: active.id })
      .then(setRevisions)
      .catch(report);
  }, [panel, active?.revision, active?.id, book]);
  useEffect(() => {
    if (view === "backup" && book)
      request<Snapshot[]>("listSnapshots", { notebookId: book.id })
        .then(setSnapshots)
        .catch(report);
  }, [view, book]);
  useEffect(() => {
    setAsset(null);
    if (!active?.primary_resource_id || !book) return;
    if (active.note_type !== "pdf" && active.note_type !== "image") return;
    let cancelled = false;
    // The PDF and image readers load bytes on demand; the workspace only needs
    // metadata and the asset hash for version checks and downloads.
    request<{ mime: string; hash: string; size: number }>("getAssetInfo", {
      notebookId: book.id,
      id: active.primary_resource_id,
      noteId: active.id,
    })
      .then((r) => {
        if (!cancelled)
          setAsset({ ...r, data: "", bytes: new Uint8Array(), url: "" });
      })
      .catch(report);
    return () => {
      cancelled = true;
    };
  }, [active?.id, active?.primary_resource_id, active?.revision, book]);
  useEffect(() => {
    if (
      !modal &&
      !searchOpen &&
      !transfer &&
      !importOpen &&
      !tasksOpen &&
      !recovery
    )
      return;
    const previous = focusBeforeDialog.current;

    /**
     * Cycle Tab focus within the modal so focus cannot escape the dialog.
     *
     * @param e Keyboard event.
     */
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const dialog = document.querySelector<HTMLElement>("[role=dialog]");
      if (!dialog) return;
      const controls = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]',
        ),
      ).filter(
        (control) =>
          control.getClientRects().length && !control.closest("[hidden]"),
      );
      if (!controls.length) return;
      const first = controls[0],
        last = controls[controls.length - 1];
      if (
        e.shiftKey &&
        (document.activeElement === first ||
          !dialog.contains(document.activeElement))
      ) {
        e.preventDefault();
        last.focus();
      } else if (
        !e.shiftKey &&
        (document.activeElement === last ||
          !dialog.contains(document.activeElement))
      ) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", trap);
    return () => {
      window.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, [modal, searchOpen, transfer, importOpen, tasksOpen, recovery]);
  /**
   * Open a modal dialog and initialize its input fields.
   *
   * @param type Modal type.
   * @param target Optional target node.
   */
  const showModal = (type: Modal["type"], target?: NoteNode) => {
    setField(
      type === "rename"
        ? target?.title || ""
        : type === "tags"
          ? target?.tags.join(", ") || ""
          : "",
    );
    setModal({ type, target });
    setMenu(false);
  };
  useEffect(() => {
    /** Global shortcuts: ⌘/Ctrl+K and +P open search, +S saves, +N creates; Esc closes overlays. */
    const key = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        ["k", "p", "s", "n"].includes(e.key.toLowerCase())
      ) {
        e.preventDefault();
        if (e.key === "s") void flush().catch(() => {});
        else if (e.key === "n") showModal("note");
        else {
          setQuery("");
          setSearchOpen(true);
        }
      }
      if (e.key === "Escape") {
        setImportOpen(false);
        setTasksOpen(false);
        setModal(null);
        setSearchOpen(false);
        setMenu(false);
        setSwitcher(false);
        setRecovery(null);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [flush]);
  /**
   * Run a background action that flushes saves first, uniformly maintaining busy/error state.
   *
   * @param fn Action to run.
   */
  const task = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await flush();
      await fn();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };
  /**
   * After checking node freshness, open the cross-database copy/move dialog.
   *
   * @param node Node to transfer.
   * @param mode Transfer mode.
   * @returns The action promise.
   */
  const beginTransfer = (node: NoteNode, mode: "copy" | "move") =>
    task(async () => {
      if (!book) return;
      const fresh = (
        await request<NoteNode[]>("listNodes", { notebookId: book.id })
      ).find((n) => n.id === node.id && !n.deleted_at);
      if (!fresh) throw Error("源条目已变化，请刷新后重试");
      setModal(null);
      setMenu(false);
      setTransfer({ node: fresh, mode });
    });
  const parentId = active?.parent_id || null;
  /** Submit the modal dialog (create/rename/move/tag/video/Notebook). */
  const submit = async () => {
    if (!modal || !book) return;
    await task(async () => {
      if (modal.type === "video") {
        acceptSaved(
          await request<NoteNode>("insertVideo", {
            notebookId: book.id,
            id: current.current!.id,
            expectedRevision: current.current!.revision,
            url: field,
          }),
        );
        setModal(null);
        return;
      }
      if (modal.type === "renameNotebook") {
        const b = await request<Notebook>("renameNotebook", {
          notebookId: book.id,
          title: field,
        });
        setBooks(await request("listNotebooks"));
        bookRef.current = b;
        setBook(b);
        setModal(null);
        return;
      }
      if (modal.type === "notebook") {
        const b = await request<Notebook>("createNotebook", { title: field });
        setBooks(await request("listNotebooks"));
        setModal(null);
        await switchBook(b);
        return;
      }
      if (modal.type === "move") {
        await request("moveNode", {
          notebookId: book.id,
          id: modal.target?.id,
          parentId: field || null,
        });
        await reload(book.id);
        setModal(null);
        setToast("已移动");
        return;
      }
      if (modal.type === "rename" || modal.type === "tags") {
        const target = modal.target!;
        const patch =
          modal.type === "rename"
            ? { title: field }
            : {
                tags: field
                  .split(/[,，]/)
                  .map((t) => t.trim())
                  .filter(Boolean),
              };
        if (current.current?.id === target.id) {
          edit(patch);
          await flush();
        } else
          await request("saveNote", {
            notebookId: book.id,
            id: target.id,
            expectedRevision: target.revision,
            ...patch,
          });
        await reload(book.id);
        setModal(null);
        return;
      }
      const node = await request<NoteNode>("createNode", {
        notebookId: book.id,
        kind: modal.type === "folder" ? "folder" : "note",
        title: field,
        parentId: modal.target?.kind === "folder" ? modal.target.id : parentId,
      });
      await reload(book.id);
      setModal(null);
      if (node.kind === "note") {
        await openNote(node);
        setMode("source");
      } else setExpanded((prev) => new Set([...prev, node.id]));
    });
  };
  /** Export the full Notebook archive (desktop uses a file dialog, browser downloads directly). */
  const exportBook = () =>
    task(async () => {
      if (!book) return;
      if (window.anynote) {
        const job = await request<{ id: string } | null>("exportArchiveFile", {
          notebookId: book.id,
        });
        if (job) setTasksOpen(true);
        return;
      }
      const r = await request<{ data: string; name: string }>("exportArchive", {
        notebookId: book.id,
      });
      download(r.data, r.name);
      setToast("完整 Notebook 已导出，包含历史与回收站");
    });
  /**
   * Adopt the saved note returned by the server and refresh the node tree.
   *
   * @param n Saved note.
   */
  const acceptSaved = (n: NoteNode) => {
    current.current = n;
    dirty.current = false;
    setActive(n);
    setStatus("已保存至本地");
    void reload(bookRef.current!.id);
  };
  /**
   * Insert the selected images one by one as resources into the current note.
   *
   * @param files Selected files.
   */
  const insertImages = async (files: FileList | null) => {
    const picked = Array.from(files || []);
    await task(async () => {
      for (const file of picked) {
        if (file.size > 50 * 1024 * 1024) throw Error("图片超过50MB");
        const n = current.current;
        if (!n || !bookRef.current) return;
        const saved = await request<NoteNode>("addResource", {
          notebookId: bookRef.current.id,
          id: n.id,
          expectedRevision: n.revision,
          data: await base64(file),
          mime: file.type,
          name: file.name,
        });
        acceptSaved(saved);
      }
      setToast("图片已插入并保存至本地");
    });
  };
  /**
   * Import local files: md/txt become body notes, the rest become resource notes.
   *
   * @param files Selected files.
   */
  const importFiles = async (files: FileList | null) => {
    if (!files || !book) return;
    const picked = Array.from(files);
    await task(async () => {
      for (const file of picked) {
        if (file.size > 50 * 1024 * 1024) throw Error("单文件不能超过 50MB");
        let n: NoteNode;
        if (/\.(md|txt)$/i.test(file.name)) {
          n = await request("createNode", {
            notebookId: book.id,
            title: file.name.replace(/\.[^.]+$/, ""),
            body: await file.text(),
            parentId,
          });
        } else
          n = await request("importFile", {
            notebookId: book.id,
            name: file.name,
            data: await base64(file),
            mime: file.type,
            parentId,
          });
        await reload(book.id);
        await openNote(n);
      }
      setToast("资料已保存至本地");
    });
  };
  /** Choose a .anynote archive to import: desktop uses a file dialog, browser uses a file input. */
  const chooseArchive = () => {
    if (!window.anynote) {
      archiveInput.current?.click();
      return;
    }
    void task(async () => {
      const job = await request<{ id: string } | null>("importArchiveFile");
      if (job) setTasksOpen(true);
    });
  };
  /**
   * Import a `.anynote` file and switch to the new Notebook.
   *
   * @param file Archive file.
   */
  const importArchive = async (file: File | undefined) => {
    if (!file) return;
    await task(async () => {
      if (file.size > 100 * 1024 * 1024)
        throw Error("当前导入包不能超过 100MB");
      const r = await request<{ id: string }>("importArchive", {
          data: await base64(file),
        }),
        list = await request<Notebook[]>("listNotebooks");
      setBooks(list);
      await switchBook(list.find((b) => b.id === r.id)!);
      setToast("Notebook 已验证并导入");
    });
  };
  /**
   * Move a node to the trash.
   *
   * @param n Node to trash.
   */
  const trash = async (n: NoteNode) => {
    await task(async () => {
      if (!book) return;
      await request("trashNode", { notebookId: book.id, id: n.id });
      await reload(book.id);
      if (active?.id === n.id) {
        setActive(null);
        current.current = null;
      }
      setToast("已移入回收站，可随时恢复");
      setMenu(false);
    });
  };
  /**
   * Save before switching the main view and clear the tag filter.
   *
   * @param v Target view.
   */
  const navigate = async (v: View) => {
    try {
      await flush();
      setView(v);
      setTagFilter(null);
      setMenu(false);
    } catch (e) {
      report(e);
    }
  };
  /** Non-deleted nodes. */
  const visible = useMemo(() => nodes.filter((n) => !n.deleted_at), [nodes]),
    /** All tags in the current Notebook (deduplicated). */
    tags = useMemo(
      () => [...new Set(visible.flatMap((n) => n.tags))],
      [visible],
    );

  /** Flatten nodes into a tree with depth according to their expanded state. */
  const tree = useMemo(() => {
    const tree: { node: NoteNode; depth: number }[] = [],
      visited = new Set<string>();
    const children = new Map<string | null, NoteNode[]>();
    for (const n of visible) {
      const list = children.get(n.parent_id) || [];
      list.push(n);
      children.set(n.parent_id, list);
    }
    const stack = (children.get(null) || [])
      .toReversed()
      .map((node) => ({ node, depth: 0 }));
    while (stack.length) {
      const item = stack.pop()!;
      if (visited.has(item.node.id)) continue;
      visited.add(item.node.id);
      tree.push(item);
      if (item.node.kind === "folder" && expanded.has(item.node.id))
        for (const n of (children.get(item.node.id) || []).toReversed())
          stack.push({ node: n, depth: item.depth + 1 });
    }
    return tree;
  }, [visible, expanded]);
  useEffect(() => {
    if (!active || treeSelection.current === active.id) return;
    const index = tree.findIndex((item) => item.node.id === active.id);
    const el = treeRef.current;
    if (el && index >= 0) treeSelection.current = active.id;
    if (
      el &&
      index >= 0 &&
      (index * 36 < el.scrollTop ||
        (index + 1) * 36 > el.scrollTop + el.clientHeight)
    ) {
      el.scrollTop = Math.max(0, index * 36 - el.clientHeight / 2);
      setTreeScroll(el.scrollTop);
    }
  }, [active?.id, tree]);
  const treeStart =
      tree.length > 250
        ? Math.min(
            Math.max(0, tree.length - Math.ceil(treeHeight / 36)),
            Math.max(0, Math.floor(treeScroll / 36) - 8),
          )
        : 0,
    treeEnd =
      tree.length > 250
        ? Math.min(tree.length, treeStart + Math.ceil(treeHeight / 36) + 16)
        : tree.length;
  const ancestors: NoteNode[] = [];
  let p = active?.parent_id;
  const seen = new Set();
  while (p && !seen.has(p)) {
    seen.add(p);
    const n = nodeById.get(p);
    if (!n) break;
    ancestors.unshift(n);
    p = n.parent_id;
  }
  const headings = (active?.body || "")
    .split("\n")
    .filter((l) => /^#{1,3} /.test(l))
    .map((l, i) => ({
      title: l.replace(/^#+ /, ""),
      level: l.match(/^#+/)![0].length,
      id: "heading-" + i,
    }));
  const listView =
    view === "recent" ||
    view === "favorites" ||
    view === "trash" ||
    !!tagFilter;
  let list = nodes.filter(
    (n) =>
      n.kind === "note" && (view === "trash" ? !!n.deleted_at : !n.deleted_at),
  );
  if (view === "favorites") list = list.filter((n) => n.favorite);
  if (view === "recent")
    list = recent.current
      .map((id) => list.find((n) => n.id === id))
      .filter((n): n is NoteNode => !!n);
  if (tagFilter) list = list.filter((n) => n.tags.includes(tagFilter));
  return (
    <div className={"app " + (!sidebar ? "sidebar-hidden" : "")}>
      <input
        ref={imageInput}
        type="file"
        hidden
        multiple
        accept=".png,.jpg,.jpeg,.webp,.svg"
        onChange={(e) => {
          void insertImages(e.target.files);
          e.target.value = "";
        }}
      />
      {importOpen && book && (
        <ImportDialog
          notebookId={book.id}
          parentId={parentId}
          onClose={() => setImportOpen(false)}
          onImported={() => setToast("已导入并保存至本地")}
        />
      )}
      {tasksOpen && (
        <TaskCenter
          onRestored={async (id) => {
            const list = await request<Notebook[]>("listNotebooks");
            setBooks(list);
            await switchBook(list.find((b) => b.id === id)!);
            setTasksOpen(false);
          }}
          onClose={() => setTasksOpen(false)}
          onOpen={async (n, id) => {
            if (book?.id !== id) {
              const b = books.find((b) => b.id === id);
              if (b) await switchBook(b);
            }
            await reload(id);
            await openNote(
              n,
              books.find((b) => b.id === id),
            );
            setTasksOpen(false);
          }}
        />
      )}
      {recovery && (
        <RecoveryWizard
          notebook={recovery}
          onClose={() => setRecovery(null)}
          onStarted={() => setTasksOpen(true)}
          onRestored={async (id) => {
            const list = await request<Notebook[]>("listNotebooks");
            setBooks(list);
            setRecovery(null);
            await switchBook(list.find((b) => b.id === id)!);
            setToast("已从备份恢复为新的 Notebook");
          }}
        />
      )}
      {board && active && book && (
        <Suspense
          fallback={<div className="board-overlay empty">正在加载白板…</div>}
        >
          <WhiteboardEditor
            notebookId={book.id}
            note={active}
            block={board}
            onClose={() => setBoard(null)}
            onSave={acceptSaved}
          />
        </Suspense>
      )}
      <input
        ref={fileInput}
        type="file"
        hidden
        multiple
        accept=".md,.txt,.pdf,.png,.jpg,.jpeg,.webp,.svg"
        onChange={(e) => {
          void importFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={archiveInput}
        type="file"
        hidden
        accept=".anynote"
        onChange={(e) => {
          void importArchive(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {sidebar && (
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">
              <Leaf size={23} />
            </div>
            <span>
              anynote<span className="brand-dot">.</span>
            </span>
            <button
              className="icon-button sidebar-close"
              onClick={() => setSidebar(false)}
              aria-label="收起侧栏"
            >
              <PanelLeft size={17} />
            </button>
          </div>
          <div className="notebook-wrap">
            <button
              className="notebook-switch"
              onClick={() => setSwitcher(!switcher)}
            >
              <span className="book-icon">
                <BookOpen size={19} />
              </span>
              <span>
                <strong>{book?.name || "正在打开…"}</strong>
                <small>
                  {book?.external ? "外部 Notebook" : "个人 Notebook"}
                </small>
              </span>
              <ChevronsUpDown size={15} />
            </button>
            {switcher && (
              <div className="popover book-popover">
                {books.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => {
                      setSwitcher(false);
                      // Damaged Notebooks cannot be switched to; open the recovery wizard instead.
                      if (b.unavailable) setRecovery(b);
                      else void task(() => switchBook(b));
                    }}
                  >
                    {b.unavailable ? (
                      <RotateCcw size={16} />
                    ) : (
                      <BookOpen size={16} />
                    )}
                    {b.name}
                    {b.unavailable
                      ? "（目录不可用，点击恢复）"
                      : b.external
                        ? " · 外部"
                        : ""}
                    {b.id === book?.id && <Check size={15} />}
                  </button>
                ))}
                <div className="divider" />
                <button
                  onClick={() => {
                    setSwitcher(false);
                    showModal("notebook");
                  }}
                >
                  <Plus size={16} />
                  创建 Notebook
                </button>
                <button
                  onClick={() => {
                    setSwitcher(false);
                    chooseArchive();
                  }}
                >
                  <Upload size={16} />
                  导入 Notebook
                </button>
              </div>
            )}
          </div>
          <button
            className="search-trigger"
            aria-label="搜索笔记"
            onClick={() => {
              setSearchOpen(true);
              setQuery("");
            }}
          >
            <Search size={16} />
            <span>搜索笔记</span>
            <kbd>⌘ K</kbd>
          </button>
          <nav className="nav-main">
            <button
              className={view === "recent" ? "selected" : ""}
              onClick={() => void navigate("recent")}
            >
              <Clock size={17} />
              最近打开
            </button>
            <button
              className={view === "favorites" ? "selected" : ""}
              onClick={() => void navigate("favorites")}
            >
              <Star size={17} />
              我的收藏
              <span className="nav-count">
                {visible.filter((n) => n.favorite).length || ""}
              </span>
            </button>
          </nav>
          <div className="section-label">
            <span>知识花园</span>
            <div>
              <button onClick={() => showModal("folder")} aria-label="新建目录">
                <FolderPlus size={15} />
              </button>
              <button onClick={() => showModal("note")} aria-label="新建笔记">
                <Plus size={16} />
              </button>
            </div>
          </div>
          <div
            className="tree"
            role={visible.length ? "tree" : undefined}
            aria-label="Notebook 目录"
            ref={treeRef}
            onKeyDown={(e) => {
              const control = (e.target as HTMLElement).closest<HTMLElement>(
                ".tree-main",
              );
              if (!control) return;
              const index = tree.findIndex(
                (row) => row.node.id === control.dataset.nodeId,
              );
              if (index < 0) return;
              const row = tree[index];
              let next = index;
              if (e.key === "ArrowDown") next++;
              else if (e.key === "ArrowUp") next--;
              else if (e.key === "Home") next = 0;
              else if (e.key === "End") next = tree.length - 1;
              else if (e.key === "ArrowRight") {
                if (row.node.kind === "folder" && !expanded.has(row.node.id))
                  setExpanded((prev) => new Set([...prev, row.node.id]));
                else if (tree[index + 1]?.depth > row.depth) next++;
              } else if (e.key === "ArrowLeft") {
                if (row.node.kind === "folder" && expanded.has(row.node.id))
                  setExpanded((prev) => {
                    const result = new Set(prev);
                    result.delete(row.node.id);
                    return result;
                  });
                else if (row.node.parent_id)
                  next = tree.findIndex(
                    (item) => item.node.id === row.node.parent_id,
                  );
              } else return;
              e.preventDefault();
              const sequence = ++treeFocusSequence.current;
              const target = tree[Math.max(0, Math.min(tree.length - 1, next))];
              if (!target) return;
              const el = treeRef.current;
              if (
                el &&
                (next * 36 < el.scrollTop ||
                  (next + 1) * 36 > el.scrollTop + el.clientHeight)
              ) {
                el.scrollTop = Math.max(0, next * 36 - el.clientHeight / 2);
                setTreeScroll(el.scrollTop);
              }
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  if (sequence !== treeFocusSequence.current) return;
                  document
                    .querySelector<HTMLElement>(
                      `.tree-main[data-node-id="${CSS.escape(target.node.id)}"]`,
                    )
                    ?.focus();
                }),
              );
            }}
            onScroll={(e) => setTreeScroll(e.currentTarget.scrollTop)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              if (e.target !== e.currentTarget) return;
              const id = e.dataTransfer.getData("anynote-node");
              if (id)
                void task(async () => {
                  await request("moveNode", {
                    notebookId: book?.id,
                    id,
                    parentId: null,
                  });
                  await reload(book!.id);
                });
            }}
          >
            <div style={{ height: treeStart * 36 }} />
            {tree.slice(treeStart, treeEnd).map(({ node: n, depth }) => (
              <div
                role="treeitem"
                aria-label={n.title}
                aria-level={depth + 1}
                aria-selected={active?.id === n.id}
                aria-expanded={
                  n.kind === "folder" ? expanded.has(n.id) : undefined
                }
                className={
                  "tree-row " +
                  (active?.id === n.id && view === "notes" && !tagFilter
                    ? "active"
                    : "")
                }
                key={n.id}
                draggable
                onDragStart={(e) =>
                  e.dataTransfer.setData("anynote-node", n.id)
                }
                onDragOver={(e) => {
                  e.preventDefault();
                  const box = e.currentTarget.getBoundingClientRect(),
                    ratio = (e.clientY - box.top) / box.height;
                  setDropHint({
                    id: n.id,
                    position:
                      ratio < 0.25
                        ? "before"
                        : ratio > 0.75 || n.kind !== "folder"
                          ? "after"
                          : "inside",
                  });
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node))
                    setDropHint(null);
                }}
                onDragEnd={() => setDropHint(null)}
                data-drop={
                  dropHint?.id === n.id ? dropHint.position : undefined
                }
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const id = e.dataTransfer.getData("anynote-node"),
                    source = nodes.find((x) => x.id === id),
                    hint = dropHint;
                  setDropHint(null);
                  if (!source || id === n.id) return;
                  void task(async () => {
                    const siblings = nodes.filter(
                        (x) =>
                          !x.deleted_at &&
                          x.parent_id === n.parent_id &&
                          x.id !== id,
                      ),
                      next =
                        siblings[siblings.findIndex((x) => x.id === n.id) + 1];
                    const saved = await request<NoteNode>("placeNode", {
                      notebookId: book?.id,
                      id,
                      parentId:
                        hint?.position === "inside" ? n.id : n.parent_id,
                      beforeId:
                        hint?.position === "inside"
                          ? null
                          : hint?.position === "before"
                            ? n.id
                            : next?.id || null,
                      expectedRevision:
                        current.current?.id === id
                          ? current.current.revision
                          : source.revision,
                    });
                    if (active?.id === id) acceptSaved(saved);
                    await reload(book!.id);
                    if (hint?.position === "inside")
                      setExpanded((prev) => new Set([...prev, n.id]));
                  });
                }}
                title={[...ancestors.map((a) => a.title), n.title].join(" / ")}
                style={{ paddingLeft: 12 + Math.min(depth, 4) * 12 }}
              >
                <button
                  className="tree-main"
                  data-node-id={n.id}
                  aria-expanded={
                    n.kind === "folder" ? expanded.has(n.id) : undefined
                  }
                  onClick={() => {
                    if (n.kind === "folder")
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        next.has(n.id) ? next.delete(n.id) : next.add(n.id);
                        return next;
                      });
                    else void openNote(n);
                  }}
                >
                  {n.kind === "folder" ? (
                    expanded.has(n.id) ? (
                      <ChevronDown className="tree-chevron" size={12} />
                    ) : (
                      <ChevronRight className="tree-chevron" size={12} />
                    )
                  ) : (
                    <span className="tree-spacer" />
                  )}
                  {icon(n)}
                  <span>
                    {depth > 4 && (
                      <small className="tree-depth" aria-hidden="true">
                        {depth + 1}层 ·{" "}
                      </small>
                    )}
                    {n.title}
                  </span>
                </button>
                <button
                  className="tree-action"
                  aria-label={n.title + "操作"}
                  onClick={() => showModal("rename", n)}
                >
                  <MoreHorizontal size={14} />
                </button>
              </div>
            ))}
            <div style={{ height: (tree.length - treeEnd) * 36 }} />
            {!visible.length && (
              <p className="tree-empty">
                从一篇笔记开始
                <br />
                <button onClick={() => showModal("note")}>
                  创建第一篇笔记
                </button>
              </p>
            )}
          </div>
          <div className="section-label tag-label">
            <span>标签</span>
            <Hash size={13} />
          </div>
          <div className="sidebar-tags">
            {tags.length ? (
              tags.map((t) => (
                <button
                  className={tagFilter === t ? "active" : ""}
                  key={t}
                  onClick={() => {
                    setTagFilter(t);
                    setView("notes");
                  }}
                >
                  <span className="tag-dot" />
                  {t}
                </button>
              ))
            ) : (
              <span className="muted">为笔记添加标签，连接想法</span>
            )}
          </div>
          <div className="sidebar-bottom">
            <button
              className={view === "trash" ? "selected" : ""}
              onClick={() => void navigate("trash")}
            >
              <Trash2 size={16} />
              回收站
              <span className="nav-count">
                {nodes.filter((n) => n.deleted_at).length || ""}
              </span>
            </button>
            <div className="divider" />
            <button
              className="backup-link"
              onClick={() => void navigate("backup")}
            >
              <span className="local-status">
                <HardDrive size={16} />
              </span>
              <span>
                <strong>本地优先，安心记录</strong>
                <small>你的知识，始终属于你</small>
              </span>
              <ChevronRight size={14} />
            </button>
            <div className="bottom-actions">
              <button onClick={() => void navigate("settings")}>
                <Settings size={16} />
                设置
              </button>
              <button
                onClick={() => void navigate("extensions")}
                aria-label="扩展"
              >
                <Puzzle size={16} />
              </button>
              <button onClick={() => setDark(!dark)} aria-label="切换主题">
                {dark ? <Sun size={16} /> : <Moon size={16} />}
              </button>
            </div>
          </div>
        </aside>
      )}
      <main className="workspace">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button"
              onClick={() => setSidebar(!sidebar)}
              aria-label="切换侧栏"
            >
              <PanelLeft size={17} />
            </button>
            <span className="breadcrumb-root">{book?.name || "Notebook"}</span>
            {ancestors.slice(-2).map((n) => (
              <React.Fragment key={n.id}>
                <ChevronRight size={12} />
                <span>{n.title}</span>
              </React.Fragment>
            ))}
          </div>
          <div className="topbar-right">
            <span className="local-chip">
              <span />
              本地空间
            </span>
            <button
              className={"icon-button " + (panel ? "pressed" : "")}
              onClick={() => setPanel(panel ? null : "outline")}
              aria-label="切换辅助面板"
            >
              <PanelRight size={17} />
            </button>
            <button
              className="icon-button"
              onClick={() => setMenu(!menu)}
              aria-label="更多操作"
            >
              <MoreHorizontal size={20} />
            </button>
            {menu && (
              <div className="popover note-menu">
                {active && (
                  <>
                    <button onClick={() => showModal("rename", active)}>
                      <FileText size={15} />
                      重命名
                    </button>
                    <button onClick={() => showModal("move", active)}>
                      <Move size={15} />
                      移动到目录
                    </button>
                    <button onClick={() => void beginTransfer(active, "copy")}>
                      复制到其他 Notebook
                    </button>
                    <button onClick={() => void beginTransfer(active, "move")}>
                      移动到其他 Notebook
                    </button>
                    <button onClick={() => showModal("tags", active)}>
                      <Hash size={15} />
                      编辑标签
                    </button>
                    <button
                      onClick={() => {
                        setPanel("history");
                        setMenu(false);
                      }}
                    >
                      <History size={15} />
                      版本历史
                    </button>
                    <button
                      onClick={() => {
                        download(
                          btoa(unescape(encodeURIComponent(active.body || ""))),
                          active.title + ".md",
                          "text/markdown",
                        );
                        setMenu(false);
                      }}
                    >
                      <Download size={15} />
                      导出 Markdown
                    </button>
                    <div className="divider" />
                    <button
                      className="danger"
                      onClick={() => void trash(active)}
                    >
                      <Trash2 size={15} />
                      移入回收站
                    </button>
                  </>
                )}
                <button onClick={() => void exportBook()}>
                  <Download size={15} />
                  导出完整 Notebook
                </button>
              </div>
            )}
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            {dirty.current && (
              <>
                <button onClick={() => void flush().catch(() => {})}>
                  重试保存
                </button>
                <button
                  onClick={() =>
                    download(
                      btoa(
                        unescape(
                          encodeURIComponent(current.current?.body || ""),
                        ),
                      ),
                      "未保存草稿.md",
                      "text/markdown",
                    )
                  }
                >
                  下载草稿
                </button>
              </>
            )}
            <button onClick={() => setError("")} aria-label="关闭错误">
              <X size={16} />
            </button>
          </div>
        )}
        <div className="content-layout">
          <section className="main-content" ref={contentRef}>
            {listView ? (
              <div className="collection page">
                <span className="eyebrow">YOUR KNOWLEDGE GARDEN</span>
                <h1>
                  {tagFilter
                    ? "# " + tagFilter
                    : view === "favorites"
                      ? "值得反复回看的想法"
                      : view === "trash"
                        ? "回收站"
                        : "最近，读过与写过"}
                </h1>
                <p className="page-intro">
                  {view === "trash"
                    ? "暂时放下的内容，还可以重新找回来。"
                    : "每一次重访，都可能生长出新的理解。"}{" "}
                  · {list.length} 篇笔记
                </p>
                {view === "trash" &&
                  nodes
                    .filter((n) => n.kind === "folder" && n.deleted_at)
                    .map((n) => (
                      <div className="collection-row" key={n.id}>
                        {icon(n, 20)}
                        <span>
                          {n.title}
                          <small>目录</small>
                        </span>
                        <button
                          className="secondary"
                          onClick={() =>
                            void task(async () => {
                              await request("restoreNode", {
                                notebookId: book?.id,
                                id: n.id,
                              });
                              await reload(book!.id);
                              setToast("目录已恢复");
                            })
                          }
                        >
                          <RotateCcw size={14} />
                          恢复
                        </button>
                      </div>
                    ))}
                {list.map((n) => (
                  <div className="collection-row" key={n.id}>
                    {icon(n, 20)}
                    <button
                      disabled={view === "trash"}
                      onClick={() => void openNote(n)}
                    >
                      <strong>{n.title}</strong>
                      <small>
                        {date(n.updated_at)} ·{" "}
                        {n.note_type === "markdown"
                          ? "Markdown 笔记"
                          : n.note_type === "pdf"
                            ? "PDF 文档"
                            : "图片笔记"}
                      </small>
                    </button>
                    {view === "trash" ? (
                      <button
                        className="secondary"
                        onClick={() =>
                          void task(async () => {
                            await request("restoreNode", {
                              notebookId: book?.id,
                              id: n.id,
                            });
                            await reload(book!.id);
                            setToast("笔记已恢复");
                          })
                        }
                      >
                        <RotateCcw size={14} />
                        恢复
                      </button>
                    ) : (
                      <ArrowUpRight size={16} />
                    )}
                  </div>
                ))}
                {!list.length && (
                  <div className="empty">
                    <Leaf size={36} />
                    <h2>
                      {view === "trash" ? "这里干干净净" : "这里，等待新的想法"}
                    </h2>
                    <p>从左侧打开一篇笔记，或记录新的灵感。</p>
                  </div>
                )}
              </div>
            ) : view === "backup" ? (
              <div className="page">
                <span className="eyebrow">SAFE & LOCAL</span>
                <h1>让知识，有一份安心的备份</h1>
                <p className="page-intro">
                  先在本地写好每一个想法，再为它们留一条回家的路。
                </p>
                <div className="feature-card">
                  <div className="feature-icon">
                    <HardDrive size={24} />
                  </div>
                  <div>
                    <h3>本地快照</h3>
                    <p>保存完整的 Notebook、附件、历史与回收站。</p>
                  </div>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void task(async () => {
                        await request("snapshot", { notebookId: book?.id });
                        setSnapshots(
                          await request("listSnapshots", {
                            notebookId: book?.id,
                          }),
                        );
                        setToast("本地快照已完成并校验");
                      })
                    }
                  >
                    <Plus size={15} />
                    创建快照
                  </button>
                </div>
                <div className="feature-card">
                  <div className="feature-icon">
                    <Download size={24} />
                  </div>
                  <div>
                    <h3>完整导入与导出</h3>
                    <p>以 .anynote 文件带走知识，在新空间重新打开。</p>
                  </div>
                  <button className="secondary" onClick={chooseArchive}>
                    导入
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void exportBook()}
                  >
                    导出
                  </button>
                </div>
                <h2 className="subheading">
                  本地快照记录 <span>{snapshots.length}</span>
                </h2>
                {snapshots.length ? (
                  snapshots.map((s) => (
                    <div className="snapshot-row" key={s.createdAt}>
                      <History size={17} />
                      <span>
                        {new Date(s.createdAt).toLocaleString("zh-CN")}
                      </span>
                      <span className="verified">
                        <Check size={14} />
                        已完成
                      </span>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          void task(async () => {
                            const r = await request<{ id: string }>(
                              "restoreSnapshot",
                              {
                                notebookId: book?.id,
                                name: s.createdAt + ".anynote",
                              },
                            );
                            const list =
                              await request<Notebook[]>("listNotebooks");
                            setBooks(list);
                            await switchBook(list.find((b) => b.id === r.id)!);
                            setToast("快照已恢复为新的 Notebook");
                          })
                        }
                      >
                        <RotateCcw size={13} />
                        恢复副本
                      </button>
                    </div>
                  ))
                ) : (
                  <p className="muted">
                    还没有快照。创建第一份，让知识多一层保护。
                  </p>
                )}
                <LocalCleanup
                  notebookId={book!.id}
                  onCleaned={() => {
                    void request<Snapshot[]>("listSnapshots", {
                      notebookId: book!.id,
                    })
                      .then(setSnapshots)
                      .catch(report);
                  }}
                />
                <LocalBackup
                  notebookId={book!.id}
                  beforeBackup={async () => {
                    if (composition.current)
                      throw Error(
                        "请完成当前输入后再立即备份；自动备份仅捕获已保存内容。",
                      );
                    await flush();
                  }}
                  onStarted={() => setTasksOpen(true)}
                />
                <BackupTargets
                  notebookId={book!.id}
                  onStarted={() => setTasksOpen(true)}
                  onRestored={async (id) => {
                    const list = await request<Notebook[]>("listNotebooks");
                    setBooks(list);
                    await switchBook(list.find((b) => b.id === id)!);
                  }}
                />
                <CloudBackup
                  notebookId={book!.id}
                  onStarted={() => setTasksOpen(true)}
                  onRestored={async (id) => {
                    const list = await request<Notebook[]>("listNotebooks");
                    setBooks(list);
                    await switchBook(list.find((b) => b.id === id)!);
                  }}
                />
                <p className="small-note">
                  本地快照保存在同一磁盘。建议定期导出至其他设备。远端备份状态独立于本地保存。
                </p>
              </div>
            ) : view === "extensions" ? (
              <ExtensionPage
                notebookId={book!.id}
                onCreated={acceptHostedNote}
              />
            ) : view === "settings" ? (
              <div className="page">
                <span className="eyebrow">MAKE YOURSELF AT HOME</span>
                <h1>你的空间，你的习惯</h1>
                <p className="page-intro">
                  让每一次打开，都更接近你喜欢的样子。
                </p>
                <CloudRecovery onStarted={() => setTasksOpen(true)} />
                <Diagnostics />
                <div className="setting-row">
                  <div>
                    <h3>外观</h3>
                    <p>温暖浅色，或安静深色。</p>
                  </div>
                  <button className="secondary" onClick={() => setDark(!dark)}>
                    {dark ? <Sun size={16} /> : <Moon size={16} />}切换为
                    {dark ? "浅色" : "深色"}
                  </button>
                </div>
                <div className="setting-row">
                  <div>
                    <h3>Notebook</h3>
                    <p>每个主题拥有独立的本地数据库与资源。</p>
                  </div>
                  <button
                    className="secondary"
                    onClick={() => showModal("renameNotebook")}
                  >
                    重命名 Notebook
                  </button>
                  <button
                    className="secondary"
                    onClick={() => showModal("notebook")}
                  >
                    <Plus size={16} />
                    创建 Notebook
                  </button>
                </div>
                <div className="setting-row">
                  <div>
                    <h3>外部 Notebook</h3>
                    <p>打开已有目录，在原位置编辑；关闭应用后释放写锁。</p>
                  </div>
                  <button
                    className="secondary"
                    disabled={!window.anynote}
                    title={
                      !window.anynote ? "请在桌面应用中打开目录" : undefined
                    }
                    onClick={() =>
                      void task(async () => {
                        const selected = await request<Notebook | null>(
                          "openNotebookDirectory",
                        );
                        if (!selected) return;
                        setBooks(await request<Notebook[]>("listNotebooks"));
                        await switchBook(selected);
                        setToast("已打开 Notebook 原目录");
                      })
                    }
                  >
                    <FolderOpen size={16} />
                    打开 Notebook 目录
                  </button>
                </div>
                {books
                  .filter((b) => b.external)
                  .map((externalBook) => (
                    <div className="setting-row" key={externalBook.id}>
                      <div>
                        <h3>{externalBook.name}</h3>
                        <p>
                          {externalBook.unavailable
                            ? "目录不可用；可以重新连接磁盘，或移出工作区后重新选择。"
                            : "已登记的外部目录；原文件始终保留。"}
                        </p>
                      </div>
                      <button
                        className="secondary"
                        aria-label={"移出工作区：" + externalBook.name}
                        onClick={() =>
                          void task(async () => {
                            const wasActive =
                              bookRef.current?.id === externalBook.id;
                            await request("detachNotebookDirectory", {
                              notebookId: externalBook.id,
                            });
                            let remaining =
                              await request<Notebook[]>("listNotebooks");
                            if (!remaining.some((b) => !b.unavailable)) {
                              await request("createNotebook", {
                                title: "我的知识库",
                              });
                              remaining = await request("listNotebooks");
                            }
                            setBooks(remaining);
                            if (wasActive) {
                              dirty.current = false;
                              current.current = null;
                              setActive(null);
                              setNodes([]);
                              await switchBook(
                                remaining.find((b) => !b.unavailable) ||
                                  remaining[0],
                              );
                            }
                            setToast("已移出工作区，原目录保留");
                          })
                        }
                      >
                        移出工作区
                      </button>
                    </div>
                  ))}
                {books
                  .filter((b) => b.unavailable)
                  .map((damaged) => (
                    <div className="setting-row" key={"recovery-" + damaged.id}>
                      <div>
                        <h3>{damaged.name} · 需要恢复</h3>
                        <p>
                          {damaged.error ||
                            "Notebook 无法打开；可进入只读诊断与恢复向导。"}
                        </p>
                      </div>
                      <button
                        className="secondary"
                        onClick={() => setRecovery(damaged)}
                      >
                        诊断与恢复
                      </button>
                    </div>
                  ))}
                <div className="setting-row">
                  <div>
                    <h3>数据迁移</h3>
                    <p>导出包含历史与回收站，不包含设备凭据。</p>
                  </div>
                  <button
                    className="secondary"
                    onClick={() => void exportBook()}
                  >
                    导出完整 Notebook
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      void task(async () => {
                        const r = await request<{ data: string; name: string }>(
                          "exportMarkdown",
                          { notebookId: book?.id },
                        );
                        download(r.data, r.name);
                        setToast("开放格式导出已完成");
                      })
                    }
                  >
                    导出 Markdown 文件夹
                  </button>
                </div>
                <div className="about">
                  <div className="brand-mark">
                    <Leaf size={23} />
                  </div>
                  <h3>Anynote</h3>
                  <p>0.1.0 · 本地知识库预览版</p>
                  <p>让想法扎根，让知识生长。</p>
                </div>
              </div>
            ) : active ? (
              <>
                <div className="document-toolbar">
                  <div className="note-type">
                    {icon(active, 14)}
                    <span>
                      {active.note_type === "markdown"
                        ? "Markdown 笔记"
                        : active.note_type === "pdf"
                          ? "PDF 文档"
                          : "图片笔记"}
                    </span>
                  </div>
                  <div className="document-actions">
                    {active.note_type === "markdown" && (
                      <>
                        <button
                          className="icon-button"
                          title="插入本地图片"
                          aria-label="插入本地图片"
                          onClick={() => imageInput.current?.click()}
                        >
                          <ImageIcon size={16} />
                        </button>
                        <button
                          className="icon-button"
                          title="插入白板"
                          aria-label="插入白板"
                          onClick={() =>
                            void task(async () =>
                              setBoard({ blockId: crypto.randomUUID() }),
                            )
                          }
                        >
                          <Puzzle size={16} />
                        </button>
                        <button
                          className="icon-button"
                          title="插入视频"
                          aria-label="插入视频"
                          onClick={() => showModal("video")}
                        >
                          <Plus size={16} />
                        </button>
                      </>
                    )}

                    {active.note_type === "markdown" && (
                      <div className="mode-switch">
                        <button
                          className={mode === "preview" ? "chosen" : ""}
                          onClick={() => {
                            void switchMode("preview");
                          }}
                        >
                          <Eye size={14} />
                          阅读
                        </button>
                        <button
                          className={mode === "rich" ? "chosen" : ""}
                          onClick={() => {
                            void switchMode("rich");
                          }}
                        >
                          富文本 Beta
                        </button>
                        <button
                          className={mode === "source" ? "chosen" : ""}
                          onClick={() => {
                            void switchMode("source");
                          }}
                        >
                          <Code2 size={14} />
                          源码
                        </button>
                      </div>
                    )}
                    <button
                      className={
                        "icon-button " + (active.favorite ? "favorited" : "")
                      }
                      aria-label={active.favorite ? "取消收藏" : "收藏笔记"}
                      onClick={() =>
                        edit({ favorite: active.favorite ? 0 : 1 })
                      }
                    >
                      <Star
                        size={17}
                        fill={active.favorite ? "currentColor" : "none"}
                      />
                    </button>
                    <button
                      className="icon-button"
                      onClick={() => setSidebar(!sidebar)}
                      aria-label="专注模式"
                    >
                      <Maximize2 size={16} />
                    </button>
                  </div>
                </div>
                <article
                  className={
                    "document " +
                    (active.note_type !== "markdown" ? "media-document" : "")
                  }
                  onCompositionStart={() => (composition.current = true)}
                  onCompositionEnd={() => {
                    composition.current = false;
                    void flush().catch(() => {});
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    void importFiles(e.dataTransfer.files);
                  }}
                >
                  <div className="doc-eyebrow">
                    <span className="tiny-dot" />
                    {active.favorite
                      ? "留给未来的自己"
                      : "让一个想法，慢慢生长"}
                  </div>
                  <h1>
                    <input
                      aria-label="笔记标题"
                      value={active.title}
                      onChange={(e) => edit({ title: e.target.value })}
                      onBlur={() => void flush().catch(() => {})}
                    />
                  </h1>
                  <div className="doc-meta">
                    <span>
                      <Clock size={13} />
                      {date(active.updated_at)}更新
                    </span>
                    <span className="meta-dot">·</span>
                    <span>
                      {active.note_type === "markdown"
                        ? `${(active.body || "").replace(/\s/g, "").length.toLocaleString()} 字`
                        : "原件保存在本地"}
                    </span>
                    <div className="doc-tags">
                      {active.tags.map((t) => (
                        <button key={t} onClick={() => setTagFilter(t)}>
                          # {t}
                        </button>
                      ))}
                      <button
                        className="tag-add"
                        onClick={() => showModal("tags", active)}
                      >
                        <Plus size={12} />
                        {active.tags.length ? "" : "添加标签"}
                      </button>
                    </div>
                  </div>
                  {active.source_uri && (
                    <div className="source-line">
                      来源：
                      <a
                        href={active.source_uri}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {active.source_uri}
                      </a>
                      <button onClick={() => setTasksOpen(true)}>
                        查看导入任务
                      </button>
                    </div>
                  )}
                  {active.note_type === "markdown" && book && (
                    <ImportReport notebookId={book.id} noteId={active.id} />
                  )}
                  <div className="doc-divider" />
                  {active.note_type === "markdown" &&
                    new Blob([active.body || ""]).size > 1024 ** 2 && (
                      <p className="large-document-notice" role="status">
                        文档超过 1MB，已使用源码模式以保持编辑流畅。
                      </p>
                    )}
                  {active.note_type === "markdown" ? (
                    mode === "source" ||
                    new Blob([active.body || ""]).size > 1024 ** 2 ? (
                      <div
                        className="source-editor"
                        ref={sourceRef}
                        onCompositionStart={() => (composition.current = true)}
                        onCompositionEnd={() => {
                          composition.current = false;
                          void flush().catch(() => {});
                        }}
                      >
                        <Suspense
                          fallback={<p className="muted">正在打开编辑器…</p>}
                        >
                          <SourceEditor
                            key={active.id}
                            value={active.body || ""}
                            dark={dark}
                            onChange={(value) => edit({ body: value })}
                          />
                        </Suspense>
                      </div>
                    ) : mode === "rich" ? (
                      <Suspense
                        fallback={
                          <p className="muted">正在加载富文本编辑器…</p>
                        }
                      >
                        <RichEditor
                          notebookId={book!.id}
                          note={active}
                          onChange={(body) => edit({ body })}
                          onLink={followLink}
                          onBoard={(b) => void task(async () => setBoard(b))}
                          onCompositionState={(value) =>
                            (composition.current = value)
                          }
                          onSource={() => void switchMode("source")}
                        />
                      </Suspense>
                    ) : (
                      <DocumentView
                        notebookId={book!.id}
                        note={active}
                        onBoard={(b) => void task(async () => setBoard(b))}
                        onLink={followLink}
                        onFetchMeta={(blockId, url) =>
                          void task(async () => {
                            acceptSaved(
                              await request<NoteNode>("fetchVideoMeta", {
                                notebookId: book!.id,
                                id: current.current!.id,
                                expectedRevision: current.current!.revision,
                                blockId,
                                url,
                              }),
                            );
                            setToast("已获取标题与缩略图并保存至本地");
                          })
                        }
                      />
                    )
                  ) : asset ? (
                    active.note_type === "image" ? (
                      <Suspense
                        fallback={
                          <div className="empty">正在加载图片阅读器…</div>
                        }
                      >
                        <ImageReader
                          key={active.id}
                          notebookId={book!.id}
                          noteId={active.id}
                          resourceId={active.primary_resource_id!}
                          assetHash={asset.hash}
                          size={asset.size || 0}
                          mime={asset.mime}
                          title={active.title}
                          note={active}
                          onSaved={acceptSaved}
                        />
                      </Suspense>
                    ) : (
                      <>
                        <div className="asset-download">
                          <button
                            className="secondary"
                            onClick={() =>
                              void task(async () => {
                                const r = await request<{
                                  data: string;
                                  mime: string;
                                }>("getAsset", {
                                  notebookId: book!.id,
                                  id: active.primary_resource_id,
                                  noteId: active.id,
                                });
                                download(r.data, active.title, r.mime);
                              })
                            }
                          >
                            <Download size={14} />
                            下载原始 PDF
                          </button>
                        </div>
                        <Suspense
                          fallback={
                            <div className="empty">正在加载阅读器…</div>
                          }
                        >
                          <PdfReader
                            key={active.id}
                            resourceId={active.primary_resource_id!}
                            size={asset.size!}
                            notebookId={book!.id}
                            noteId={active.id}
                            assetHash={asset.hash}
                            noteTitle={active.title}
                            anchor={
                              pdfAnchor?.noteId === active.id
                                ? pdfAnchor.anchor
                                : undefined
                            }
                            onAnchorConsumed={() => setPdfAnchor(null)}
                            onOpenNote={(id) =>
                              void openReference(book!.id, id)
                            }
                          />
                        </Suspense>
                      </>
                    )
                  ) : (
                    <div className="empty">
                      <LoaderCircle className="spin" />
                      <p>正在读取本地资源…</p>
                    </div>
                  )}
                  <Backlinks
                    notebookId={book!.id}
                    note={active}
                    onOpen={(id, notebookId) =>
                      void openReference(notebookId, id)
                    }
                  />
                  <footer className="document-end">
                    <Leaf size={14} />
                    <span>每一次记录，都是一次生长。</span>
                  </footer>
                </article>
              </>
            ) : (
              <div className="empty welcome-empty">
                <div className="empty-mark">
                  <Leaf size={44} />
                </div>
                <span className="eyebrow">A QUIET PLACE FOR YOUR IDEAS</span>
                <h1>从一个想法开始</h1>
                <p>
                  这里是你的数字书桌。
                  <br />
                  写下灵感，收藏资料，让知识慢慢生长。
                </p>
                <div>
                  <button className="primary" onClick={() => showModal("note")}>
                    <Plus size={16} />
                    写一篇笔记
                  </button>
                  <button
                    className="secondary"
                    onClick={() => fileInput.current?.click()}
                  >
                    <Upload size={16} />
                    导入资料
                  </button>
                </div>
              </div>
            )}
          </section>
          {panel && view === "notes" && !tagFilter && active && (
            <aside className="aux-panel">
              <div className="panel-heading">
                <button
                  className={panel === "outline" ? "active" : ""}
                  onClick={() => setPanel("outline")}
                >
                  大纲
                </button>
                <button
                  className={panel === "history" ? "active" : ""}
                  onClick={() => setPanel("history")}
                >
                  历史
                </button>
                <button
                  className="icon-button"
                  onClick={() => setPanel(null)}
                  aria-label="关闭辅助面板"
                >
                  <X size={15} />
                </button>
              </div>
              {panel === "outline" ? (
                <>
                  <span className="section-label">在这篇笔记里</span>
                  {headings.length ? (
                    headings.map((h) => (
                      <button
                        className="outline-row"
                        style={{ paddingLeft: 20 + (h.level - 1) * 12 }}
                        key={h.id}
                        onClick={() => {
                          setMode("preview");
                          setTimeout(
                            () =>
                              document.getElementById(h.id)?.scrollIntoView({
                                behavior: "smooth",
                                block: "start",
                              }),
                            50,
                          );
                        }}
                      >
                        {h.title}
                      </button>
                    ))
                  ) : (
                    <p className="panel-muted">
                      使用 Markdown 标题，建立清晰的思考脉络。
                    </p>
                  )}
                  <div className="panel-tip">
                    <Leaf size={18} />
                    <p>
                      整理知识的过程，
                      <br />
                      也是整理思考的过程。
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <p className="panel-muted">
                    保存时记录正文、资源、标题、标签与收藏。旧版本没有元数据时保留当前元数据。恢复会生成一个新版本。
                  </p>
                  {revisions.map((r) => (
                    <div className="revision-card" key={r.id}>
                      <strong>
                        {new Date(r.created_at).toLocaleString("zh-CN")}
                      </strong>
                      <p>
                        {r.metadata?.title || "旧版正文"} ·{" "}
                        {r.body.slice(0, 80) || "空白笔记"}
                      </p>
                      <small>
                        {r.metadata?.tags.map((t) => "#" + t).join(" ")}
                        {r.metadata?.favorite ? " · 已收藏" : ""}
                      </small>
                      <button
                        onClick={() =>
                          void task(async () => {
                            await request("restoreRevision", {
                              notebookId: book?.id,
                              id: active.id,
                              revisionId: r.id,
                              expectedRevision: current.current?.revision,
                            });
                            await openNote(active);
                            setToast("已恢复历史版本");
                          })
                        }
                      >
                        <RotateCcw size={12} />
                        恢复此版本
                      </button>
                    </div>
                  ))}
                </>
              )}
            </aside>
          )}
        </div>
        <footer className="statusbar">
          <div>
            <span className="status-dot" />
            {busy ? "正在处理…" : status}
          </div>
          <div>
            <button onClick={() => fileInput.current?.click()}>
              <Upload size={12} />
              导入资料
            </button>
            <button onClick={() => setImportOpen(true)}>
              网页 / HTML 导入
            </button>
            <button onClick={() => setTasksOpen(true)}>任务中心</button>
            <span className="status-separator" />
            <span>Markdown · UTF-8</span>
            <button onClick={() => void navigate("backup")} title="查看备份">
              <HardDrive size={13} />
            </button>
          </div>
        </footer>
      </main>
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
      {busy && (
        <div className="task-indicator">
          <LoaderCircle className="spin" size={15} />
          正在处理，请稍候
        </div>
      )}
      {searchOpen && (
        <div
          className="modal-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSearchOpen(false);
          }}
        >
          <div
            className="command-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="搜索笔记"
          >
            <div className="command-input">
              <Search size={21} />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="寻找一个想法，或一篇笔记…"
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSearchIndex((i) => Math.min(results.length - 1, i + 1));
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSearchIndex((i) => Math.max(0, i - 1));
                  }
                  if (e.key === "Enter" && results[searchIndex])
                    void openReference(
                      results[searchIndex].notebookId,
                      results[searchIndex].id,
                    );
                }}
              />
              <button onClick={() => setSearchOpen(false)}>
                <kbd>ESC</kbd>
              </button>
            </div>
            <div className="search-filters">
              <select
                aria-label="搜索范围"
                value={searchScope}
                onChange={(e) => {
                  setSearchScope(e.target.value);
                  setSearchFolder("");
                }}
              >
                <option value="current">当前 Notebook</option>
                <option value="all">所有 Notebook</option>
                {books.map((b) => (
                  <option value={b.id} key={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="笔记类型筛选"
                value={searchType}
                onChange={(e) => setSearchType(e.target.value)}
              >
                <option value="">所有类型</option>
                <option value="markdown">Markdown</option>
                <option value="pdf">PDF</option>
                <option value="image">图片</option>
              </select>
              <select
                aria-label="目录筛选"
                value={searchFolder}
                disabled={searchScope !== "current" && searchScope !== book?.id}
                onChange={(e) => setSearchFolder(e.target.value)}
              >
                <option value="">所有目录</option>
                {nodes
                  .filter((n) => n.kind === "folder" && !n.deleted_at)
                  .map((n) => (
                    <option value={n.id} key={n.id}>
                      {n.title}
                    </option>
                  ))}
              </select>
              <input
                aria-label="标签筛选"
                placeholder="标签"
                maxLength={40}
                value={searchTag}
                onChange={(e) => setSearchTag(e.target.value)}
              />
              <select
                aria-label="更新时间筛选"
                value={searchAge}
                onChange={(e) => setSearchAge(e.target.value)}
              >
                <option value="">全部时间</option>
                <option value="7">最近 7 天</option>
                <option value="30">最近 30 天</option>
                <option value="90">最近 90 天</option>
              </select>
            </div>
            {searchInfo?.truncated && (
              <p className="search-notice">
                已达到结果或时间预算，请缩小范围或增加关键词。
              </p>
            )}
            {!!searchInfo?.warnings.length && (
              <p className="search-notice" role="status">
                {searchInfo.warnings.length} 个 Notebook 未能搜索：
                {searchInfo.warnings
                  .map(
                    (w) =>
                      (books.find((b) => b.id === w.notebookId)?.name ||
                        w.notebookId) +
                      "（" +
                      w.message +
                      "）",
                  )
                  .join("；")}
              </p>
            )}
            <div className="command-label">
              {searching ? "正在搜索…" : query ? "搜索结果" : "快速打开"}
              <span>{results.length} 篇</span>
            </div>
            <div className="command-results">
              {results.map((n, i) => (
                <button
                  className={i === searchIndex ? "selected" : ""}
                  key={n.notebookId + n.id}
                  onMouseEnter={() => setSearchIndex(i)}
                  onClick={() => void openReference(n.notebookId, n.id)}
                >
                  {icon(n, 20)}
                  <span>
                    <strong>{n.title}</strong>
                    <small>
                      {n.notebookName} · {n.path}
                    </small>
                    {n.snippet && <small>{n.snippet}</small>}
                  </span>
                  <ArrowUpRight size={15} />
                </button>
              ))}
              {!searching && !results.length && (
                <div className="empty">
                  <Search size={28} />
                  <p>没有找到这个想法。换一个关键词试试。</p>
                </div>
              )}
            </div>
            {book && (
              <ExtensionCommands
                notebookId={book.id}
                onHostedRun={async (extensionId, commandId) => {
                  await flush();
                  const note = await request<NoteNode>(
                    "executeHostedExtensionCommand",
                    { notebookId: book.id, extensionId, commandId },
                  );
                  if (bookRef.current?.id !== book.id) return;
                  await acceptHostedNote(note);
                  setSearchOpen(false);
                }}
                onRun={async (command) => {
                  await flush();
                  const note = current.current;
                  if (!note || note.note_type !== "markdown")
                    throw Error("请先打开 Markdown 笔记");
                  const saved = await request<NoteNode>("runExtensionCommand", {
                    notebookId: book.id,
                    extensionId: command.extensionId,
                    checksum: command.checksum,
                    commandId: command.id,
                    id: note.id,
                    expectedRevision: note.revision,
                    operationId: crypto.randomUUID(),
                  });
                  acceptSaved(saved);
                  setSearchOpen(false);
                  setView("notes");
                  setToast("已运行扩展命令");
                }}
              />
            )}
            <div className="command-footer">
              <span>↑ ↓ 选择 · ↵ 打开</span>
              <button
                onClick={() => {
                  setSearchOpen(false);
                  showModal("note");
                }}
              >
                <Plus size={14} />
                新建笔记
              </button>
            </div>
          </div>
        </div>
      )}
      {transfer && book && (
        <NotebookTransferDialog
          books={books}
          source={book}
          node={transfer.node}
          mode={transfer.mode}
          onClose={() => setTransfer(null)}
          onComplete={async (result) => {
            await reload(book.id);
            if (
              result.status === "completed" &&
              transfer.mode === "move" &&
              active &&
              result.nodeMap[active.id]
            ) {
              setActive(null);
              current.current = null;
            }
            setTransfer(null);
            setToast(
              result.status === "copied-source-changed"
                ? "副本已保存，源条目有新修改，未移入回收站"
                : result.status === "copied-target-changed"
                  ? "目标副本已变化，源条目保留原位"
                  : `${result.count} 个条目已${transfer.mode === "copy" ? "复制" : "移动"}到目标 Notebook`,
            );
          }}
        />
      )}
      {modal && (
        <div
          className="modal-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          <form
            className="form-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="条目操作"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="dialog-heading">
              <div className="feature-icon">
                {modal.type === "notebook" ? (
                  <BookOpen size={22} />
                ) : modal.type === "folder" ? (
                  <FolderPlus size={22} />
                ) : modal.type === "move" ? (
                  <Move size={22} />
                ) : (
                  <FileText size={22} />
                )}
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setModal(null)}
                aria-label="关闭"
              >
                <X size={18} />
              </button>
            </div>
            <h2>
              {
                {
                  note: "让新的想法扎根",
                  folder: "为知识留一个位置",
                  notebook: "开辟一片新的知识花园",
                  rename: "给它一个新的名字",
                  move: "把想法放在合适的位置",
                  tags: "让知识彼此连接",
                  video: "插入视频链接",
                  renameNotebook: "重命名 Notebook",
                }[modal.type]
              }
            </h2>
            <p>
              {modal.type === "notebook"
                ? "独立保存，自由生长。无需账号，始终属于你。"
                : modal.type === "tags"
                  ? "使用逗号分隔标签，例如：阅读，灵感，项目"
                  : "用一个容易记住的名字，开始你的下一步。"}
            </p>
            <label>
              {modal.type === "move"
                ? "目标目录"
                : modal.type === "tags"
                  ? "标签"
                  : "名称"}
              {modal.type === "move" ? (
                <select
                  autoFocus
                  value={field}
                  onChange={(e) => setField(e.target.value)}
                >
                  <option value="">Notebook 根目录</option>
                  {visible
                    .filter(
                      (n) => n.kind === "folder" && n.id !== modal.target?.id,
                    )
                    .map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.title}
                      </option>
                    ))}
                </select>
              ) : (
                <input
                  autoFocus
                  required={modal.type !== "tags"}
                  maxLength={240}
                  placeholder={
                    modal.type === "tags" ? "阅读，灵感" : "输入一个名称…"
                  }
                  value={field}
                  onChange={(e) => setField(e.target.value)}
                />
              )}
            </label>
            {modal.type === "rename" && modal.target && (
              <div className="dialog-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void beginTransfer(modal.target!, "copy")}
                >
                  复制到其他 Notebook
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void beginTransfer(modal.target!, "move")}
                >
                  移动到其他 Notebook
                </button>
              </div>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setModal(null)}
              >
                取消
              </button>
              <button className="primary" type="submit" disabled={busy}>
                {busy
                  ? "正在保存…"
                  : modal.type === "rename" || modal.type === "tags"
                    ? "保存"
                    : modal.type === "move"
                      ? "移动"
                      : "创建"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
// Mount the app root component.
createRoot(document.getElementById("root")!).render(<App />);
