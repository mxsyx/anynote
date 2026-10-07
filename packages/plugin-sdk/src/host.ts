import type { ExtensionContext } from "./contracts.js";

export type { ExtensionContext } from "./contracts.js";

import { z } from "zod";
import type { Storage } from "@anynote/storage-sqlite/index.js";
import type { SqlRow } from "@anynote/types/runtime.js";
import { CommandRegistry, ExtensionError, createAPI } from "./index.js";
import type {
  APIBindings,
  Disposable,
  ExtensionEvent,
  ExtensionEventHandler,
  ExtensionEventName,
  NodeSummary,
  ProviderRegistration,
  TaskRegistration,
  UIContribution,
} from "./contracts.js";

const uuid = z.string().uuid(),
  key = z.string().regex(/^[a-zA-Z0-9._:-]{1,240}$/),
  providerId = z.string().regex(/^[a-z][a-z0-9.-]{2,100}$/),
  secretKey = z.string().regex(/^[a-zA-Z0-9._:-]{1,120}$/);

/** Permissions a trusted first-party extension may declare. */
const permissions = [
  "notes:read",
  "notes:write",
  "assets:read",
  "assets:write",
  "search:read",
  "settings:read",
  "settings:write",
  "notebooks:read",
  "nodes:read",
  "nodes:write",
  "secrets:read",
  "secrets:write",
  "events:subscribe",
  "tasks:register",
  "ui:contribute",
  "providers:register",
] as const;

const manifestSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9.-]{2,100}$/),
    name: z.string().max(120),
    version: z.string().regex(/^0\.1\.\d+$/),
    runtime: z.literal("trusted-first-party"),
    permissions: z.array(z.enum(permissions)).max(24),
  })
  .strict();

const uiSchema = z
  .object({
    id: z.string().max(160),
    slot: z.enum(["panel", "settings", "nodeView", "status"]),
    title: z.string().min(1).max(120),
    description: z.string().max(400).optional(),
  })
  .strict();

const providerSchema = z
  .object({
    id: z.string().max(160),
    kind: z.enum(["search", "backup", "ai", "importer", "exporter"]),
    title: z.string().min(1).max(120),
  })
  .strict();

