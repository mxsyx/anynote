/* eslint-disable @typescript-eslint/no-explicit-any */
interface Window {
  electron: {
    ipcRenderer: Electron.IpcRenderer,
    remote: Electron.Remote
  };
}

declare module "*.css" {
  const content: any;
  export default content;
}
declare module "*.jpg" {
  const content: any;
  export default content;
}
