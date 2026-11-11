export function transferCases() {
  const { restoreElements, duplicateElements } = globalThis.rm22;
  const shape = (id, type, extra = {}) => ({
    id,
    type,
    x: 40,
    y: 50,
    width: 100,
    height: 80,
    angle: 0,
    seed: 123,
    groupIds: [],
    ...extra,
  });
  const original = restoreElements(
    [
      shape("frame", "frame"),
      shape("shape", "rectangle", {
        frameId: "frame",
        groupIds: ["inner", "outer"],
        boundElements: [
          { id: "label", type: "text" },
          { id: "arrow", type: "arrow" },
        ],
      }),
      shape("label", "text", {
        frameId: "frame",
        groupIds: ["inner", "outer"],
        containerId: "shape",
        text: "label",
        originalText: "label",
        fontFamily: 2,
        fontSize: 20,
        lineHeight: 1.25,
      }),
      shape("arrow", "arrow", {
        points: [
          [0, 0],
          [100, 80],
        ],
        startBinding: { elementId: "shape", gap: 5, focus: 0, future: 17 },
        endBinding: { elementId: "external", gap: 7, focus: 0.5 },
      }),
      shape("image", "image", {
        fileId: "photo",
        scale: [-1, 1],
        locked: true,
        customData: { future: "keep" },
      }),
      shape("image2", "image", { fileId: "photo", scale: [1, 1] }),
    ],
    null,
  );
  const normalize = (elements, files) => {
    const value = { elements: structuredClone(elements), files };
    for (const e of value.elements)
      for (const key of ["version", "versionNonce", "updated", "index"])
        delete e[key];
    return value;
  };
  return [
    ["frame", "shape", "label", "arrow", "image", "image2"],
    ["shape", "label"],
    ["label"],
    ["arrow"],
    ["image", "image2"],
  ].map((selected, index) => {
    const source = original.filter((e) => selected.includes(e.id));
    const copies = duplicateElements(source, { randomizeSeed: true });
    const renamed = new Map(
      copies.map((e, i) => [e.id, `copy-${source[i].id}`]),
    );
    const groups = {};
    for (let i = 0; i < source.length; i++)
      source[i].groupIds.forEach((id, j) => {
        groups[id] = `copy-${id}`;
        renamed.set(copies[i].groupIds[j], groups[id]);
      });
    const ids = {
      elements: Object.fromEntries(source.map((e) => [e.id, `copy-${e.id}`])),
      groups,
      files: selected.includes("image") ? { photo: "new-photo" } : {},
      seeds: Object.fromEntries(source.map((e, i) => [e.id, copies[i].seed])),
    };
    for (const e of copies) {
      e.id = renamed.get(e.id);
      e.groupIds = e.groupIds.map((id) => renamed.get(id));
      for (const key of ["frameId", "containerId"])
        if (e[key]) e[key] = renamed.get(e[key]);
      for (const key of ["startBinding", "endBinding"])
        if (e[key]) e[key].elementId = renamed.get(e[key].elementId);
      for (const bound of e.boundElements || [])
        bound.id = renamed.get(bound.id);
      e.x += 250;
      e.y -= 80;
      if (e.fileId) e.fileId = "new-photo";
    }
    const file = {
      id: "photo",
      resourceId: "resource",
      mimeType: "image/png",
      future: { keep: true },
    };
    const files = selected.includes("image") ? { photo: file } : {};
    const outputFiles = selected.includes("image")
      ? { "new-photo": { ...file, id: "new-photo" } }
      : {};
    return {
      name: `transfer/${index}`,
      initial: { elements: [], files: {} },
      steps: [
        {
          selected: [],
          action: "paste-fragment",
          command: {
            kind: "paste",
            clipboard: { elements: source, files },
            ids,
            delta: [250, -80],
          },
          expected: normalize(copies, outputFiles),
        },
      ],
    };
  });
}

