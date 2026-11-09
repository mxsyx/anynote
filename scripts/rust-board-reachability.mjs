import assert from "node:assert/strict";

export async function probeReachability(page, { base, css }) {
  assert(await page.evaluate(() => isSecureContext && !!navigator.clipboard));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addStyleTag({ path: css });
  await page.evaluate((base) => {
    const { ActionManager, React, Excalidraw, createRoot, actions } =
      globalThis.rm22;
    const registerAll = ActionManager.prototype.registerAll;
    ActionManager.prototype.registerAll = function (actions) {
      globalThis.rm22Manager = this;
      return registerAll.call(this, actions);
    };
    for (const action of actions) {
      if (action.PanelComponent) {
        const Panel = action.PanelComponent;
        action.PanelComponent = (props) =>
          React.createElement(
            "div",
            { "data-rm22-action": action.name },
            React.createElement(Panel, props),
          );
      }
    }
    const root = document.createElement("div");
    root.style.cssText = "width:1440px;height:1000px";
    document.body.style.margin = "0";
    document.body.append(root);
    globalThis.rm22Root = createRoot(root);
    globalThis.rm22Root.render(
      React.createElement(Excalidraw, {
        excalidrawAPI: (api) => {
          globalThis.rm22Api = api;
        },
        initialData: {
          ...base,
          appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } },
        },
        langCode: "en-US",
        autoFocus: true,
        UIOptions: {
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            export: false,
            toggleTheme: true,
          },
        },
      }),
    );
  }, base);
  await page.waitForFunction(
    () => globalThis.rm22Api && document.querySelector("canvas.interactive"),
  );
  const entries = {};
  const capture = async (state) => {
    entries[state] = await page.evaluate(() => ({
      panels: [...document.querySelectorAll("[data-rm22-action]")]
        .filter((el) =>
          [...el.querySelectorAll("button,input,select")].some(
            (control) =>
              control.checkVisibility({
                opacityProperty: true,
                visibilityProperty: true,
              }) && !control.disabled,
          ),
        )
        .map((el) => el.dataset.rm22Action)
        .sort(),
      contextMenu: [...document.querySelectorAll(".context-menu [data-testid]")]
        .map((el) => el.dataset.testid)
        .sort(),
      controls: [
        ...document.querySelectorAll("button,[role=radio],label.ToolIcon,a"),
      ]
        .filter((el) =>
          el.checkVisibility({
            opacityProperty: true,
            visibilityProperty: true,
          }),
        )
        .map(
          (el) =>
            el.getAttribute("aria-label") ||
            el.getAttribute("title") ||
            el.textContent.trim(),
        )
        .filter(Boolean)
        .sort(),
    }));
  };
  await capture("empty-selection");
  await page.getByTestId("main-menu-trigger").click();
  await capture("main-menu");
  await page.getByTestId("main-menu-trigger").click();
  await page.getByRole("button", { name: "More tools", exact: true }).click();
  await capture("more-tools");
  await page.getByRole("button", { name: "More tools", exact: true }).click();
  const selections = {
    shapes: ["element-0", "element-1", "element-2"],
    text: ["element-3"],
    line: ["element-4"],
    arrow: ["element-5"],
    image: ["element-7"],
    frame: ["element-8"],
  };
  const keyboard = {};
  for (const [state, selected] of Object.entries({
    empty: [],
    ...selections,
  })) {
    await page.evaluate(
      (selected) =>
        globalThis.rm22Api.updateScene({
          appState: {
            selectedElementIds: Object.fromEntries(
              selected.map((id) => [id, true]),
            ),
          },
        }),
      selected,
    );
    await page.waitForFunction(
      (selected) =>
        JSON.stringify(
          Object.keys(
            globalThis.rm22Api.getAppState().selectedElementIds,
          ).sort(),
        ) === JSON.stringify([...selected].sort()),
      selected,
    );
    await capture(state);
    const position = await page.evaluate((selected) => {
      const element = globalThis.rm22Api
        .getSceneElements()
        .find((e) => e.id === selected[0]);
      return element
        ? {
            x: element.x + element.width / 2,
            y: element.y + element.height / 2,
          }
        : { x: 900, y: 800 };
    }, selected);
    await page
      .locator("canvas.interactive")
      .click({ button: "right", position });
    await page.locator(".context-menu").waitFor();
    await capture(`context-${state}`);
    await page.keyboard.press("Escape");
    keyboard[state] = await page.evaluate(() => {
      const manager = globalThis.rm22Manager;
      const current = manager.getAppState();
      const elements = manager.getElementsIncludingDeleted();
      const app = manager.app;
      const actions = Object.values(manager.actions);
      const probes = {};
      const keys = [
        ..."abcdefghijklmnopqrstuvwxyz0123456789",
        "Delete",
        "Backspace",
        "Escape",
        "Enter",
        "Tab",
        " ",
        "[",
        "]",
        "=",
        "-",
        "+",
        "?",
        "/",
        ",",
        ".",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
      ];
      // Exercise the real dispatcher while replacing the selected action's side
      // effect. This measures routing, not successful clipboard/file operations.
      let dispatched;
      const originals = actions.map((action) => action.perform);
      for (const action of actions)
        action.perform = () => {
          dispatched = action.name;
          return false;
        };
      const update = manager.updater;
      manager.updater = () => {};
      try {
        for (const key of keys)
          for (let mask = 0; mask < 16; mask++) {
            const code = /^[a-z]$/.test(key)
              ? `Key${key.toUpperCase()}`
              : /^[0-9]$/.test(key)
                ? `Digit${key}`
                : {
                    "[": "BracketLeft",
                    "]": "BracketRight",
                    "=": "Equal",
                    "+": "Equal",
                    "-": "Minus",
                    "/": "Slash",
                    "?": "Slash",
                    ",": "Comma",
                    ".": "Period",
                    " ": "Space",
                  }[key] || key;
            const init = {
              key,
              code,
              ctrlKey: !!(mask & 1),
              metaKey: !!(mask & 2),
              shiftKey: !!(mask & 4),
              altKey: !!(mask & 8),
            };
            if (
              !actions.some((action) =>
                action.keyTest?.(init, current, elements, app),
              )
            )
              continue;
            dispatched = null;
            manager.handleKeyDown(new KeyboardEvent("keydown", init));
            if (dispatched) (probes[dispatched] ||= []).push(`${mask}:${key}`);
          }
      } finally {
        actions.forEach((action, i) => {
          action.perform = originals[i];
        });
        manager.updater = update;
      }
      return probes;
    });
  }
  const actions = await page.evaluate(() =>
    Object.values(globalThis.rm22Manager.actions)
      .map((action) => ({
        name: action.name,
        keyboard: !!action.keyTest,
        panel: !!action.PanelComponent,
        predicate: !!action.predicate,
        hostCanvasEnabled:
          globalThis.rm22Manager.app.props.UIOptions.canvasActions[
            action.name
          ] ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  assert(
    !Object.values(keyboard).some(
      (row) => row.loadScene || row.saveToActiveFile,
    ),
  );
  assert(keyboard.shapes.group && keyboard.shapes.deleteSelectedElements);
  assert(keyboard.shapes.saveFileToDisk);
  const creations = [];
  const businessElements = () =>
    globalThis.rm22Api.getSceneElements().map((element) => {
      const copy = { ...element };
      for (const key of ["version", "versionNonce", "updated", "index"])
        delete copy[key];
      return copy;
    });
  for (const type of [
    "rectangle",
    "diamond",
    "ellipse",
    "line",
    "arrow",
    "freedraw",
    "text",
    "frame",
  ]) {
    await page.evaluate(() => globalThis.rm22Api.resetScene());
    if (type === "frame") {
      await page
        .locator("canvas.interactive")
        .click({ position: { x: 900, y: 800 } });
      await page.keyboard.press("f");
    } else {
      await page.getByTestId(`toolbar-${type}`).locator("..").click();
    }
    await page.waitForFunction(
      (type) => globalThis.rm22Api.getAppState().activeTool.type === type,
      type,
    );
    if (type === "text") {
      await page
        .locator("canvas.interactive")
        .click({ position: { x: 600, y: 400 } });
      await page
        .locator("textarea.excalidraw-wysiwyg")
        .fill("RM22 actual text");
      await page.keyboard.press("Escape");
    } else {
      await page.mouse.move(600, 400);
      await page.mouse.down();
      await page.mouse.move(740, 490, { steps: 8 });
      await page.mouse.up();
      await page.keyboard.press("Escape");
    }
    await page.waitForFunction(
      (type) =>
        globalThis.rm22Api.getSceneElements().some((e) => e.type === type),
      type,
    );
    const created = await page.evaluate(() =>
      globalThis.rm22Api.getSceneElements().map((e) => e.type),
    );
    assert.deepEqual(created, [type]);
    const beforeUndo = await page.evaluate(businessElements);
    await page.keyboard.press("Meta+z");
    await page.waitForFunction(
      () => globalThis.rm22Api.getSceneElements().length === 0,
    );
    await page.keyboard.press("Meta+Shift+z");
    await page.waitForFunction(
      (type) =>
        globalThis.rm22Api.getSceneElements().some((e) => e.type === type),
      type,
    );
    assert.deepEqual(
      await page.evaluate(businessElements),
      beforeUndo,
      `${type} upstream history`,
    );
    creations.push({ type, created: true, undo: true, redo: true });
  }
  await page.evaluate(() => globalThis.rm22Root.unmount());
  return {
    scope:
      "Mounted Excalidraw with AnyNote UIOptions; visible controls and real ActionManager shortcut routing. Shortcut side effects are intercepted; not a full interaction or OS clipboard acceptance.",
    modifierMask:
      "1=Ctrl, 2=Meta, 4=Shift, 8=Alt; key codes use physical US keys",
    entries,
    keyboard,
    actions,
    creations,
  };
}
