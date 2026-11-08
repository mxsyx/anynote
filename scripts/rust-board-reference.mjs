import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { chromium } from "playwright";

// Only the verification harness executes the frozen JS dependency. The native
// editor never links this bundle or loads an Excalidraw/React runtime.
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const root = resolve("tests/fixtures/rust-board");
const output = resolve("tmp/rm22");
mkdirSync(output, { recursive: true });
const entry = realpathSync(
  "apps/desktop/node_modules/@excalidraw/excalidraw/dist/dev/index.js",
);
const source = readFileSync(entry, "utf8");
const version = JSON.parse(
  readFileSync(resolve(dirname(entry), "../../package.json"), "utf8"),
).version;
assert.equal(version, "0.18.0");
const instrumented = `${source}\nglobalThis.rm22 = { actions, getDefaultAppState, restoreElements, Scene: Scene_default, getCommonBounds };`;
await build({
  stdin: { contents: instrumented, resolveDir: dirname(entry), loader: "js" },
  alias: {
    react: realpathSync("apps/desktop/node_modules/react"),
    "react-dom": realpathSync("apps/desktop/node_modules/react-dom"),
  },
  bundle: true,
  format: "iife",
  outfile: resolve(output, "reference.js"),
  define: { "process.env.NODE_ENV": '"development"' },
  loader: { ".woff2": "dataurl", ".wasm": "dataurl" },
  logLevel: "warning",
});
const base = JSON.parse(
  readFileSync("tests/fixtures/rust-migration/corpus/scene-input.json", "utf8"),
);
base.elements[0].height = 40;
base.elements[1].y = 80;
base.elements[2].y = 35;
const cases = [
  {
    action: "changeStrokeColor",
    selected: ["element-0", "element-1", "element-7"],
    value: { currentItemStrokeColor: "#cc0000" },
    command: { kind: "style", properties: { strokeColor: "#cc0000" } },
  },
  {
    action: "changeBackgroundColor",
    selected: ["element-0", "element-3", "element-7"],
    value: { currentItemBackgroundColor: "#ffeeaa" },
    command: { kind: "style", properties: { backgroundColor: "#ffeeaa" } },
  },
  {
    action: "changeFillStyle",
    selected: ["element-0", "element-1"],
    value: "hachure",
    command: { kind: "style", properties: { fillStyle: "hachure" } },
  },
  {
    action: "changeStrokeWidth",
    selected: ["element-0", "element-1"],
    value: 2,
    command: { kind: "style", properties: { strokeWidth: 2 } },
  },
  {
    action: "changeStrokeStyle",
    selected: ["element-0", "element-1"],
    value: "dashed",
    command: { kind: "style", properties: { strokeStyle: "dashed" } },
  },
  {
    action: "changeSloppiness",
    selected: ["element-0", "element-1"],
    value: 2,
    command: { kind: "roughness", value: 2, seeds: {} },
  },
  {
    action: "changeOpacity",
    selected: ["element-0", "element-1", "element-7"],
    value: 60,
    command: { kind: "style", properties: { opacity: 60 } },
  },
  {
    action: "group",
    selected: ["element-0", "element-2"],
    command: { kind: "group", id: "reference-group" },
  },
  {
    action: "bringToFront",
    selected: ["element-0", "element-2"],
    command: { kind: "layer", layer: "front" },
  },
  {
    action: "sendToBack",
    selected: ["element-0", "element-2"],
    command: { kind: "layer", layer: "back" },
  },
  {
    action: "bringForward",
    selected: ["element-0", "element-2"],
    command: { kind: "layer", layer: "forward" },
  },
  {
    action: "sendBackward",
    selected: ["element-0", "element-2"],
    command: { kind: "layer", layer: "backward" },
  },
  {
    action: "ungroup",
    selected: ["element-0", "element-2"],
    selectedGroups: ["reference-group"],
    command: { kind: "ungroup", id: "reference-group" },
  },
  {
    action: "distributeHorizontally",
    selected: ["element-0", "element-1", "element-2"],
    command: { kind: "distribute", axis: "x" },
  },
  {
    action: "distributeVertically",
    selected: ["element-0", "element-1", "element-2"],
    command: { kind: "distribute", axis: "y" },
  },
  {
    action: "alignTop",
    selected: ["element-0", "element-1", "element-2"],
    command: { kind: "align", axis: "y", alignment: "start" },
  },
  {
    action: "alignBottom",
    selected: ["element-0", "element-1", "element-2"],
    command: { kind: "align", axis: "y", alignment: "end" },
  },
  {
    action: "alignVerticallyCentered",
    selected: ["element-0", "element-1", "element-2"],
    command: { kind: "align", axis: "y", alignment: "center" },
  },
  {
    action: "alignLeft",
    selected: ["element-0", "element-1", "element-2"],
    command: { kind: "align", axis: "x", alignment: "start" },
  },
  {
    action: "alignRight",
    selected: ["element-0", "element-1", "element-2"],
    command: { kind: "align", axis: "x", alignment: "end" },
  },
  {
    action: "alignHorizontallyCentered",
    selected: ["element-0", "element-1", "element-2"],
    command: { kind: "align", axis: "x", alignment: "center" },
  },
  {
    action: "flipHorizontal",
    selected: ["element-0", "element-7"],
    command: { kind: "flip", axis: "x" },
  },
  {
    action: "flipVertical",
    selected: ["element-0", "element-7"],
    command: { kind: "flip", axis: "y" },
  },
  {
    action: "toggleElementLock",
    selected: ["element-0"],
    command: { kind: "lock", locked: true },
  },
  {
    action: "toggleElementLock",
    selected: ["element-0"],
    command: { kind: "lock", locked: false },
  },
  {
    action: "deleteSelectedElements",
    selected: ["element-1"],
    command: { kind: "delete" },
  },
];
const cache = resolve(homedir(), ".cache/ms-playwright");
const installed = existsSync(cache)
  ? readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort()
      .reverse()
      .map((name) => resolve(cache, name, "chrome-linux64/chrome"))
      .find(existsSync)
  : undefined;
