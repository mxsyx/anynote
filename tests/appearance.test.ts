import { describe, expect, it } from "vitest";
import {
  appearanceKey,
  readAppearance,
  toggleAppearance,
} from "../apps/desktop/src/appearance";

describe("appearance preferences", () => {
  it.each(["light", "dark"] as const)("restores %s mode", (mode) => {
    const selected = { mode };
    const restored = readAppearance({
      getItem: (key) =>
        key === appearanceKey ? JSON.stringify(selected) : null,
    });

    expect(restored).toEqual(selected);
  });

  it.each([null, "{", "null", "[]", '{"mode":"unknown"}'])(
    "uses defaults for missing or invalid preferences: %s",
    (value) => {
      expect(readAppearance({ getItem: () => value })).toEqual({
        mode: "light",
      });
    },
  );

  it("remembers the selected mode through switches and reloads", () => {
    const light = readAppearance({ getItem: () => null });
    const night = toggleAppearance(light);
    const restored = readAppearance({ getItem: () => JSON.stringify(night) });

    expect(restored.mode).toBe("dark");
    expect(toggleAppearance(restored)).toEqual(light);
    expect(toggleAppearance(toggleAppearance(restored))).toEqual(night);
  });

  it("uses defaults when storage cannot be read", () => {
    expect(
      readAppearance({
        getItem: () => {
          throw new Error("Storage is unavailable");
        },
      }),
    ).toEqual({
      mode: "light",
    });
  });
});
