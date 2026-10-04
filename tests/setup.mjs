import { afterEach, vi } from "vitest";
import { syncBuiltinESMExports } from "node:module";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});
