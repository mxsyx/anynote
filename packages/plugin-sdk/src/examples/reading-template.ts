// This first-party example only imports public SDK contracts through its context.

/** Example extension manifest. */
export const manifest = {
  id: "anynote.reading-template",
  name: "阅读模板示例",
  version: "0.1.0",
  runtime: "trusted-first-party",
  permissions: ["notes:write"],
};

/**
 * Register the example extension's "create reading record" command.
 *
 * @param context Extension context (api and registerCommand).
 * @returns The command unregister function.
 */
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
