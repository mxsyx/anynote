import { defineConfig } from "vite";
import { cpSync } from "node:fs";

export default defineConfig({
  base: "./",
  plugins: [
    {
      name: "local-excalidraw-assets",
      closeBundle() {
        cpSync(
          "node_modules/@excalidraw/excalidraw/dist/prod/fonts",
          "dist/excalidraw/fonts",
          { recursive: true },
        );
      },
    },
  ],
});
