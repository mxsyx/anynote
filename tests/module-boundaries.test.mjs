import { test } from "vitest";
import assert from "node:assert/strict";
import { dependencyCycle } from "../scripts/workspace-graph.mjs";
import { validateStatefulResult } from "../.build/packages/plugin-sdk/script-state.js";

test("dependency guard detects direct and indirect cycles without rejecting a downstream cycle", () => {
  const graph = new Map([
    ["tools", ["sdk"]],
    ["sdk", ["types"]],
    ["types", []],
    ["storage", ["tools", "backup"]],
    ["backup", ["storage"]],
    ["entry", ["storage"]],
  ]);
  assert.equal(dependencyCycle(graph, "sdk"), null);
  assert.equal(dependencyCycle(graph, "tools"), null);
  assert.equal(dependencyCycle(graph, "entry"), null);
  graph.set("sdk", ["storage"]);
  assert.deepEqual(dependencyCycle(graph, "tools"), [
    "tools",
    "sdk",
    "storage",
    "tools",
  ]);
  graph.set("sdk", ["tools"]);
  assert.deepEqual(dependencyCycle(graph, "tools"), ["tools", "sdk", "tools"]);
  graph.set("sdk", ["sdk"]);
  assert.deepEqual(dependencyCycle(graph, "sdk"), ["sdk", "sdk"]);
});

test("stateful JSON output validates its envelope, body and state before consumption", () => {
  assert.deepEqual(
    validateStatefulResult({ body: "text", state: { count: 1 } }),
    {
      body: "text",
      state: { count: 1 },
    },
  );
  for (const raw of [
    null,
    [],
    {},
    { body: 1, state: {} },
    { body: "text" },
    { body: "text", state: {}, extra: true },
    { body: "x".repeat(2_000_001), state: {} },
    { body: "text", state: [] },
    { body: "text", state: { value: undefined } },
    { body: "text", state: { value: Infinity } },
  ])
    assert.throws(() => validateStatefulResult(raw));
});
