import { build } from "vite";
import { copyFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve("apps/browser-extension");
await build({
  configFile: false,
  root,
  base: "./",
  resolve: { conditions: ["worker", "browser", "module", "production"] },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome116",
    rollupOptions: {
      input: {
        panel: resolve(root, "index.html"),
        background: resolve(root, "src/background.js"),
        "chatgpt-button": resolve(root, "src/chatgpt-button.js"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },
  },
});
copyFileSync(
  resolve(root, "manifest.json"),
  resolve(root, "dist/manifest.json"),
);
console.log("Load unpacked extension: apps/browser-extension/dist");
