/* eslint-disable @typescript-eslint/no-explicit-any */

// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../global.d.ts" />

import { Folder, Configure, Tag, AllNote, Note, History, Trash } from "../global"

declare global {
  const anynote: Anynote
}

declare module "*.css" {
  const content: any;
  export default content;
}
declare module "*.jpg" {
  const content: any;
  export default content;
}

export {
  Folder, Configure, Tag, AllNote, Note, History, Trash
}
