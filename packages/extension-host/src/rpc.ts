import { z } from "zod";
import type { createProcessExtensionHost } from "./index.js";

/** Operations handled by the extension host rather than passed straight to the storage process. */
export const hostedOperations = new Set([
  "listHostedExtensions",
  "configureHostedExtension",
  "executeHostedExtensionCommand",
]);

/**
 * Route extension-host operations to the matching handler.
 *
 * @param host Process extension host.
 * @param op Operation name.
 * @param input Operation input.
 * @returns The handled result, or `null` when not a hosted operation.
 */
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
