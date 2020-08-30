import { ConnectionOptions, Connection, Repository } from 'typeorm'
import { getConnection, addConnections } from 'initialize'
import { Folder, Note, History } from './entities'
import DBManager from './database'

interface DBUtil {
  getConnection: (name: string) => Connection,
  addConnections: (connOptionsList: ConnectionOptions[]) => Promise<boolean>
}

export function initSystemDB(): DBUtil {
  const dbManager = new DBManager()

  return {
    getConnection: dbManager.getConnection,
    addConnections: dbManager.addConnections
  }
}

interface Connections {
  schema: Connection,
  extend: Connection,
  notes: {
    [index: string]: Connection
  },
  plugins: {
    [index: string]: Connection
  }
}
interface Repos {
  folder: Repository<Folder>,
  notes: {
    [index: string]: Repository<Note>
  },
  historys: {
    [index: string]: Repository<History>
  },
  plugins: {
    // [index: string]: Repository<>
  }
}

const connections: Connections = {
  schema: getConnection('schema'),
  extend: getConnection('extend'),
  notes: {},
  plugins: {}
}
const repos: Repos = {
  folder: connections.schema.getRepository(Folder),
  notes: {},
  historys: {},
  plugins: {}
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export async function initNoteDB() {
  const fids: string[] = []
  await repos.folder.find()
    .then(data => {
      data.map(el => {
        fids.push(el.id)
      })
    })

  const connOptionsList: ConnectionOptions[] = []
  fids.forEach((fid) => {
    connOptionsList.push({
      name: fid,
      type: 'sqlite',
      database: fid,
      entities: [Note, History],
      synchronize: true,
      logging: true
    })
  })
  await addConnections(connOptionsList)

  fids.forEach((fid) => {
    connections.notes[fid] = getConnection(fid)
    repos.notes[`note_${fid}`] = connections.notes[fid].getRepository(Note)
    repos.historys[`history_${fid}`] = connections[fid].getRepository(History)
  })
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
// eslint-disable-next-line @typescript-eslint/no-empty-function
export async function initPluginDB() {
  
}

export default repos
