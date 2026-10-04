import { z } from "zod";
import type { createProcessExtensionHost } from "./index.js";
export const hostedOperations = new Set([
  "listHostedExtensions",
  "configureHostedExtension",
  "executeHostedExtensionCommand",
]);
export function hostedRequest(
  host: ReturnType<typeof createProcessExtensionHost>,
  op: string,
  input: unknown,
) {
  if (op === "listHostedExtensions")
    return host.list(
      z.object({ notebookId: z.string().uuid() }).strict().parse(input)
        .notebookId,
    );
  if (op === "configureHostedExtension") return host.configure(input);
  if (op === "executeHostedExtensionCommand") return host.execute(input);
  throw Error("扩展宿主操作无效");
}
