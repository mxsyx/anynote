import type { SearchLocation } from "@anynote/types";

export type Visit = {
  notebookId: string;
  id: string;
  title: string;
  anchor?: string;
  location?: SearchLocation;
};
export type Navigation = { entries: Visit[]; index: number };

export function recordVisit(state: Navigation, visit: Visit): Navigation {
  const current = state.entries[state.index];
  if (
    current?.notebookId === visit.notebookId &&
    current.id === visit.id &&
    current.anchor === visit.anchor &&
    JSON.stringify(current.location) === JSON.stringify(visit.location)
  )
    return state;
  const entries = [...state.entries.slice(0, state.index + 1), visit].slice(
    -100,
  );
  return { entries, index: entries.length - 1 };
}

/** Replace complete internal destinations, preserving labels and other anchors. */
export function repairLink(body: string, href: string, replacement: string) {
  return body.replace(
    /anynote:\/\/notebook\/[a-f0-9-]{36}\/note\/[a-f0-9-]{36}(?:#[^\s)<>"']*)?/gi,
    (value) => (value === href ? replacement : value),
  );
}
