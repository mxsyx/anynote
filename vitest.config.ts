import { defineConfig } from "vitest/config";

// Keep backend regression tests independent of the desktop Vite root/plugins.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.{mjs,js,ts}"],
    environment: "node",
    pool: "forks",
    // Native SQLite, subprocess leases and builtin transport spies need a
    // separate process per file; serial files keep timing budgets predictable.
    isolate: true,
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 15000,
    setupFiles: ["tests/setup.mjs"],
    // Exercise the shipped Node modules without Vite rewriting import.meta
    // or creating a second module instance beside workspace package exports.
    server: {
      deps: {
        external: [
          /[\\/]\.build[\\/]/,
          /[\\/]packages[\\/][^\\/]+[\\/]dist[\\/]/,
        ],
      },
    },
  },
});
