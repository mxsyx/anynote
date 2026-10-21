import { test, expect } from "vitest";
import {
  recordVisit,
  repairLink,
  type Navigation,
} from "../apps/desktop/src/navigation";

test("history retains cross-book identities and anchors, skips duplicate visits and truncates the forward branch", () => {
  let state: Navigation = { entries: [], index: -1 };
  const a = { notebookId: "a", id: "same", title: "A" };
  state = recordVisit(state, a);
  expect(recordVisit(state, a)).toBe(state);
  state = recordVisit(state, { ...a, notebookId: "b", anchor: "pdf-page-3" });
  expect(state.entries).toHaveLength(2);
  state = recordVisit({ ...state, index: 0 }, { ...a, id: "new" });
  expect(state.entries.map((v) => v.id)).toEqual(["same", "new"]);
  for (let i = 0; i < 110; i++)
    state = recordVisit(state, { ...a, id: String(i) });
  expect(state.entries).toHaveLength(100);
  expect(state.index).toBe(99);
});

test("repair replaces exact destinations without changing labels or unrelated anchors", () => {
  const href =
    "anynote://notebook/11111111-1111-4111-8111-111111111111/note/22222222-2222-4222-8222-222222222222";
  expect(
    repairLink(
      `[label](${href}) [page](${href}#pdf-page-3) <${href}>`,
      href,
      "replacement",
    ),
  ).toBe(`[label](replacement) [page](${href}#pdf-page-3) <replacement>`);
});
