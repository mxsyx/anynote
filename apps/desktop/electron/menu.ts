import { editorCommands } from "@anynote/types/editor-commands.js";
import type { MenuItemConstructorOptions } from "electron";
import type { AppMenuCommand } from "@anynote/types";

/** Build native menus without exposing Electron objects to the renderer. */
export function applicationMenu(
  platform: string,
  dispatch: (command: AppMenuCommand) => void,
): MenuItemConstructorOptions[] {
  const command = (
    label: string,
    id: AppMenuCommand,
    accelerator?: string,
  ): MenuItemConstructorOptions => ({
    id,
    label,
    accelerator,
    click: () => dispatch(id),
  });

  return [
    {
      label: platform === "darwin" ? "Anynote" : "应用",
      submenu: [
        ...(platform === "darwin"
          ? [{ role: "about" as const }, { type: "separator" as const }]
          : []),
        command("设置…", "settings", "CmdOrCtrl+,"),
        command("插件与扩展…", "extensions"),
        command("备份与恢复…", "backup"),
        command("回收站", "trash"),
        { type: "separator" },
        ...(platform === "darwin"
          ? [
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
            ]
          : []),
        { role: "quit" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "selectAll" },
        { type: "separator" },
        {
          label: "插入内容",
          submenu: editorCommands.map(([id, label]) =>
            command(label, `insert.${id}`),
          ),
        },
      ],
    },
    {
      label: "显示",
      submenu: [
        command("切换深色 / 浅色模式", "theme"),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
}
