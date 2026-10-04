import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      ".build/**",
      "**/dist/**",
      "release/**",
      "artifacts/**",
      "test-results/**",
      "playwright-report/**",
      "public/excalidraw/**",
      ".anynote-dev/**",
      ".cloudflare-acceptance/**",
      ".codebase-memory/**",
      "**/.wrangler/**",
      ".husky/_/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "no-unused-vars": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowShortCircuit: true, allowTernary: true },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
          ignoreRestSiblings: true,
        },
      ],
      // Existing storage/IPC boundaries intentionally use dynamic records.
      // Strict TypeScript remains a separate check for these contracts.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["**/*.cts", "**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // Sanitizers deliberately match control characters.
    files: [
      "packages/extension-tools/src/search-context.ts",
      "packages/storage-sqlite/src/open-export.ts",
      "scripts/cloud/deploy.mjs",
    ],
    rules: { "no-control-regex": "off" },
  },
  {
    files: ["tests/**/*.mjs"],
    rules: { "@typescript-eslint/no-this-alias": "off" },
  },
  prettier,
);
