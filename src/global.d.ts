/* eslint-disable @typescript-eslint/no-explicit-any */
interface Window {
  electron: {
    ipcRenderer: Electron.IpcRenderer;
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
