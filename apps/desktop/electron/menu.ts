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
          ? [
              { role: "about" as const, label: "关于 Anynote" },
              { type: "separator" as const },
            ]
          : []),
        command("设置…", "settings", "CmdOrCtrl+,"),
        command("插件与扩展…", "extensions"),
        command("备份与恢复…", "backup"),
        command("回收站", "trash"),
        { type: "separator" },
        ...(platform === "darwin"
          ? [
              { role: "services" as const, label: "服务" },
              { type: "separator" as const },
              { role: "hide" as const, label: "隐藏 Anynote" },
              { role: "hideOthers" as const, label: "隐藏其他应用" },
              { role: "unhide" as const, label: "显示全部" },
              { type: "separator" as const },
            ]
          : []),
        { role: "quit", label: "退出 Anynote" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "pasteAndMatchStyle", label: "粘贴并匹配样式" },
        { role: "selectAll", label: "全选" },
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
      submenu: [command("切换深色 / 浅色模式", "theme")],
    },
    {
      role: "help",
      label: "帮助",
      submenu: [{ role: "about", label: "关于 Anynote" }],
    },
  ];
}
