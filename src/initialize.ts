import DBManager from './service/database'
import { initSystemDB, initNoteDB } from './service/connect'

async function init(): Promise<void> {
  const dbManager = new DBManager()
  await dbManager.connent()

  // Initialize the notes database.
  initSystemDB(dbManager)

  // Initialize the system database.
  initNoteDB(dbManager)

  window.electron.remote = require('electron')
}

export default init