const pageSchema = z
  .object({
    cursor: z.string().max(80).nullable().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

/** Per-"extension" runtime session holding capabilities, registrations and disposers. */
interface ExtensionSession {
  active: boolean;
  disposers: (() => unknown)[];
  subscribers: Map<ExtensionEventName, Set<ExtensionEventHandler>>;
  tasks: Map<string, TaskRegistration>;
  ui: Map<string, UIContribution>;
  providers: Map<string, ProviderRegistration>;
}

/** Map a storage node row into the portable directory-tree summary. */
function toNodeSummary(n: SqlRow): NodeSummary {
  return {
    id: n.id,
    parentId: n.parent_id ?? null,
    kind: n.kind,
    title: n.title,
    revision: n.revision,
    noteType: n.note_type ?? undefined,
    tags: Array.isArray(n.tags) ? n.tags : [],
    favorite: n.favorite === 1 || n.favorite === true,
    updatedAt: n.updated_at,
    createdAt: n.created_at,
    deletedAt: n.deleted_at ?? null,
  };
}

/**
 * Slice a stable, id-sorted list into one cursor page.
 *
 * @param items Full list.
 * @param request Cursor and limit.
 * @returns The page and the next cursor.
 */
function paginate<T extends { id: string }>(
  items: T[],
  request: { cursor?: string | null; limit?: number },
): { items: T[]; nextCursor: string | null } {
  const sorted = items.toSorted((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  let start = 0;
  if (request.cursor) {
    const index = sorted.findIndex((item) => item.id === request.cursor);
    if (index < 0) throw new ExtensionError("invalid", "分页游标无效");
    start = index + 1;
  }
  const limit = request.limit ?? 50,
    page = sorted.slice(start, start + limit),
    nextCursor =
      start + limit < sorted.length ? (page.at(-1)?.id ?? null) : null;
  return { items: page, nextCursor };
}

/**
 * Create a first-party extension host.
 *
 * The host must explicitly trust factories bundled with the app and never
 * loads arbitrary plugin files; every host call passes through a permission
 * and Notebook-scope façade, so renderer-provided notebook IDs, paths, SQL,
 * and actor identity cannot cross that boundary.
 *
 * @param storage Storage service (via `run`).
 * @param options Host options (trusted extension IDs).
 * @returns The extension host API.
 */
export function createExtensionHost(
  storage: Pick<Storage, "run">,
  { trustedIds = [] }: { trustedIds?: string[] } = {},
) {
  const commands = new CommandRegistry(),
    sessions = new Map<string, ExtensionSession>();

  /** Build a disposable and register its disposer on the session. */
  const disposable = (
    session: ExtensionSession,
    fn: () => void,
  ): Disposable => {
    session.disposers.push(fn);
    return { dispose: fn };
  };

  return {
    commands,

    /**
     * Activate an extension after validating its manifest and grant, returning its API and deactivation function.
     *
     * @param manifest Extension manifest row.
     * @param grant Extension grant row.
     * @param factory Trusted extension factory.
     * @returns The activated session API.
     */
    async activate(
      manifest: SqlRow,
      grant: SqlRow,
      factory: (context: ExtensionContext) => unknown | Promise<unknown>,
    ) {
      const m = manifestSchema.parse(manifest),
        notebookId = uuid.parse(grant.notebookId);
      if (!trustedIds.includes(m.id)) throw Error("未获信任的扩展来源");
      if (sessions.has(m.id)) throw Error("扩展已激活");
      const allowed = new Set(grant.permissions);
      if (m.permissions.some((p) => !allowed.has(p)))
        throw Error("扩展权限未授权");
      const session: ExtensionSession = {
        active: true,
        disposers: [],
        subscribers: new Map(),
        tasks: new Map(),
        ui: new Map(),
        providers: new Map(),
      };
      sessions.set(m.id, session);

      /** Run all disposers in reverse to revoke extension capabilities, aggregating errors on failure. */
      const cleanup = () => {
        if (!session.active) return;
        session.active = false;
        const errors: unknown[] = [];
        for (const fn of session.disposers.toReversed())
          try {
            fn();
          } catch (e) {
            errors.push(e);
          }
        if (sessions.get(m.id) === session) sessions.delete(m.id);
        if (errors.length)
          throw new AggregateError(errors, "扩展清理失败，能力已撤销");
      };

      /** Throw a coded permission error. */
      const deny = (message = "扩展没有此操作权限") => {
        throw new ExtensionError("denied", message);
      };

      /** Deliver a mutation event to subscribers; a throwing subscriber never breaks the caller. */
      const emit = (name: ExtensionEventName, nodeId: string) => {
        const subscribers = session.subscribers.get(name);
        if (!subscribers?.size) return;
        const event: ExtensionEvent = {
          name,
          notebookId,
          nodeId,
          at: Date.now(),
        };
        for (const handler of subscribers)
          try {
            handler(event);
          } catch {}
      };

      /**
       * Dispatch an extension call to storage operations per the permission policy, strictly validating arguments.
       *
       * @param method Host method name.
       * @param raw Raw method input.
       * @returns The method result.
       */
      const transport = async (method: string, raw: unknown) => {
        if (!session.active) throw new ExtensionError("denied", "扩展已停用");
        const policy: Record<string, (typeof permissions)[number]> = {
          "notebooks.current": "notebooks:read",
          "nodes.list": "nodes:read",
          "nodes.move": "nodes:write",
          "nodes.trash": "nodes:write",
          "notes.get": "notes:read",
          "notes.create": "notes:write",
          "notes.applyPatch": "notes:write",
          "notes.history": "notes:read",
          "search.query": "search:read",
          "search.page": "search:read",
          "assets.read": "assets:read",
          "assets.addImage": "assets:write",
          "settings.get": "settings:read",
          "settings.set": "settings:write",
          "secrets.get": "secrets:read",
          "secrets.set": "secrets:write",
          "secrets.delete": "secrets:write",
        };
        const required = policy[method];
        if (!required || !m.permissions.includes(required))
          throw new ExtensionError("denied", "扩展没有此操作权限");
        // Renderer-provided notebook IDs, paths, SQL, and actor identity cannot cross this façade.
        const base = { notebookId };
        if (method === "notebooks.current") {
          z.object({})
            .strict()
            .parse(raw ?? {});
          const books = (await storage.run("listNotebooks")) as {
            id: string;
            name: string;
          }[];
          const found = books.find((book) => book.id === notebookId);
          if (!found) throw new ExtensionError("not_found", "Notebook 不可用");
          return { id: found.id, name: found.name };
        }
        if (method === "nodes.list") {
          const p = pageSchema
            .extend({
              parentId: uuid.nullable().optional(),
              kind: z.enum(["folder", "note"]).optional(),
            })
            .strict()
            .parse(raw ?? {});
          const rows = (await storage.run("listNodes", {
            ...base,
          })) as SqlRow[];
          const filtered = rows.filter(
            (row) =>
              row.deleted_at == null &&
              (p.parentId === undefined ||
                (row.parent_id ?? null) === p.parentId) &&
              (p.kind === undefined || row.kind === p.kind),
          );
          return paginate(filtered.map(toNodeSummary), p);
        }
        if (method === "nodes.move") {
          const p = z
            .object({ id: uuid, parentId: uuid.nullable() })
            .strict()
            .parse(raw);
          const node = await storage.run("moveNode", { ...base, ...p });
          emit("node.moved", p.id);
          return toNodeSummary(node);
        }
        if (method === "nodes.trash") {
          const p = z.object({ id: uuid }).strict().parse(raw);
          const result = await storage.run("trashNode", { ...base, ...p });
          emit("node.trashed", p.id);
          return result;
        }
        if (method === "notes.get")
          return storage.run("getNote", {
            ...base,
            ...z.object({ id: uuid }).strict().parse(raw),
          });
        if (method === "notes.create") {
          const note = await storage.run("createNode", {
            ...base,
            ...z
              .object({
                title: z.string().min(1).max(240),
                body: z.string().max(2_000_000).optional(),
                parentId: uuid.nullable().optional(),
              })
              .strict()
              .parse(raw),
          });
          emit("note.created", note.id);
          return note;
        }
        if (method === "notes.applyPatch") {
          const p = z
            .object({
              id: uuid,
              expectedRevision: z.number().int().positive(),
              body: z.string().max(2_000_000),
              operationId: uuid,
            })
            .strict()
            .parse(raw);
          const note = await storage.run("extensionPatch", {
            ...base,
            extensionId: m.id,
            ...p,
          });
          emit("note.updated", p.id);
          return note;
        }
        if (method === "notes.history") {
          const p = z.object({ id: uuid }).strict().parse(raw);
          const rows = (await storage.run("history", {
            ...base,
            ...p,
          })) as SqlRow[];
          return rows.map((row) => ({
            id: row.id,
            body: row.body,
            createdAt: row.created_at,
            actor: row.actor ?? "user",
          }));
        }
        if (method === "search.query")
          return storage.run("search", {
            ...base,
            ...z
              .object({ query: z.string().max(300) })
              .strict()
              .parse(raw),
          });
        if (method === "search.page") {
          const p = pageSchema
            .extend({ query: z.string().max(300) })
            .strict()
            .parse(raw);
          const results = (await storage.run("search", {
            ...base,
            query: p.query,
          })) as { id: string }[];
          return paginate(results, p);
        }
        if (method === "assets.read")
          return storage.run("getAsset", {
            ...base,
            ...z
              .object({ id: uuid, noteId: uuid, revisionId: uuid.optional() })
              .strict()
              .parse(raw),
          });
        if (method === "assets.addImage")
          return storage.run("addResource", {
            ...base,
            ...z
              .object({
                id: uuid,
                expectedRevision: z.number().int().positive(),
                data: z.string().max(28_000_000),
                mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
                name: z.string().max(240),
              })
              .strict()
              .parse(raw),
          });
        if (method === "settings.get")
          return storage.run("extensionGetState", {
            ...base,
            extensionId: m.id,
            ...z.object({ key }).strict().parse(raw),
          });
        if (method === "settings.set")
          return storage.run("extensionSetState", {
            ...base,
            extensionId: m.id,
            ...z
              .object({
                key,
                value: z
                  .unknown()
                  .refine(
                    (v) => JSON.stringify(v)?.length <= 100000,
                    "状态大小超限",
                  ),
              })
              .strict()
              .parse(raw),
          });
        if (method === "secrets.get") {
          const p = z
            .object({ provider: providerId, key: secretKey })
            .strict()
            .parse(raw);
          const value = await storage.run("extensionGetState", {
            ...base,
            extensionId: m.id,
            key: `secret:${p.provider}:${p.key}`,
          });
          return typeof value === "string" ? value : null;
        }
        if (method === "secrets.set") {
          const p = z
            .object({
              provider: providerId,
              key: secretKey,
              value: z.string().max(8192),
            })
            .strict()
            .parse(raw);
          return storage.run("extensionSetState", {
            ...base,
            extensionId: m.id,
            key: `secret:${p.provider}:${p.key}`,
            value: p.value,
          });
        }
        if (method === "secrets.delete") {
          const p = z
            .object({ provider: providerId, key: secretKey })
            .strict()
            .parse(raw);
          return storage.run("extensionDeleteState", {
            ...base,
            extensionId: m.id,
            key: `secret:${p.provider}:${p.key}`,
          });
        }
        throw new ExtensionError("unsupported", "扩展操作未实现");
      };

      /** In-process bindings for push/registration extension points. */
      const bindings: APIBindings = {
        events: (name, handler) => {
          if (!m.permissions.includes("events:subscribe"))
            deny("扩展没有事件订阅权限");
          if (typeof handler !== "function")
            throw new ExtensionError("invalid", "事件处理器无效");
          const subscribers =
            session.subscribers.get(name) ?? new Set<ExtensionEventHandler>();
          subscribers.add(handler);
          session.subscribers.set(name, subscribers);
          return disposable(session, () => {
            subscribers.delete(handler);
            if (!subscribers.size) session.subscribers.delete(name);
          });
        },
        tasks: (task) => {
          if (!m.permissions.includes("tasks:register"))
            deny("扩展没有任务注册权限");
          if (
            typeof task?.run !== "function" ||
            typeof task.title !== "string" ||
            !task.title ||
            task.title.length > 120 ||
            typeof task.id !== "string" ||
            !task.id.startsWith(m.id + ".") ||
            !/^[a-z][a-z0-9.-]{2,160}$/.test(task.id)
          )
            throw new ExtensionError("invalid", "任务定义无效");
          if (session.tasks.has(task.id))
            throw new ExtensionError("conflict", "任务已注册");
          session.tasks.set(task.id, task);
          return disposable(session, () => session.tasks.delete(task.id));
        },
        ui: (contribution) => {
          if (!m.permissions.includes("ui:contribute"))
            deny("扩展没有 UI 贡献权限");
          const parsed = uiSchema.parse(contribution);
          if (!parsed.id.startsWith(m.id + "."))
            throw new ExtensionError("invalid", "UI 贡献必须位于扩展命名空间");
          if (session.ui.has(parsed.id))
            throw new ExtensionError("conflict", "UI 贡献已注册");
          session.ui.set(parsed.id, parsed);
          return disposable(session, () => session.ui.delete(parsed.id));
        },
        providers: (provider) => {
          if (!m.permissions.includes("providers:register"))
            deny("扩展没有 Provider 注册权限");
          const parsed = providerSchema.parse(provider);
          if (!parsed.id.startsWith(m.id + "."))
            throw new ExtensionError(
              "invalid",
              "Provider 必须位于扩展命名空间",
            );
          const identity = parsed.kind + ":" + parsed.id;
          if (session.providers.has(identity))
            throw new ExtensionError("conflict", "Provider 已注册");
          session.providers.set(identity, parsed);
          return disposable(session, () => session.providers.delete(identity));
        },
      };

      const api = createAPI(transport, bindings),
        context = {
          api,
          registerCommand: (
            id: string,
            handler: (input: unknown) => unknown,
          ) => {
            if (!session.active)
              throw new ExtensionError("denied", "扩展已停用");
            if (!id.startsWith(m.id + "."))
              throw new ExtensionError("invalid", "命令必须位于扩展命名空间");
            const dispose = commands.register(id, handler);
            session.disposers.push(dispose as () => unknown);
            return dispose;
          },
        };
      try {
        const dispose = await factory(context);
        if (!session.active) {
          if (typeof dispose === "function") dispose();
          throw new ExtensionError("denied", "扩展在激活期间已停用");
        }
        if (
          typeof dispose === "function" &&
          !session.disposers.includes(dispose as () => unknown)
        )
          session.disposers.push(dispose as () => unknown);
      } catch (e: any) {
        try {
          cleanup();
        } catch {}
        throw e;
      }
      return {
        api,
        deactivate: cleanup,
      };
    },

    /** Deactivate all sessions and run their disposers. */
    dispose() {
      for (const session of sessions.values()) {
        session.active = false;
        for (const fn of session.disposers.toReversed())
          try {
            fn();
          } catch {}
      }
      sessions.clear();
    },
  };
}
