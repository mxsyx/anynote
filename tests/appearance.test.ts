import { describe, expect, it } from "vitest";
import {
  appearanceKey,
  palettes,
  readAppearance,
  selectPalette,
  toggleAppearance,
} from "../apps/desktop/src/appearance";

describe("appearance preferences", () => {
  it.each(palettes)(
    "restores $name with its editor color scheme",
    (palette) => {
      const selected = selectPalette(palette.id);
      const restored = readAppearance({
        getItem: (key) =>
          key === appearanceKey ? JSON.stringify(selected) : null,
      });

      expect(restored).toEqual(selected);
      expect(restored.mode).toBe(palette.dark ? "dark" : "light");
      expect(restored[restored.mode]).toBe(palette.id);
    },
  );

  it.each([null, "{", '{"mode":"unknown","light":"unknown","dark":"unknown"}'])(
    "uses defaults for missing or invalid preferences: %s",
    (value) => {
      expect(readAppearance({ getItem: () => value })).toEqual(
        selectPalette("cream-sage"),
      );
    },
  );

  it("remembers both palettes through mode switches and reloads", () => {
    const light = selectPalette("parchment-yellow");
    const night = selectPalette("sea-mist", light);
    const restored = readAppearance({ getItem: () => JSON.stringify(night) });

    expect(toggleAppearance(restored)).toEqual({
      mode: "light",
      light: "parchment-yellow",
      dark: "sea-mist",
    });
    expect(toggleAppearance(toggleAppearance(restored))).toEqual(night);
    expect(selectPalette("deep-pine", restored).light).toBe("parchment-yellow");
    expect(selectPalette("linen-stone", restored).dark).toBe("sea-mist");
  });

  it("rejects palettes saved in the wrong mode", () => {
    expect(
      readAppearance({
        getItem: () =>
          '{"mode":"dark","light":"deep-pine","dark":"linen-stone"}',
      }),
    ).toEqual({ mode: "dark", light: "cream-sage", dark: "slate-blue-green" });
  });

  it("leaves the selection unchanged for an unknown palette", () => {
    const appearance = selectPalette("midnight-sand");

    expect(selectPalette("unknown", appearance)).toEqual(appearance);
  });
});