const browser = await chromium.launch({
  executablePath: process.env.RM22_CHROMIUM || installed,
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const context = await browser.newContext();
  await context.route("**/*", (route) => route.abort());
  const page = await context.newPage();
  await page.goto("about:blank");
  await page.evaluate(() => {
    Date.now = () => 1700000000000;
  });
  await page.addScriptTag({ path: resolve(output, "reference.js") });
  const result = await page.evaluate(
    ({ base, cases }) => {
      const { actions, getDefaultAppState, restoreElements, Scene } =
        globalThis.rm22;
      const normalize = (scene) => {
        const copy = structuredClone(scene);
        for (const element of copy.elements)
          for (const key of ["version", "versionNonce", "updated", "index"])
            delete element[key];
        return copy;
      };
      let elements = restoreElements(base.elements, null);
      const initial = { ...base, elements: structuredClone(elements) };
      const scene = new Scene();
      let appState = getDefaultAppState();
      const app = {
        scene,
        getAppState: () => appState,
        device: { editor: { isMobile: false } },
      };
      const steps = [];
      for (const step of cases) {
        appState = {
          ...appState,
          selectedElementIds: Object.fromEntries(
            step.selected.map((id) => [id, true]),
          ),
          selectedGroupIds: Object.fromEntries(
            (step.selectedGroups || []).map((id) => [id, true]),
          ),
        };
        scene.replaceAllElements(elements);
        const action = actions.find((action) => action.name === step.action);
        if (!action) throw new Error(`Missing action ${step.action}`);
        const result = action.perform(elements, appState, step.value, app);
        if (!result) throw new Error(`Action rejected: ${step.action}`);
        elements = result.elements || elements;
        appState = { ...appState, ...result.appState };
        if (step.action === "group") {
          const created = elements
            .find((element) => step.selected.includes(element.id))
            .groupIds.at(-1);
          elements = elements.map((element) => ({
            ...element,
            groupIds: element.groupIds.map((id) =>
              id === created ? step.command.id : id,
            ),
          }));
        }
        if (step.action === "changeSloppiness")
          step.command.seeds = Object.fromEntries(
            elements
              .filter((element) => step.selected.includes(element.id))
              .map((element) => [element.id, element.seed]),
          );
        steps.push({ ...step, expected: normalize({ ...base, elements }) });
      }
      scene.destroy();
      return JSON.parse(
        JSON.stringify({
          initial,
          steps,
          registeredActions: actions.map((action) => action.name).sort(),
        }),
      );
    },
    { base, cases },
  );
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const hashes = Object.fromEntries(
    readdirSync(dirname(entry))
      .filter((name) => name.endsWith(".js"))
      .sort()
      .map((name) => [name, hash(readFileSync(resolve(dirname(entry), name)))]),
  );
  const types = readFileSync(
    resolve(dirname(entry), "../types/excalidraw/element/types.d.ts"),
    "utf8",
  );
  const wrapper = readFileSync("apps/desktop/src/WhiteboardEditor.tsx", "utf8");
  const schema = {
    typesSha256: hash(types),
    wrapperSha256: hash(wrapper),
    elementTypes: [
      ...new Set(
        [...types.matchAll(/type: "([^"\n]+)"/g)].map((match) => match[1]),
      ),
    ].sort(),
    declaredFields: [
      ...new Set(
        [...types.matchAll(/^ {4}([A-Za-z][A-Za-z0-9]*)(?:\?)?: /gm)].map(
          (match) => match[1],
        ),
      ),
    ].sort(),
    canvasActions: {
      loadScene: false,
      saveToActiveFile: false,
      export: false,
      toggleTheme: true,
    },
    reachability:
      "registration/type presence is not UI reachability; see RUST-BOARD-COMPATIBILITY.md",
  };
  const fixture = {
    schema,
    upstream: "@excalidraw/excalidraw@0.18.0",
    scope:
      "real upstream action.perform calls with real Scene; no pointer/UI, rendering or native text-metrics acceptance",
    ignoredElementFields: ["version", "versionNonce", "updated", "index"],
    hashes,
    ...result,
  };
  const path = resolve(root, "actions.json");
  if (process.argv.includes("--write")) {
    mkdirSync(root, { recursive: true });
    writeFileSync(path, JSON.stringify(fixture, null, 2) + "\n");
  } else {
    const frozen = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(fixture.schema, frozen.schema, "wrapper/type drift");
    assert.deepEqual(fixture.hashes, frozen.hashes, "upstream build drift");
    assert.deepEqual(
      fixture.registeredActions,
      frozen.registeredActions,
      "registered action drift",
    );
    assert.deepEqual(
      fixture.steps,
      frozen.steps,
      "upstream action outcomes drift",
    );
  }
  writeFileSync(
    resolve(output, "reference-report.json"),
    JSON.stringify(
      {
        status: "passed",
        steps: result.steps.length,
        registeredActions: result.registeredActions.length,
        scope: fixture.scope,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Excalidraw reference: ${result.steps.length} steps, ${result.registeredActions.length} registered actions`,
  );
} catch (error) {
  writeFileSync(
    resolve(output, "reference-report.json"),
    JSON.stringify(
      { status: "failed", error: error.message.slice(0, 2000) },
      null,
      2,
    ) + "\n",
  );
  throw error;
} finally {
  await browser.close();
}
