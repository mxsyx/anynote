// These expectations execute the pinned package, never the Rust implementation.
export function bindingCases() {
  const {
    restoreElements,
    Scene,
    updateBoundElements,
    mutateElement,
    LinearElementEditor,
    cropElement,
    rescalePointsInElement,
    actions,
    getDefaultAppState,
  } = globalThis.rm22;
  const traces = [];
  const shape = (id, type, x, y, width, height, extra = {}) => ({
    id,
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    seed: 1,
    roughness: 1,
    version: 1,
    versionNonce: 1,
    groupIds: [],
    frameId: null,
    boundElements: null,
    ...extra,
  });
  const normalize = (elements) => {
    const value = {
      elements: structuredClone(elements),
      files: {},
      appState: {},
    };
    for (const element of value.elements)
      for (const key of ["version", "versionNonce", "updated", "index"])
        delete element[key];
    return value;
  };
  for (const type of ["rectangle", "diamond", "ellipse", "image"]) {
    for (const angle of [0, 0.7]) {
      for (const focus of [0, -0.6, 0.7]) {
        for (const roundness of [null, { type: type === "diamond" ? 2 : 3 }]) {
          const elements = restoreElements(
            [
              shape("target", type, 40, 60, 120, 80, {
                angle,
                roundness,
                scale: [1, 1],
                crop: null,
                fileId: "sample",
                boundElements: [{ id: "arrow", type: "arrow" }],
              }),
              shape("other", "rectangle", 360, 200, 80, 60, {
                boundElements: [{ id: "arrow", type: "arrow" }],
              }),
              shape("arrow", "arrow", 170, 100, 180, 120, {
                points: [
                  [0, 0],
                  [180, 120],
                ],
                roundness: null,
                startBinding: {
                  elementId: "target",
                  focus,
                  gap: 5,
                  future: "preserved",
                },
                endBinding: { elementId: "other", focus: 0.2, gap: 3 },
              }),
            ],
            null,
          );
          const scene = new Scene();
          scene.replaceAllElements(elements);
          const initial = {
            elements: structuredClone(elements),
            files: {},
            appState: {},
          };
          const steps = [];
          const target = elements[0];
          for (const delta of [
            [20, 30],
            [-80, 45],
          ]) {
            mutateElement(target, {
              x: target.x + delta[0],
              y: target.y + delta[1],
            });
            updateBoundElements(target, scene.getNonDeletedElementsMap());
            steps.push({
              selected: ["target"],
              action: "translate-bound-target",
              command: { kind: "translate", delta },
              expected: normalize(elements),
            });
          }
          const geometry = {
            x: target.x + 15,
            y: target.y - 30,
            width: 180,
            height: 50,
            angle: angle + 0.2,
          };
          mutateElement(target, geometry);
          updateBoundElements(target, scene.getNonDeletedElementsMap());
          steps.push({
            selected: ["target"],
            action: "resize-bound-target",
            command: { kind: "geometry", id: "target", geometry },
            expected: normalize(elements),
          });
          if (type === "image") {
            const pointer = [target.x + 30, target.y + 20];
            const update = cropElement(
              target,
              "nw",
              400,
              300,
              ...pointer,
              null,
            );
            mutateElement(target, update);
            updateBoundElements(target, scene.getNonDeletedElementsMap());
            steps.push({
              selected: ["target"],
              action: "crop-bound-image",
              command: {
                kind: "cropImage",
                id: "target",
                handle: "nw",
                natural_width: 400,
                natural_height: 300,
                pointer,
                aspect_ratio: null,
              },
              expected: normalize(elements),
            });
          }
          const arrow = elements.find((e) => e.id === "arrow");
          const resized = {
            x: arrow.x + 10,
            y: arrow.y - 5,
            width: arrow.width * 1.5,
            height: arrow.height * 0.75,
            angle: 0.3,
          };
          mutateElement(arrow, {
            ...resized,
            ...rescalePointsInElement(
              arrow,
              resized.width,
              resized.height,
              false,
            ),
          });
          steps.push({
            selected: ["arrow"],
            action: "resize-open-bound-path",
            command: { kind: "resizePath", id: "arrow", geometry: resized },
            expected: normalize(elements),
          });
          const state = {
            ...getDefaultAppState(),
            selectedElementIds: { arrow: true },
          };
          const result = actions
            .find((a) => a.name === "flipHorizontal")
            .perform(elements, state, null, {
              scene,
              getAppState: () => state,
            });
          elements.splice(0, elements.length, ...result.elements);
          scene.replaceAllElements(elements);
          steps.push({
            selected: ["arrow"],
            action: "flip-bound-arrowheads",
            command: { kind: "flip", axis: "x" },
            expected: normalize(elements),
          });
          traces.push({
            name: `binding/${type}/${angle}/${focus}/${!!roundness}`,
            initial,
            steps,
          });
          scene.destroy();
        }
      }
    }
  }
  for (const type of ["line", "arrow"])
    for (const angle of [0, 0.6]) {
      const elements = restoreElements(
        [
          shape("path", type, 80, 90, 120, 70, {
            angle,
            points: [
              [0, 0],
              [-40, 70],
              [80, -20],
            ],
            roundness: null,
          }),
        ],
        null,
      );
      const scene = new Scene();
      scene.replaceAllElements(elements);
      const initial = {
        elements: structuredClone(elements),
        files: {},
        appState: {},
      };
      const steps = [];
      for (const updates of [
        { 0: [25, -10] },
        { 1: [-30, 100], 2: [120, 40] },
      ]) {
        LinearElementEditor.movePoints(
          elements[0],
          Object.entries(updates).map(([index, point]) => ({
            index: Number(index),
            point,
          })),
        );
        steps.push({
          selected: ["path"],
          action: "move-control-points",
          command: {
            kind: "movePoints",
            id: "path",
            updates: Object.entries(updates).map(([i, p]) => [Number(i), p]),
          },
          expected: normalize(elements),
        });
      }
      traces.push({ name: `control-points/${type}/${angle}`, initial, steps });
      scene.destroy();
    }
  return JSON.parse(JSON.stringify(traces));
}

