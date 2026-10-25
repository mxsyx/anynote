import { ExtensionError } from "./contracts.js";
import type {
  AnynoteAPI,
  PageRequest,
  SecretRef,
  NotebookInfo,
  Page,
  NodeSummary,
  NoteSnapshot,
  NoteRevision,
} from "./contracts.js";

/** Each wire method has a concrete input shape; untrusted results always start as unknown. */
export interface TransportInputs {
  "notebooks.current": Record<string, never>;
  "nodes.list": NonNullable<Parameters<AnynoteAPI["nodes"]["list"]>[0]>;
  "nodes.move": Parameters<AnynoteAPI["nodes"]["move"]>[0];
  "nodes.trash": { id: string };
  "notes.get": { id: string };
  "notes.create": Parameters<AnynoteAPI["notes"]["create"]>[0];
  "notes.applyPatch": Parameters<AnynoteAPI["notes"]["applyPatch"]>[0];
  "notes.history": { id: string };
  "search.query": { query: string };
  "search.page": PageRequest & { query: string };
  "assets.read": Parameters<AnynoteAPI["assets"]["read"]>[0];
  "assets.addImage": Parameters<AnynoteAPI["assets"]["addImage"]>[0];
  "settings.get": { key: string };
  "settings.set": { key: string; value: unknown };
  "secrets.get": SecretRef;
  "secrets.set": SecretRef & { value: string };
  "secrets.delete": SecretRef;
}
export type TransportMethod = keyof TransportInputs;
export interface TransportResults {
  "notebooks.current": NotebookInfo;
  "nodes.list": Page<NodeSummary>;
  "nodes.move": NodeSummary;
  "nodes.trash": boolean;
  "notes.get": NoteSnapshot;
  "notes.create": NoteSnapshot;
  "notes.applyPatch": NoteSnapshot;
  "notes.history": NoteRevision[];
  "search.query": NoteSnapshot[];
  "search.page": Page<NoteSnapshot>;
  "assets.read": { data: string; mime: string; hash: string };
  "assets.addImage": NoteSnapshot;
  "settings.get": unknown;
  "settings.set": boolean;
  "secrets.get": string | null;
  "secrets.set": boolean;
  "secrets.delete": boolean;
}
export type TransportResult<K extends TransportMethod> = TransportResults[K];
export type Transport = <K extends TransportMethod>(
  method: K,
  input: TransportInputs[K],
) => Promise<unknown>;

type Guard<T> = (value: unknown) => value is T;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string";
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const boolean = (value: unknown): value is boolean =>
  typeof value === "boolean";
const array =
  <T>(item: Guard<T>): Guard<T[]> =>
  (value): value is T[] => {
    if (!Array.isArray(value)) return false;
    for (const entry of value) if (!item(entry)) return false;
    return true;
  };
const strings = array(string);
const note: Guard<NoteSnapshot> = (value): value is NoteSnapshot =>
  record(value) &&
  string(value.id) &&
  string(value.title) &&
  string(value.body) &&
  count(value.revision) &&
  value.revision > 0 &&
  string(value.head_revision_id) &&
  strings(value.tags) &&
  string(value.note_type);
const node: Guard<NodeSummary> = (value): value is NodeSummary =>
  record(value) &&
  string(value.id) &&
  (value.parentId === null || string(value.parentId)) &&
  (value.kind === "folder" || value.kind === "note") &&
  string(value.title) &&
  count(value.revision) &&
  value.revision > 0 &&
  (value.noteType === undefined ||
    (typeof value.noteType === "string" &&
      ["markdown", "image", "pdf"].includes(value.noteType))) &&
  strings(value.tags) &&
  boolean(value.favorite) &&
  count(value.updatedAt) &&
  count(value.createdAt) &&
  (value.deletedAt === null || count(value.deletedAt));
const page =
  <T>(item: Guard<T>): Guard<Page<T>> =>
  (value): value is Page<T> =>
    record(value) &&
    array(item)(value.items) &&
    (value.nextCursor === null || string(value.nextCursor));

/** Portable validators keep the published SDK free of runtime dependencies. */
const results: { [K in TransportMethod]: Guard<TransportResults[K]> } = {
  "notebooks.current": (value): value is NotebookInfo =>
    record(value) && string(value.id) && string(value.name),
  "nodes.list": page(node),
  "nodes.move": node,
  "nodes.trash": boolean,
  "notes.get": note,
  "notes.create": note,
  "notes.applyPatch": note,
  "notes.history": array(
    (value): value is NoteRevision =>
      record(value) &&
      string(value.id) &&
      string(value.body) &&
      count(value.createdAt) &&
      string(value.actor),
  ),
  "search.query": array(note),
  "search.page": page(note),
  "assets.read": (value): value is TransportResults["assets.read"] =>
    record(value) &&
    string(value.data) &&
    string(value.mime) &&
    string(value.hash),
  "assets.addImage": note,
  "settings.get": (_value): _value is unknown => true,
  "settings.set": boolean,
  "secrets.get": (value): value is string | null =>
    value === null || string(value),
  "secrets.set": boolean,
  "secrets.delete": boolean,
};

export function parseTransportResult<K extends TransportMethod>(
  method: K,
  value: unknown,
): TransportResult<K> {
  const validate: Guard<TransportResult<K>> = results[method];
  if (!validate(value))
    throw new ExtensionError("internal", `宿主返回了无效的 ${method} 结果`);
  return value;
}

/** Host-authorized storage channel used by first-party feature adapters. */
export type OperationTransport = (
  operation: string,
  input: Record<string, unknown>,
) => Promise<unknown>;
