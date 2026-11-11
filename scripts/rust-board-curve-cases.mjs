// Run only in the pinned browser reference; expected values come from Excalidraw.
export function curveCases() {
  const {
    restoreElements,
    Scene,
    LinearElementEditor,
    actions,
    getDefaultAppState,
    mutateElement,
    updateBoundElements,
  } = globalThis.rm22;
  const traces = [];
  const normalize = (elements) => {
    const result = { elements: structuredClone(elements), files: {} };
    for (const e of result.elements)
      for (const key of ["version", "versionNonce", "updated", "index"])
        delete e[key];
    return result;
  };
  for (const type of ["line", "arrow"])
    for (const roughness of [0, 1, 2.5])
      for (const strokeStyle of ["solid", "dashed"])
        for (const angle of [0, 0.6, -1.3]) {
          let elements = restoreElements(
            [
              {
                id: "path",
                type,
                x: 80,
                y: 90,
                width: 120,
                height: 90,
                angle,
                seed: 137,
                roughness,
                strokeStyle,
                roundness: { type: 2 },
                points: [
                  [0, 0],
                  [-40, 70],
                  [80, -20],
                ],
                customData: { future: ["retained", 42] },
              },
            ],
            null,
          );
          const initial = { elements: structuredClone(elements), files: {} };
          const scene = new Scene();
          scene.replaceAllElements(elements);
          const steps = [];
          const record = (action, command, selected = ["path"]) =>
            steps.push({
              action,
              command,
              selected,
              expected: normalize(elements),
            });
          for (const updates of [
            [[0, [25, -10]]],
            [
              [1, [-30, 100]],
              [2, [120, 40]],
            ],
          ]) {
            LinearElementEditor.movePoints(
              elements[0],
              updates.map(([index, point]) => ({ index, point })),
            );
            record("move-curve-points", {
              kind: "movePoints",
              id: "path",
              updates,
            });
          }
          const added = [
            [140, -35],
            [180, 65],
          ];
          LinearElementEditor.addPoints(
            elements[0],
            added.map((point) => ({ point })),
          );
          record("append-curve-points", {
            kind: "addPoints",
            id: "path",
            points: added,
          });
          LinearElementEditor.deletePoints(elements[0], [0, 2]);
          record("delete-curve-origin-and-interior", {
            kind: "deletePoints",
            id: "path",
            indices: [0, 2],
          });
          for (const [action, axis] of [
            ["flipHorizontal", "x"],
            ["flipVertical", "y"],
          ]) {
            const state = {
              ...getDefaultAppState(),
              selectedElementIds: { path: true },
            };
            const result = actions
              .find((a) => a.name === action)
              .perform(elements, state, null, {
                scene,
                getAppState: () => state,
              });
            elements = result.elements;
            scene.replaceAllElements(elements);
            record(action, { kind: "flip", axis });
          }
          traces.push({
            name: `curve/${type}/${roughness}/${strokeStyle}/${angle}`,
            initial,
            steps,
          });
          scene.destroy();
        }
  for (const type of ["rectangle", "ellipse", "diamond"])
    for (const angle of [0, 0.7]) {
      const elements = restoreElements(
        [
          {
            id: "target",
            type,
            x: 40,
            y: 60,
            width: 120,
            height: 80,
            angle: 0.3,
            boundElements: [{ id: "path", type: "arrow" }],
            seed: 17,
          },
          {
            id: "path",
            type: "arrow",
            x: 170,
            y: 100,
            width: 180,
            height: 120,
            angle,
            seed: 135,
            roughness: 1,
            roundness: { type: 2 },
            points: [
              [0, 0],
              [90, -30],
              [180, 120],
            ],
            startBinding: { elementId: "target", focus: -0.4, gap: 5 },
          },
        ],
        null,
      );
      const initial = { elements: structuredClone(elements), files: {} };
      const scene = new Scene();
      scene.replaceAllElements(elements);
      const steps = [];
      for (const delta of [
        [20, 30],
        [-80, 45],
      ]) {
        mutateElement(elements[0], {
          x: elements[0].x + delta[0],
          y: elements[0].y + delta[1],
        });
        updateBoundElements(elements[0], scene.getNonDeletedElementsMap());
        steps.push({
          action: "move-curved-binding-target",
          command: { kind: "translate", delta },
          selected: ["target"],
          expected: normalize(elements),
        });
      }
      traces.push({ name: `curve-binding/${type}/${angle}`, initial, steps });
      scene.destroy();
    }
  return JSON.parse(JSON.stringify(traces));
}
