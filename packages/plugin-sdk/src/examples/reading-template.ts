// This first-party example imports only the public SDK contract through its context.
export const manifest = {
  id: "anynote.reading-template",
  name: "阅读模板示例",
  version: "0.1.0",
  runtime: "trusted-first-party",
  permissions: ["notes:write"],
};
export function activate({
  api,
  registerCommand,
}: import("../contracts.js").ExtensionContext) {
  return registerCommand(manifest.id + ".create", () =>
    api.notes.create({
      title: "阅读记录",
      body: "# 阅读记录\n\n## 关键观点\n\n## 我的思考\n",
    }),
  );
}
