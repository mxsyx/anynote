import { installableManifestSchema } from "./manifest.js";
export const templateKinds = [
  "declarative",
  "transform",
  "stateful",
  "preferences",
] as const;
export function extensionTemplate(
  id: string,
  kind: (typeof templateKinds)[number],
) {
  const manifest = {
    id,
    name: "扩展示例",
    version: "0.1.0",
    engines: { anynote: "^0.1.0" },
    runtime: kind === "declarative" ? "declarative" : "quickjs-transform",
    permissions:
      kind === "declarative"
        ? ["notes:write"]
        : kind === "transform"
          ? ["notes:read", "notes:write"]
          : ["notes:read", "notes:write", "settings:read", "settings:write"],
    contributes: {
      ...(kind === "preferences"
        ? {
            settings: {
              version: 1,
              fields: [
                {
                  key: "heading",
                  label: "摘要标题",
                  kind: "text",
                  default: "阅读摘要",
                  maxLength: 80,
                },
              ],
            },
          }
        : {}),
      ...(kind === "stateful" ? { stateVersion: 1 } : {}),
      commands: [
        {
          id: id + ".run",
          title: "运行扩展示例",
          action:
            kind === "declarative"
              ? {
                  kind: "appendMarkdown",
                  body: "## 阅读摘要\n\n记录你的发现。\n",
                }
              : {
                  kind:
                    kind === "stateful"
                      ? "transformMarkdownWithState"
                      : "transformMarkdown",
                  script:
                    kind === "stateful"
                      ? "n=>({body:n.body+'\\n\\n整理完成。',state:{...n.state,runs:(Number.isSafeInteger(n.state.runs)?n.state.runs:0)+1}})"
                      : kind === "preferences"
                        ? "n=>n.body+'\\n\\n## '+n.settings.heading+'\\n'"
                        : "n=>n.body+'\\n\\n## 阅读摘要\\n'",
                },
        },
      ],
      editorNodes: [],
    },
  };
  return installableManifestSchema.parse(manifest);
}
