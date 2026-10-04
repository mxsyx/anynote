import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("anynote", {
  request: (op: string, input: unknown) =>
    ipcRenderer.invoke("anynote:request", { op, input }),
});
