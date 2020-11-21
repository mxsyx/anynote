/*
 * File: /src/preload.js
 * Author: Mxsyx (mxsyxin@gmail.com)
 * Created At: 2020-10-11 08:06:24
 * -----
 * Last Modified: 2020-11-20 07:09:36
 * Modified By: Mxsyx (mxsyxin@gmail.com>)
 * -----
 * Lisense: GNU General Public License v3
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const service = require('./service')

const anynote = {
  remote: require('electron').remote,
  handlers: {
    folder: null,
    notes: null,
    historys: null,
    tag: null,
    star: null,
    trash: null,
    configure: null
  }
}

const dbInitedEvent = new Event('dbInited', { bubbles: true, cancelable: false })

;(function () {
  const {
    Storage,
    handlers: {
      FolderHandler,
      NodeHandler,
      HistoryHanlder,
      TagHanlder,
      StarHanlder,
      TrashHanlder,
      ConfigureHandler
    }
  } = service

  const storage = new Storage()

  storage
    .init()
    .then(() => {
      // Initialize data processor.
      anynote.handlers.folder = new FolderHandler(storage.getRepository('folder'))
      anynote.handlers.notes = new NodeHandler(storage.getRepository('notes'))
      anynote.handlers.historys = new HistoryHanlder(storage.getRepository('historys'))
      anynote.handlers.tag = new TagHanlder(
        storage.getRepository('tag'),
        storage.getRepository('allNote')
      )
      anynote.handlers.star = new StarHanlder(storage.getRepository('allNote'))
      anynote.handlers.trash = new TrashHanlder(
        storage.getRepository('trash'),
        anynote.handlers.folder
      )
      anynote.handlers.configure = new ConfigureHandler(storage.getRepository('configure'))
      // Binding global API.
      Object.defineProperty(global, 'anynote', {
        value: anynote,
        configurable: false,
        writable: false,
        enumerable: false
      })
      setTimeout(() => {
        window.dispatchEvent(dbInitedEvent)
      }, 100)
    })
    .catch(err => {
      console.error(`Error: Database init failed. [${err}]`)
    })
})()
