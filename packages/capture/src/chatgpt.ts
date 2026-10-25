import { z } from "zod";
import { captureLimits } from "./format.js";
import { readableCitations } from "./markdown.js";
import { convertComponents } from "./chatgpt-components.js";

const message = z
  .object({
    role: z.enum(["user", "assistant"]),
    text: z.string().max(captureLimits.bodyChars),
    unsupported: z.number().int().min(0).max(1000).default(0),
    unsupportedTypes: z
      .array(z.string().regex(/^[a-z][a-z0-9_]{0,47}$/))
      .max(4)
      .default([]),
    imageGroups: z
      .array(
        z
          .object({
            images: z
              .array(
                z
                  .object({
                    url: z.string().max(8192),
                    alt: z.string().max(240),
                  })
                  .strict(),
              )
              .max(200),
            incomplete: z.boolean(),
          })
          .strict(),
      )
      .max(200)
      .default([]),
  })
  .strict();
export const conversationSchema = z
  .object({
    id: z.string().min(1).max(200),
    title: z.string().max(240),
    currentNode: z.string().min(1).max(200),
    nodes: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            parent: z.string().max(200).nullable(),
            message: message.nullable(),
          })
          .strict(),
      )
      .max(10000),
    incomplete: z.boolean(),
  })
  .strict();

/** Traverse parents, not object insertion order; regenerated branches never get interleaved. */
export function conversationMarkdown(value: unknown) {
  const data = conversationSchema.parse(value),
    map = new Map(data.nodes.map((n) => [n.id, n]));
  if (map.size !== data.nodes.length) throw Error("对话节点重复");
  const seen = new Set<string>(),
    messages: {
      id: string;
      role: string;
      text: string;
      unsupported: number;
      unsupportedTypes: string[];
      imageGroups: z.infer<typeof message>["imageGroups"];
    }[] = [];
  let id: string | null = data.currentNode;
  while (id) {
    if (seen.has(id)) throw Error("对话分支出现循环");
    seen.add(id);
    const node = map.get(id);
    if (!node) throw Error("对话历史不完整，缺少父节点");
    if (node.message && (node.message.text.trim() || node.message.unsupported))
      messages.push({ id: node.id, ...node.message });
    id = node.parent;
  }
  messages.reverse();
  if (!messages.length) throw Error("当前分支没有可采集的公开消息");
  const missing = messages
    .filter((m) => m.unsupported > 0)
    .map((m) => ({
      name: `消息 ${m.id}`,
      reason: `有 ${m.unsupported} 项媒体或特殊内容尚未转换${m.unsupportedTypes.length ? `（格式：${m.unsupportedTypes.join(" / ")}）` : ""}，请使用网页选区采集或保留缺失说明。`,
    }));
  if (data.incomplete)
    missing.push({ name: "对话", reason: "对话仍在生成，这是未完成快照。" });
  const body = messages
    .map((m) => {
      const converted =
        m.role === "assistant"
          ? convertComponents(readableCitations(m.text), m.imageGroups)
          : { body: m.text, missing: [] };
      missing.push(...converted.missing);
      return `## ${m.role === "user" ? "用户" : "ChatGPT"}\n\n${converted.body}${m.unsupported ? "\n\n> 此消息包含未转换的媒体或特殊内容。" : ""}`;
    })
    .join("\n\n---\n\n");
  if (body.length > captureLimits.bodyChars)
    throw Error("对话正文超过采集预算");
  return {
    title: data.title || "ChatGPT 对话",
    body,
    missing,
    messageIds: messages.map((m) => m.id),
    conversationId: data.id,
  };
}