export function editingCases() {
  const { actions, restoreElements, getDefaultAppState, Scene } =
    globalThis.rm22;
  const shape = (id, extra = {}) => ({
    id,
    type: "rectangle",
    x: 10,
    y: 20,
    width: 80,
    height: 60,
    angle: 0,
    seed: 1,
    roughness: 1,
    roundness: null,
    groupIds: [],
    frameId: null,
    boundElements: null,
    ...extra,
  });
  const scenarios = [
    ...["outer", "inner"].flatMap((editingGroupId) =>
      ["b", "c", "d"]
        .filter((id) => editingGroupId !== "inner" || id !== "d")
        .map((id) => ({
          name: `editing/${editingGroupId}/${id}`,
          editingGroupId,
          elements: [
            shape("a"),
            shape("b", { groupIds: ["inner", "outer"] }),
            shape("c", { groupIds: ["inner", "outer"] }),
            shape("d", { groupIds: ["outer"] }),
            shape("e"),
          ],
          selected:
            editingGroupId === "outer" && id !== "d" ? ["b", "c"] : [id],
          operations: [
            ["bringForward", { kind: "layer", layer: "forward" }],
            ["sendToBack", { kind: "layer", layer: "back" }],
            ["bringToFront", { kind: "layer", layer: "front" }],
            ["sendBackward", { kind: "layer", layer: "backward" }],
          ],
        })),
    ),
    ...["line", "arrow", "freedraw"].flatMap((type) =>
      [0, 0.6].map((angle) => ({
        name: `flip/${type}/${angle}`,
        elements: [
          shape("path", {
            type,
            angle,
            points: [
              [0, 0],
              [-40, 70],
              [80, -20],
            ],
            pressures: [0.2, 0.8, 0.5],
            simulatePressure: false,
          }),
        ],
        selected: ["path"],
        operations: [
          ["flipHorizontal", { kind: "flip", axis: "x" }],
          ["flipVertical", { kind: "flip", axis: "y" }],
        ],
      })),
    ),
  ];
  return scenarios.map((scenario) => {
    let elements = restoreElements(scenario.elements, null);
    const initial = { elements: structuredClone(elements), files: {} };
    const scene = new Scene();
    let state = {
      ...getDefaultAppState(),
      editingGroupId: scenario.editingGroupId ?? null,
      selectedElementIds: Object.fromEntries(
        scenario.selected.map((id) => [id, true]),
      ),
    };
    const app = {
      scene,
      getAppState: () => state,
      device: { editor: { isMobile: false } },
    };
    const steps = [];
    for (const [action, command] of scenario.operations) {
      scene.replaceAllElements(elements);
      const result = actions
        .find((a) => a.name === action)
        .perform(elements, state, null, app);
      elements = result.elements;
      state = { ...state, ...result.appState };
      const expected = { elements: structuredClone(elements), files: {} };
      for (const e of expected.elements)
        for (const key of ["version", "versionNonce", "updated", "index"])
          delete e[key];
      steps.push({ action, command, selected: scenario.selected, expected });
    }
    scene.destroy();
    return {
      name: scenario.name,
      editingGroup: scenario.editingGroupId ?? null,
      initial,
      steps,
    };
  });
}

