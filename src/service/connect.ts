import { ConnectionOptions, Connection, Repository } from 'typeorm'
import DBManager from './database'
import {
  Folder,
  Note,
  History,
  Tag,
  AllNote,
  Configure,
  Trash
} from './entities'

interface Connections {
  schema: Connection
  extend: Connection
  notes: { [index: string]: Connection }
  plugins: { [index: string]: Connection }
}
interface Repos {
  folder: Repository<Folder>
  configure: Repository<Configure>
  tag: Repository<Tag>
  allNote: Repository<AllNote>
  trash: Repository<Trash>
  notes: { [index: string]: Repository<Note> }
  historys: { [index: string]: Repository<History> }
  plugins: {
    /* [index: string]: Repository<> */
  }
}

//
let connections: Connections

//
let repos: Repos

export function initSystemDB(dbManager: DBManager): void {
  connections = {
    schema: dbManager.getConnection('schema'),
    extend: dbManager.getConnection('extend'),
    notes: {},
    plugins: {}
  }
  repos = {
    folder: connections.schema.getRepository(Folder),
    configure: connections.schema.getRepository(Configure),
    tag: connections.schema.getRepository(Tag),
    allNote: connections.extend.getRepository(AllNote),
    trash: connections.extend.getRepository(Trash),
    notes: {},
    historys: {},
    plugins: {}
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export async function initNoteDB(dbManager: DBManager): Promise<void> {
  if (!repos) return
  const fids: string[] = []
  await repos.folder.find().then(data => {
    data.map(el => {
      fids.push(el.id)
    })
  })

  const connOptionsList: ConnectionOptions[] = []
  fids.forEach(fid => {
    connOptionsList.push({
      name: fid,
      type: 'sqlite',
      database: fid,
      entities: [Note, History],
      synchronize: true,
      logging: true
    })
  })
  await dbManager.addConnections(connOptionsList)

  fids.forEach(fid => {
    connections.notes[fid] = dbManager.getConnection(fid)
    repos.notes[`note_${fid}`] = connections.notes[fid].getRepository(Note)
    repos.historys[`history_${fid}`] = connections[fid].getRepository(History)
  })
}

function getRepos(): Repos {
  return repos
}

export default getRepos
