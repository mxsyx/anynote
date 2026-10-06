import { validateScriptSearchContext } from "./search-context.js";
import { validateScriptNetworkResult } from "./network.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { extensionBlock, parseBlocks } from "@anynote/protocol/markdown.js";
import {
  runMarkdownTransform,
  runStatefulMarkdownTransform,
} from "@anynote/plugin-sdk/script-runner.js";
import { validateScriptState } from "@anynote/plugin-sdk/script-state.js";
import { validateSettings } from "./settings.js";
import type {
  InstallableManifest,
  MarkdownTransformInput,
} from "@anynote/plugin-sdk/declarative.js";

/**
 * Assert that the transformed body still preserves every extension block from before the transform.
 *
 * @param before Body before the transform.
 * @param after Body after the transform.
 */
export function assertPreservedBlocks(before: string, after: string) {
  const remaining = new Map<string, number>();
  for (const block of parseBlocks(after))
    if (block.kind === "extension")
      remaining.set(block.source, (remaining.get(block.source) ?? 0) + 1);
  for (const block of parseBlocks(before))
    if (block.kind === "extension") {
      const count = remaining.get(block.source) ?? 0;
      if (!count) throw Error("脚本必须原样保留扩展块");
      remaining.set(block.source, count - 1);
    }
}

/**
 * Build the Markdown snippet a declarative command appends/inserts.
 *
 * @param manifest Installable manifest.
 * @param commandId Command ID.
 * @returns The Markdown snippet.
 */
export function declarativeAddition(
  manifest: InstallableManifest,
  commandId: string,
) {
  const command = manifest.contributes.commands.find((c) => c.id === commandId);
  if (!command) throw Error("命令不存在");
  const action = command.action;
  if (action.kind === "appendMarkdown") return action.body;
  if (action.kind === "insertBlock") {
    const node = manifest.contributes.editorNodes.find(
      (n) => n.type === action.type,
    );
    if (!node) throw Error("命令引用未知节点");
    return extensionBlock(
      node.type,
      randomUUID(),
      Object.fromEntries(node.fields.map((f) => [f.key, f.default ?? ""])),
    );
  }
  throw Error("此命令需要隔离执行器");
}

/** Example data required for a command dry run (note, search, network, settings, and state). */
export const fixtureSchema = z
  .object({
    note: z
      .object({
        id: z.string().min(1).max(100),
        title: z.string().max(500),
        body: z.string().max(2_000_000),
        revision: z.number().int().positive(),
      })
      .strict(),
    searchContext: z.unknown().optional(),
    asyncSearch: z.record(z.unknown()).optional(),
    network: z.record(z.unknown()).optional(),
    settings: z.unknown().optional(),
    state: z.unknown().optional(),
    stateVersion: z.number().int().min(1).max(100).optional(),
  })
  .strict();

/**
 * Dry-run an extension command in the isolated runner.
 *
 * It validates the example data against the command declaration (search
 * context, async search, network requests, settings, and state revision), runs
 * the transform, ensures extension blocks are preserved, and returns the body
 * plus optional settings and state.
 *
 * @param manifest Installable manifest.
 * @param commandId Command ID.
 * @param raw Raw dry-run payload.
 * @returns The dry-run result.
 */
