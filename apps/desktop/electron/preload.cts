import { contextBridge, ipcRenderer } from "electron";

// Preload: exposes only one typed request method to the renderer and never the underlying ipcRenderer.
contextBridge.exposeInMainWorld("anynote", {
  request: (op: string, input: unknown) =>
    ipcRenderer.invoke("anynote:request", { op, input }),
});
