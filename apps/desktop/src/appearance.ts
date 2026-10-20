export type Appearance = {
  mode: "light" | "dark";
};

export const appearanceKey = "anynote.appearance";

const defaultAppearance: Appearance = {
  mode: "light",
};

export function readAppearance(storage: Pick<Storage, "getItem">): Appearance {
  try {
    const saved = JSON.parse(storage.getItem(appearanceKey) ?? "null");

    return {
      mode: saved?.mode === "dark" ? "dark" : "light",
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
