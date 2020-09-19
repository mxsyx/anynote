/* eslint-disable @typescript-eslint/no-explicit-any */

/// <reference types="electron" />

interface Window {
  electron: typeof Electron
}

declare module "*.css" {
  const content: any;
  export default content;
}
declare module "*.jpg" {
  const content: any;
  export default content;
}
