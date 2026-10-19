import type { AppMenuCommand } from "@anynote/types";
import { contextBridge, ipcRenderer } from "electron";

// Preload: exposes typed requests and menu subscriptions to the renderer and never the underlying ipcRenderer.
contextBridge.exposeInMainWorld("anynote", {
  // Keep Electron event objects inside the isolated preload context.
  onMenuCommand: (listener: (command: AppMenuCommand) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      command: AppMenuCommand,
    ) => listener(command);
    ipcRenderer.on("anynote:menu", handler);
    return () => ipcRenderer.removeListener("anynote:menu", handler);
  },
  request: (op: string, input: unknown) =>
    ipcRenderer.invoke("anynote:request", { op, input }),
});
