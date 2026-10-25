import type { Storage } from "../../packages/storage-sqlite/src/index.js";
import type { Transport } from "../../packages/plugin-sdk/src/index.js";

export async function boundaries(
  storage: Storage,
  transport: Transport,
  operation: string,
) {
  const notes = await storage.run("listNodes", { notebookId: "id" });
  const title: string = notes[0].title;
  const asset = await storage.execute("getAsset", {
    notebookId: "id",
    id: "id",
  });
  const bytes: string = asset.data;
  void [title, bytes];
  // @ts-expect-error Notebook scope is required.
  await storage.run("listNodes");
  await storage.execute("getNote", {
    notebookId: "id",
    id: "id",
    // @ts-expect-error Known operations reject unrelated fields.
    sql: "SELECT 1",
  });
  await storage.execute("saveNote", {
    notebookId: "id",
    id: "id",
    // @ts-expect-error Revisions are numbers, including on direct execution.
    expectedRevision: "1",
  });
  // @ts-expect-error Known operation names cannot widen to bypass their input contract.
  await storage.run("getNote", { id: 3 });
  const result = await storage.run(operation, {});
  // @ts-expect-error Dynamic service results require validation.
  void result.id;
  const service = await storage.execute("injectedService");
  // @ts-expect-error Injected services cannot silently leak any.
  const id: string = service;
  void id;
  await transport("notes.get", { id: "id" });
  // @ts-expect-error Method inputs are correlated with method names.
  await transport("notes.get", { query: "text" });
  // @ts-expect-error No arbitrary methods on the public extension channel.
  await transport("getNote", { id: "id" });
  // @ts-expect-error Transport output has not been validated yet.
  const note: { id: string } = await transport("notes.get", { id: "id" });
  void note;
}
