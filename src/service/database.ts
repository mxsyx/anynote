import {
  createConnections,
  getConnectionManager,
  ConnectionManager,
  Connection,
  ConnectionOptions
} from 'typeorm'
import { Folder, Configure, Tag, AllNote, Trash } from './entities'

class DBManager {
  // Database connection pool.
  private pool: ConnectionManager

  connent(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {      
      createConnections([
        {
          name: 'schema',
          type: 'sqlite',
          database: 'schema',
          entities: [Folder, Configure, Tag],
          logging: true
        },
        {
          name: 'extend',
          type: 'sqlite',
          database: 'extend',
          entities: [AllNote, Trash],
          logging: true
        }
      ])
        .then(() => {

          this.pool = getConnectionManager()
          resolve(true)
        })
        .catch(error => {
          reject(error)
        })
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
