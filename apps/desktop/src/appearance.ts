export const palettes = [
  { id: "cream-sage", name: "奶油鼠尾草", dark: false },
  { id: "linen-stone", name: "亚麻岩灰", dark: false },
  { id: "parchment-yellow", name: "羊皮纸黄", dark: false },
  { id: "slate-blue-green", name: "深灰蓝绿", dark: true },
  { id: "midnight-sand", name: "午夜暖沙", dark: true },
  { id: "deep-pine", name: "深松林松", dark: true },
  { id: "sea-mist", name: "深海雾蓝", dark: true },
] as const;

export const papers = [
  { id: "plain", name: "纯色纸张" },
  { id: "parchment", name: "羊皮纸" },
  { id: "stone", name: "岩石" },
  { id: "bamboo", name: "竹简" },
] as const;

type Preset = (typeof palettes)[number];
export type Appearance = {
  mode: "light" | "dark";
  light: Extract<Preset, { dark: false }>["id"];
  dark: Extract<Preset, { dark: true }>["id"];
  paper: (typeof papers)[number]["id"];
};

export const appearanceKey = "anynote.appearance";

const defaultAppearance: Appearance = {
  mode: "light",
  light: "cream-sage",
  dark: "slate-blue-green",
  paper: "plain",
};

export function selectPaper(id: string, appearance: Appearance): Appearance {
  const paper = papers.find((item) => item.id === id);

  return paper ? { ...appearance, paper: paper.id } : { ...appearance };
}

export function selectPalette(
  id: string,
  appearance: Appearance = defaultAppearance,
): Appearance {
  const palette = palettes.find((item) => item.id === id);

  if (!palette) return { ...appearance };

  return palette.dark
    ? { ...appearance, mode: "dark", dark: palette.id }
    : { ...appearance, mode: "light", light: palette.id };
}

export function readAppearance(storage: Pick<Storage, "getItem">): Appearance {
  try {
    const saved = JSON.parse(storage.getItem(appearanceKey) ?? "null");
    const light = palettes.find(
      (item) => item.id === saved?.light && !item.dark,
    );
    const dark = palettes.find((item) => item.id === saved?.dark && item.dark);

    return {
      mode: saved?.mode === "dark" ? "dark" : "light",
      light: light && !light.dark ? light.id : defaultAppearance.light,
      dark: dark?.dark ? dark.id : defaultAppearance.dark,
      paper:
        papers.find((item) => item.id === saved?.paper)?.id ??
        defaultAppearance.paper,
    };
  } catch {
    return { ...defaultAppearance };
  }
}

export function toggleAppearance(appearance: Appearance): Appearance {
  return {
    ...appearance,
    mode: appearance.mode === "dark" ? "light" : "dark",
  };
}
