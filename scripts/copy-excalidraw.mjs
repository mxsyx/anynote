import { cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const require = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
mkdirSync("public/excalidraw", { recursive: true });
cpSync(
  join(dirname(require.resolve("@excalidraw/excalidraw")), "fonts"),
  "public/excalidraw/fonts",
  { recursive: true },
);
