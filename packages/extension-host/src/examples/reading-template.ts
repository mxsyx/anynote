import type { ExtensionContext } from "@anynote/plugin-sdk/contracts.js";
export function activate({ api, registerCommand }: ExtensionContext) {
  return registerCommand("anynote.reading-template.create", () =>
    api.notes.create({
      title: "阅读记录",
      body: "# 阅读记录\n\n## 关键观点\n\n## 我的思考\n",
    }),
  );
}