export async function dryRunCommand(
  manifest: InstallableManifest,
  commandId: string,
  raw: unknown,
) {
  const fixture = fixtureSchema.parse(raw),
    command = manifest.contributes.commands.find((c) => c.id === commandId);
  if (!command) throw Error("命令不存在");

  const form = manifest.contributes.settings;
  if (!form && fixture.settings !== undefined)
    throw Error("扩展未声明设置表单");
  const settings = form
    ? validateSettings(
        form,
        fixture.settings ??
          Object.fromEntries(form.fields.map((f) => [f.key, f.default])),
      )
    : undefined;

  const request =
    "searchContext" in command.action
      ? command.action.searchContext
      : undefined;
  if (!request && fixture.searchContext !== undefined)
    throw Error("命令未声明搜索上下文");
  if (request && fixture.searchContext === undefined)
    throw Error("试运行需要提供声明查询的 searchContext 示例");
  const searchContext = request
    ? validateScriptSearchContext(fixture.searchContext)
    : undefined;
  if (
    request &&
    searchContext &&
    (searchContext.query !== request.query ||
      searchContext.results.length > request.limit ||
      searchContext.results.some((r) => r.id === fixture.note.id))
  )
    throw Error("搜索上下文与声明查询不匹配");

  const asyncRequests =
    "asyncSearch" in command.action ? command.action.asyncSearch : undefined;
  if (!asyncRequests && fixture.asyncSearch !== undefined)
    throw Error("命令未声明异步搜索");
  if (
    asyncRequests &&
    (!fixture.asyncSearch ||
      Object.keys(fixture.asyncSearch).length !== asyncRequests.length ||
      Object.keys(fixture.asyncSearch).some(
        (id) => !asyncRequests.some((r) => r.id === id),
      ))
  )
    throw Error("需要提供全部声明查询的 asyncSearch 示例");
  const contexts = new Map(
    asyncRequests?.map((r) => {
      const value = validateScriptSearchContext(fixture.asyncSearch![r.id]);
      if (
        value.query !== r.query ||
        value.results.length > r.limit ||
        value.results.some((n) => n.id === fixture.note.id)
      )
        throw Error("异步搜索示例与声明不匹配");
      return [r.id, value] as const;
    }),
  );

  const networkRequests =
    "networkRequests" in command.action
      ? command.action.networkRequests
      : undefined;
  if (!networkRequests && fixture.network !== undefined)
    throw Error("命令未声明网络请求");
  if (
    networkRequests &&
    (!fixture.network ||
      Object.keys(fixture.network).length !== networkRequests.length ||
      Object.keys(fixture.network).some(
        (id) => !networkRequests.some((r) => r.id === id),
      ))
  )
    throw Error("需提供全部声明请求的 network 示例");
  const responses = new Map(
    networkRequests?.map((r) => {
      const value = validateScriptNetworkResult(fixture.network![r.id]);
      if (value.url !== r.url) throw Error("网络示例地址与声明不匹配");
      return [r.id, value] as const;
    }),
  );

  const host =
    asyncRequests || networkRequests
      ? {
          requests: asyncRequests ?? [],
          networkRequests,
          request: async (id: string) => responses.get(id)!,
          search: async (id: string) => contexts.get(id)!,
        }
      : undefined;

  const input: MarkdownTransformInput = {
    ...fixture.note,
    ...(searchContext ? { searchContext } : {}),
    ...(settings ? { settings } : {}),
  };

  const action = command.action;
  let body: string, state: unknown, stateVersion: number | undefined;
  if (action.kind === "transformMarkdownWithState") {
    stateVersion =
      manifest.runtime === "quickjs-transform"
        ? (manifest.contributes.stateVersion ?? 1)
        : 1;
    if (fixture.state !== undefined && fixture.stateVersion === undefined)
      throw Error("提供旧状态时必须声明 stateVersion");
    if (
      fixture.stateVersion !== undefined &&
      fixture.stateVersion !== stateVersion
    )
      throw Error("状态版本不兼容，请先显式迁移示例数据");
    const result = await runStatefulMarkdownTransform(
      action.script,
      {
        ...input,
        state: validateScriptState(fixture.state ?? {}),
      },
      undefined,
      host,
    );
    body = result.body;
    state = result.state;
    assertPreservedBlocks(input.body, body);
  } else {
    if (fixture.state !== undefined || fixture.stateVersion !== undefined)
      throw Error("普通命令不接收脚本状态");
    if (action.kind === "transformMarkdown") {
      body = await runMarkdownTransform(action.script, input, undefined, host);
      assertPreservedBlocks(input.body, body);
    } else
      body =
        input.body +
        (input.body.endsWith("\n\n") ? "" : "\n\n") +
        declarativeAddition(manifest, commandId);
  }
  if (body.length > 2_000_000) throw Error("正文超出 2MB 编辑预算");
  return {
    body,
    ...(stateVersion !== undefined ? { state, stateVersion } : {}),
    ...(settings ? { settings } : {}),
  };
}
