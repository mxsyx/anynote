import { editorCommands } from "../packages/types/src/editor-commands";
import { describe, expect, it } from "vitest";
import { applicationMenu } from "../apps/desktop/electron/menu";
import type { AppMenuCommand } from "@anynote/types";
import type { MenuItemConstructorOptions } from "electron";

describe("native application menu", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    it(`dispatches app actions and retains standard menus on ${platform}`, () => {
      const received: AppMenuCommand[] = [];
      const menu = applicationMenu(platform, (command) =>
        received.push(command),
      );
      const entries = menu.flatMap((item) =>
        Array.isArray(item.submenu) ? item.submenu : [],
      ) as MenuItemConstructorOptions[];

      for (const id of ["settings", "extensions", "backup", "trash", "theme"]) {
        const item = entries.find((entry) => entry.id === id)!;
        expect(item).toBeDefined();
        item.click?.({} as never, undefined, {} as never);
        expect(received.at(-1)).toBe(id);
      }

      expect(entries.find((item) => item.id === "settings")?.accelerator).toBe(
        "CmdOrCtrl+,",
      );
      const edit = menu.find((item) => item.label === "编辑")!;
      const editing = edit.submenu as MenuItemConstructorOptions[];
      expect(editing.map((item) => item.role)).toEqual(
        expect.arrayContaining([
          "undo",
          "redo",
          "cut",
          "copy",
          "paste",
          "selectAll",
        ]),
      );
      const insert = editing.find((item) => item.label === "插入内容")!
        .submenu as MenuItemConstructorOptions[];
      expect(insert.map((item) => item.label)).toEqual(
        editorCommands.map(([, label]) => label),
      );
      for (const [id] of editorCommands) {
        const item = insert.find((entry) => entry.id === `insert.${id}`)!;
        item.click?.({} as never, undefined, {} as never);
        expect(received.at(-1)).toBe(`insert.${id}`);
      }
      expect(menu.some((item) => item.role === "windowMenu")).toBe(true);
      expect(entries.some((item) => item.role === "quit")).toBe(true);
      expect(entries.some((item) => item.role === "services")).toBe(
        platform === "darwin",
      );
    });
  }
});
