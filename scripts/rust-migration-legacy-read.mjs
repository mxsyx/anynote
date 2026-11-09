import { validateDirectory } from "../.build/packages/storage-sqlite/workspace.js";
import { schema } from "../.build/packages/storage-sqlite/schema.js";
for (const path of process.argv.slice(2))
  validateDirectory(path, { 5: schema });
