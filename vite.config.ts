import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { rendererReportPlugin } from "./scripts/build/renderer-report.mjs";
export default defineConfig({
  root: "apps/desktop",
  publicDir: "../../public",
  plugins: [react(), tailwindcss(), rendererReportPlugin()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/desktop/src", import.meta.url)),
    },
  },
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:4318" },
  },
  build: { outDir: "../../dist", emptyOutDir: true },
});
