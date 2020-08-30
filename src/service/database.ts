import {
  createConnections,
  getConnectionManager,
  ConnectionManager,
  Connection,
  ConnectionOptions,
} from 'typeorm'
import { Folder, Configure, Tag, AllNote, Trash } from './entities'

class DBManager {
  // Database connection pool
  private pool: ConnectionManager

  constructor() {
    createConnections([
      {
        name: 'schema',
        type: 'sqlite',
        database: 'schema',
        entities: [Folder, Configure, Tag],
        synchronize: true,
        logging: true
      },
      {
        name: 'extend',
        type: 'sqlite',
        database: 'extend',
        entities: [AllNote, Trash],
        synchronize: true,
        logging: true
      },
    ])
      .then(() => {
        this.pool = getConnectionManager()
      })
      .catch((error) => {
        console.error(error)
      })
  }

  getConnection(name: string): Connection {
    return this.pool.get(name)
  }

  addConnections(connOptionsList: ConnectionOptions[]): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      createConnections(connOptionsList)
        .then(() => {
          resolve(true)
        })
        .catch(() => {
          reject(false)
        })
    })
  }
}

export default DBManager
