import { initSystemDB, initNoteDB, initPluginDB } from 'service'

// Initialize the system database.
export const { getConnection, addConnections } = initSystemDB()

// Initialize the notes database.
initNoteDB()

// Initialize the plugin database.
initPluginDB()