export function frameCases() {
  const {
    restoreElements,
    Scene,
    mutateElement,
    getDefaultAppState,
    getElementsInResizingFrame,
    replaceAllElementsInFrame,
  } = globalThis.rm22;
  const shape = (id, x, y, extra = {}) => ({
    id,
    type: "rectangle",
    x,
    y,
    width: 40,
    height: 30,
    angle: 0,
    seed: 1,
    roughness: 1,
    groupIds: [],
    frameId: null,
    boundElements: null,
    ...extra,
  });
  return [0, 0.6].flatMap((angle) =>
    ["rectangle", "ellipse", "diamond", "line"].map((type) => {
      let elements = restoreElements(
        [
          shape("frame", 0, 0, {
            type: "frame",
            width: 200,
            height: 200,
            name: "Frame",
          }),
          shape("inside", 40, 40, {
            type,
            angle,
            points: [
              [0, 0],
              [40, 30],
            ],
            frameId: "frame",
          }),
          shape("edge", 185, 185, { angle, frameId: "frame" }),
          shape("outside", 250, 250, { angle }),
          shape("g1", 40, 100, { groupIds: ["group"], frameId: "frame" }),
          shape("g2", 210, 100, { groupIds: ["group"], frameId: "frame" }),
          shape("h1", 220, 50, { groupIds: ["other"] }),
          shape("h2", 260, 50, { groupIds: ["other"] }),
          shape("container", 80, 80, {
            boundElements: [{ id: "label", type: "text" }],
            frameId: "frame",
          }),
          shape("label", 80, 80, {
            type: "text",
            containerId: "container",
            frameId: "frame",
            text: "test",
            originalText: "test",
            fontSize: 20,
            fontFamily: 1,
            lineHeight: 1.25,
          }),
        ],
        null,
      );
      const initial = { elements: structuredClone(elements), files: {} };
      const scene = new Scene();
      scene.replaceAllElements(elements);
      const state = {
        ...getDefaultAppState(),
        selectedElementIds: { frame: true },
      };
      const app = { scene, state };
      const steps = [];
      for (const [x, y, width, height] of [
        [0, 0, 100, 100],
        [20, 20, 300, 260],
        [120, 80, 100, 100],
      ]) {
        const geometry = { x, y, width, height, angle: 0 };
        const frame = elements.find((e) => e.id === "frame");
        mutateElement(frame, geometry);
        const next = getElementsInResizingFrame(
          elements,
          frame,
          state,
          scene.getNonDeletedElementsMap(),
        );
        elements = replaceAllElementsInFrame(elements, next, frame, app);
        scene.replaceAllElements(elements);
        const expected = { elements: structuredClone(elements), files: {} };
        for (const e of expected.elements)
          for (const key of ["version", "versionNonce", "updated", "index"])
            delete e[key];
        steps.push({
          selected: ["frame"],
          action: "resize-frame-membership",
          command: { kind: "resizeFrame", id: "frame", geometry },
          expected,
        });
      }
      scene.destroy();
      return { name: `frame/${type}/${angle}`, initial, steps };
    }),
  );
}

export function topologyCases() {
  const { restoreElements, Scene, mutateElement, updateBoundElements } =
    globalThis.rm22;
  const shape = (id, x, y, extra = {}) => ({
    id,
    type: "rectangle",
    x,
    y,
    width: 100,
    height: 80,
    angle: 0,
    seed: 1,
    roughness: 1,
    roundness: null,
    groupIds: [],
    frameId: null,
    boundElements: [{ id: "arrow", type: "arrow" }],
    ...extra,
  });
  const cases = [];
  for (const overlap of [false, true])
    for (const angle of [0, 0.4])
      for (const multipoint of [false, true])
        for (const selection of [["a"], ["a", "b"], ["a", "b", "arrow"]]) {
          const elements = restoreElements(
            [
              shape("a", 50, 50, { type: "ellipse", angle: 0.7 }),
              shape("b", overlap ? 100 : 350, overlap ? 80 : 170),
              shape("arrow", 170, 90, {
                type: "arrow",
                width: 180,
                height: 100,
                angle,
                boundElements: null,
                points: multipoint
                  ? [
                      [0, 0],
                      [90, -30],
                      [180, 100],
                    ]
                  : [
                      [0, 0],
                      [180, 100],
                    ],
                startBinding: { elementId: "a", gap: 5, focus: -0.4 },
                endBinding: { elementId: "b", gap: 4, focus: 0.2 },
              }),
            ],
            null,
          );
          const initial = { elements: structuredClone(elements), files: {} };
          const scene = new Scene();
          scene.replaceAllElements(elements);
          const steps = [];
          for (const delta of [
            [20, 25],
            [-30, -15],
          ]) {
            const selected = elements.filter((e) => selection.includes(e.id));
            for (const e of selected)
              mutateElement(e, { x: e.x + delta[0], y: e.y + delta[1] });
            for (const e of selected)
              updateBoundElements(e, scene.getNonDeletedElementsMap(), {
                simultaneouslyUpdated: selected,
              });
            const expected = { elements: structuredClone(elements), files: {} };
            for (const e of expected.elements)
              for (const key of ["version", "versionNonce", "updated", "index"])
                delete e[key];
            steps.push({
              selected: selection,
              action: "translate-connected-selection",
              command: { kind: "translate", delta },
              expected,
            });
          }
          scene.destroy();
          cases.push({
            name: `topology/${overlap}/${angle}/${multipoint}/${selection}`,
            initial,
            steps,
          });
        }
  return cases;
}
