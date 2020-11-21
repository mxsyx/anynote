import { Remote } from 'electron'
import { Handlers } from './service/types'
import { Folder, Configure, Tag, AllNote, Note, History, Trash } from "./service/entities"

declare global {
  interface Anynote {
    remote: Remote,
    handlers: Handlers
  }
}

export {
  Folder, Configure, Tag, AllNote, Note, History, Trash
}
