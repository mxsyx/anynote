// Runs inside the reference browser against the pinned upstream functions.
export function geometryCases() {
  const { cropElement, rescalePointsInElement, restoreElements } =
    globalThis.rm22;
  const cases = [];
  const template = (type, properties) =>
    restoreElements(
      [
        {
          id: "subject",
          type,
          x: 50,
          y: 70,
          width: 160,
          height: 100,
          angle: 0,
          seed: 1,
          version: 1,
          versionNonce: 1,
          isDeleted: false,
          groupIds: [],
          frameId: null,
          boundElements: null,
          ...properties,
        },
      ],
      null,
    )[0];
  for (const angle of [0, Math.PI / 3]) {
    for (const scale of [
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ]) {
      for (const aspect of [null, 1.6]) {
        for (const handle of ["n", "s", "w", "e", "nw", "ne", "sw", "se"]) {
          const initial = template("image", {
            angle,
            scale,
            fileId: "sample",
            status: "saved",
            crop: {
              x: 40,
              y: 30,
              width: 320,
              height: 200,
              naturalWidth: 400,
              naturalHeight: 300,
            },
          });
          const local = [
            handle.includes("w") ? 70 : handle.includes("e") ? 180 : 130,
            handle.includes("n") ? 90 : handle.includes("s") ? 140 : 120,
          ];
          const dx = local[0] - 130,
            dy = local[1] - 120;
          const pointer = [
            130 + dx * Math.cos(angle) - dy * Math.sin(angle),
            120 + dx * Math.sin(angle) + dy * Math.cos(angle),
          ];
          const updated = cropElement(
            structuredClone(initial),
            handle,
            400,
            300,
            ...pointer,
            aspect,
          );
          cases.push({
            name: `crop/${angle}/${scale}/${aspect}/${handle}`,
            initial,
            command: {
              kind: "cropImage",
              id: "subject",
              handle,
              natural_width: 400,
              natural_height: 300,
              pointer,
              aspect_ratio: aspect,
            },
            expected: { ...initial, ...updated },
          });
        }
      }
    }
  }
  for (const [handle, pointer] of [
    ["nw", [-100, -100]],
    ["se", [1000, 1000]],
    ["nw", [1000, 1000]],
    ["se", [-100, -100]],
  ]) {
    for (const crop of [
      null,
      {
        x: 40,
        y: 30,
        width: 320,
        height: 200,
        naturalWidth: 400,
        naturalHeight: 300,
      },
    ]) {
      const initial = template("image", {
        scale: [1, 1],
        fileId: "sample",
        status: "saved",
        crop,
      });
      cases.push({
        name: `crop-boundary/${handle}/${pointer}/${!!crop}`,
        initial,
        command: {
          kind: "cropImage",
          id: "subject",
          handle,
          natural_width: 400,
          natural_height: 300,
          pointer,
          aspect_ratio: null,
        },
        expected: {
          ...initial,
          ...cropElement(
            structuredClone(initial),
            handle,
            400,
            300,
            ...pointer,
            null,
          ),
        },
      });
    }
  }
  for (const type of ["line", "arrow", "freedraw"]) {
    for (const points of [
      [
        [0, 0],
        [-30, 20],
      ],
      [
        [0, 0],
        [-20, 50],
        [70, -10],
      ],
      [
        [0, 0],
        [0, 20],
      ],
    ]) {
      const initial = template(type, {
        points,
        pressures: type === "freedraw" ? points.map(() => 0.5) : undefined,
        width:
          Math.max(...points.map((p) => p[0])) -
          Math.min(...points.map((p) => p[0])),
        height:
          Math.max(...points.map((p) => p[1])) -
          Math.min(...points.map((p) => p[1])),
      });
      const geometry = {
        x: 20,
        y: 30,
        width: initial.width * 2,
        height: initial.height * 0.5,
        angle: 0.4,
      };
      cases.push({
        name: `path/${type}/${points.length}/${initial.width}`,
        initial,
        command: { kind: "resizePath", id: "subject", geometry },
        expected: {
          ...initial,
          ...geometry,
          ...rescalePointsInElement(
            initial,
            geometry.width,
            geometry.height,
            false,
          ),
        },
      });
    }
  }
  return JSON.parse(JSON.stringify(cases));
}
