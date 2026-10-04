import type { ExtensionContext } from "./contracts.js";
export type { ExtensionContext } from "./contracts.js";
import { z } from "zod";
import type { Storage } from "@anynote/storage-sqlite/index.js";
import type { SqlRow } from "@anynote/types/runtime.js";
import { CommandRegistry, createAPI } from "./index.js";
const uuid = z.string().uuid(),
  key = z.string().regex(/^[a-zA-Z0-9._:-]{1,240}$/);
const permissions = [
  "notes:read",
  "notes:write",
  "assets:read",
  "assets:write",
  "search:read",
  "settings:read",
  "settings:write",
] as const;
const manifestSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9.-]{2,100}$/),
    name: z.string().max(120),
    version: z.string().regex(/^0\.1\.\d+$/),
    runtime: z.literal("trusted-first-party"),
    permissions: z.array(z.enum(permissions)).max(20),
  })
  .strict();
/** Host must explicitly trust a bundled factory. No arbitrary plugin files are loaded. */
export function createExtensionHost(
  storage: Pick<Storage, "run">,
  { trustedIds = [] }: { trustedIds?: string[] } = {},
) {
  const commands = new CommandRegistry(),
    sessions = new Map<
      string,
      { active: boolean; disposers: (() => unknown)[] }
    >();
  return {
    commands,
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
      const session = { active: true, disposers: [] as (() => unknown)[] };
      sessions.set(m.id, session);
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
      const transport = async (method: string, raw: unknown) => {
        if (!session.active) throw Error("扩展已停用");
        const policy: Record<string, (typeof permissions)[number]> = {
          "notes.get": "notes:read",
          "notes.create": "notes:write",
          "notes.applyPatch": "notes:write",
          "search.query": "search:read",
          "assets.read": "assets:read",
          "assets.addImage": "assets:write",
          "settings.get": "settings:read",
          "settings.set": "settings:write",
        };
        if (!policy[method] || !m.permissions.includes(policy[method]))
          throw Error("扩展没有此操作权限");
        // Renderer-supplied notebook IDs, paths, SQL and actor identities cannot cross this facade.
        const base = { notebookId };
        if (method === "notes.get")
          return storage.run("getNote", {
            ...base,
            ...z.object({ id: uuid }).strict().parse(raw),
          });
        if (method === "notes.create")
          return storage.run("createNode", {
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
        if (method === "notes.applyPatch")
          return storage.run("extensionPatch", {
            ...base,
            extensionId: m.id,
            ...z
              .object({
                id: uuid,
                expectedRevision: z.number().int().positive(),
                body: z.string().max(2_000_000),
                operationId: uuid,
              })
              .strict()
              .parse(raw),
          });
        if (method === "search.query")
          return storage.run("search", {
            ...base,
            ...z
              .object({ query: z.string().max(300) })
              .strict()
              .parse(raw),
          });
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
      };
      const api = createAPI(transport),
        context = {
          api,
          registerCommand: (
            id: string,
            handler: (input: unknown) => unknown,
          ) => {
            if (!session.active) throw Error("扩展已停用");
            if (!id.startsWith(m.id + "."))
              throw Error("命令必须位于扩展命名空间");
            const dispose = commands.register(id, handler);
            session.disposers.push(dispose as () => unknown);
            return dispose;
          },
        };
      try {
        const dispose = await factory(context);
        if (!session.active) {
          if (typeof dispose === "function") dispose();
          throw Error("扩展在激活期间已停用");
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