export function libraryCases() {
  const { restoreElements, mergeLibraryItems } = globalThis.rm22;
  const element = restoreElements(
    [
      {
        id: "shape",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 100,
        height: 80,
        angle: 0,
        seed: 91,
      },
    ],
    null,
  )[0];
  const item = (id, elements, extra = {}) => ({
    id,
    status: "unpublished",
    created: 100,
    elements,
    ...extra,
  });
  const local = [item("local", [element], { future: { retain: true } })];
  return [
    [],
    [
      item("same-elements", [structuredClone(element)], {
        status: "published",
      }),
    ],
    [item("changed", [{ ...element, versionNonce: element.versionNonce + 1 }])],
    [item("new", [{ ...element, id: "other" }])],
    [item("two", [element, { ...element, id: "other" }])],
  ].map((incoming, i) => ({
    name: `library-merge/${i}`,
    local,
    incoming,
    expected: mergeLibraryItems(local, incoming),
  }));
}

export function duplicationCases() {
  const { restoreElements, actions, Scene, getDefaultAppState } =
    globalThis.rm22;
  const shape = (id, type, x, extra = {}) => ({
    id,
    type,
    x,
    y: 50,
    width: 100,
    height: 80,
    angle: 0,
    seed: 71,
    ...extra,
  });
  return [["shape", "label"], ["arrow"], ["child"]].map((selected, index) => {
    const elements = restoreElements(
      [
        shape("shape", "rectangle", 40, {
          boundElements: [
            { id: "label", type: "text" },
            { id: "arrow", type: "arrow" },
          ],
        }),
        shape("label", "text", 40, {
          containerId: "shape",
          text: "label",
          originalText: "label",
          fontFamily: 2,
          fontSize: 20,
          lineHeight: 1.25,
        }),
        shape("arrow", "arrow", 200, {
          points: [
            [0, 0],
            [100, 80],
          ],
          startBinding: { elementId: "shape", gap: 5, focus: 0, future: 17 },
        }),
        shape("child", "ellipse", 400, { frameId: "frame" }),
        shape("frame", "frame", 380, { width: 150, height: 150 }),
      ],
      null,
    );
    const initial = { elements: structuredClone(elements), files: {} };
    const scene = new Scene();
    scene.replaceAllElements(elements);
    const state = {
      ...getDefaultAppState(),
      selectedElementIds: Object.fromEntries(selected.map((id) => [id, true])),
    };
    const result = actions
      .find((a) => a.name === "duplicateSelection")
      .perform(elements, state, null, {
        scene,
        props: {},
        getAppState: () => state,
      });
    const copies = result.elements.filter(
      (e) => !elements.some((old) => old.id === e.id),
    );
    const ids = {},
      seeds = {},
      rename = new Map();
    for (const e of copies) {
      const old = elements.find(
        (old) =>
          old.type === e.type && old.x + 10 === e.x && old.y + 10 === e.y,
      );
      if (!old) throw new Error("unidentified duplicate");
      ids[old.id] = `copy-${old.id}`;
      seeds[old.id] = e.seed;
      rename.set(e.id, ids[old.id]);
    }
    const expected = { elements: structuredClone(result.elements), files: {} };
    for (const e of expected.elements) {
      e.id = rename.get(e.id) || e.id;
      for (const key of ["frameId", "containerId"])
        if (e[key]) e[key] = rename.get(e[key]) || e[key];
      for (const key of ["startBinding", "endBinding"])
        if (e[key])
          e[key].elementId = rename.get(e[key].elementId) || e[key].elementId;
      for (const bound of e.boundElements || [])
        bound.id = rename.get(bound.id) || bound.id;
      for (const key of ["version", "versionNonce", "updated", "index"])
        delete e[key];
    }
    scene.destroy();
    return {
      name: `duplicate/${index}`,
      initial,
      steps: [
        {
          selected,
          action: "duplicateSelection",
          command: {
            kind: "duplicate",
            ids,
            groups: {},
            seeds,
            delta: [10, 10],
          },
          expected,
        },
      ],
    };
  });
}
