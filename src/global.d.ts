import Electron from 'electron'
import service from './service'

declare global {
  interface Anynote {
    remote: Electron.Remote,
    handlers: {
      folder: service.handlers.FolderHandler,
      notes: service.handlers.NoteHanlder,
      historys: service.handlers.HistoryHandler,
      tag: service.handlers.TagHandler,
      star: service.handlers.StarHandler,
      trash: service.handlers.TrashHandler,
      configure: service.handlers.ConfigureHandler
    }
  }

  // eslint-disable-next-line no-var
  export var anynote: Anynote
}
