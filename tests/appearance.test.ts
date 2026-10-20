import { describe, expect, it } from "vitest";
import {
  appearanceKey,
  palettes,
  papers,
  selectPaper,
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
      paper: "plain",
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
    ).toEqual({
      mode: "dark",
      light: "cream-sage",
      dark: "slate-blue-green",
      paper: "plain",
    });
  });

  it("leaves the selection unchanged for an unknown palette", () => {
    const appearance = selectPalette("midnight-sand");

    expect(selectPalette("unknown", appearance)).toEqual(appearance);
  });
  it.each(papers)(
    "persists $name independently of palette and mode",
    (paper) => {
      const selected = selectPaper(paper.id, selectPalette("linen-stone"));
      const changed = toggleAppearance(selectPalette("sea-mist", selected));

      expect(changed.paper).toBe(paper.id);
      expect(
        readAppearance({ getItem: () => JSON.stringify(changed) }),
      ).toEqual(changed);
    },
  );

  it("falls back to plain paper for invalid saved textures", () => {
    expect(readAppearance({ getItem: () => '{"paper":"unknown"}' }).paper).toBe(
      "plain",
    );
  });
});
