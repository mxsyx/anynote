export function orderCases() {
  const { actions, getDefaultAppState, restoreElements, Scene } =
    globalThis.rm22;
  const shape = (id, properties = {}) => ({
    id,
    type: "rectangle",
    x: 50,
    y: 50,
    width: 100,
    height: 50,
    angle: 0,
    seed: 1,
    version: 1,
    versionNonce: 1,
    groupIds: [],
    frameId: null,
    boundElements: null,
    ...properties,
  });
  const scenarios = [
    {
      name: "cross-nested-group",
      elements: [
        shape("a"),
        shape("b", { groupIds: ["inner", "outer"] }),
        shape("c", { groupIds: ["inner", "outer"] }),
        shape("d", { groupIds: ["outer"] }),
        shape("e"),
      ],
      selections: [["a"], ["b", "c", "d"], ["e"], ["a", "e"]],
    },
    {
      name: "frame-children-and-outsiders",
      elements: [
        shape("a", { frameId: "f" }),
        shape("b", { frameId: "f" }),
        shape("f", { type: "frame", name: null }),
        shape("c"),
        shape("d"),
        shape("e", { frameId: "h" }),
        shape("g", { frameId: "h" }),
        shape("h", { type: "frame", name: null }),
      ],
      selections: [
        ["a"],
        ["b"],
        ["c"],
        ["a", "b", "f"],
        ["a", "e"],
        ["c", "e", "g", "h"],
      ],
    },
    {
      name: "bound-label-and-tombstones",
      elements: [
        shape("a"),
        shape("dead1", { isDeleted: true }),
        shape("b", { boundElements: [{ id: "text", type: "text" }] }),
        shape("text", {
          type: "text",
          containerId: "b",
          text: "label",
          originalText: "label",
          fontSize: 20,
          fontFamily: 1,
          lineHeight: 1.25,
          textAlign: "center",
          verticalAlign: "middle",
          autoResize: true,
        }),
        shape("dead2", { isDeleted: true }),
        shape("c"),
        shape("d"),
      ],
      selections: [["a"], ["b", "text"], ["a", "c"], ["d"]],
    },
  ];
  const traces = [];
  for (const scenario of scenarios) {
    for (const selected of scenario.selections) {
      const initial = {
        elements: restoreElements(scenario.elements, null),
        files: {},
      };
      const scene = new Scene();
      let elements = structuredClone(initial.elements);
      let state = {
        ...getDefaultAppState(),
        selectedElementIds: Object.fromEntries(
          selected.map((id) => [id, true]),
        ),
      };
      const app = {
        scene,
        getAppState: () => state,
        device: { editor: { isMobile: false } },
      };
      const steps = [];
      for (const [action, layer] of [
        ["bringForward", "forward"],
        ["sendBackward", "backward"],
        ["bringToFront", "front"],
        ["sendToBack", "back"],
        ["sendBackward", "backward"],
        ["bringForward", "forward"],
      ]) {
        scene.replaceAllElements(elements);
        const result = actions
          .find((a) => a.name === action)
          .perform(elements, state, null, app);
        elements = result.elements;
        state = { ...state, ...result.appState };
        const expected = structuredClone({ ...initial, elements });
        for (const element of expected.elements)
          for (const key of ["version", "versionNonce", "updated", "index"])
            delete element[key];
        steps.push({
          action,
          selected,
          command: { kind: "layer", layer },
          expected,
        });
      }
      scene.destroy();
      traces.push({ name: `${scenario.name}/${selected}`, initial, steps });
    }
  }
  return JSON.parse(JSON.stringify(traces));
}
