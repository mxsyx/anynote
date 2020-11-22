/*
 * File: /src/service/database.ts
 * Author: Mxsyx (mxsyxin@gmail.com)
 * Created At: 2020-10-11 08:06:24
 * -----
 * Last Modified: 2020-11-20 07:06:28
 * Modified By: Mxsyx (mxsyxin@gmail.com>)
 * -----
 * Lisense: GNU General Public License v3
 */

import events = require('events')

import {
  createConnections,
  getConnectionManager,
  ConnectionManager,
  Connection,
  ConnectionOptions,
  EventSubscriber,
  EntitySubscriberInterface,
  InsertEvent
} from 'typeorm'

import { Folder, Configure, Tag, AllNote, Note, History, Trash } from './entities'
import { OrmLogger } from './logger'
import { Connections, Repositorys } from './types'

// 
const eventProxy = new events.EventEmitter()

/**
 * Database connection pool manager.
 */
class DBManager {
  // Database connection pool.
  private pool: ConnectionManager

  connent(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      createConnections([
        {
          name: 'schema',
          type: 'sqlite',
          database: './dbs/schema',
          entities: [Folder, Configure, Tag],
          logging: true,
          subscribers: [FolderSubscriber],
          logger: new OrmLogger()
        },
        {
          name: 'extend',
          type: 'sqlite',
          database: './dbs/extend',
          entities: [AllNote, Trash],
          logging: true,
          logger: new OrmLogger()
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

  addConnections(options: ConnectionOptions[]): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      createConnections(options)
        .then(() => {
          resolve(true)
        })
        .catch(() => {
          reject(false)
        })
    })
  }
}

/**
 * Storage manager.
 */
class Storage {
  private dbManager: DBManager
  private connections: Connections
  private repositorys: Repositorys

  constructor() {
    this.dbManager = new DBManager()
    eventProxy.on('Folder-Create', (folder: Folder) => {
      this.handleFolderCreate(folder)
    })
  }

  private initSystemDB(): void {
    this.connections = {
      schema: this.dbManager.getConnection('schema'),
      extend: this.dbManager.getConnection('extend'),
      notes: {},
      plugins: {}
    }
    this.repositorys = {
      folder: this.connections.schema.getRepository(Folder),
      configure: this.connections.schema.getRepository(Configure),
      tag: this.connections.schema.getRepository(Tag),
      allNote: this.connections.extend.getRepository(AllNote),
      trash: this.connections.extend.getRepository(Trash),
      notes: {},
      historys: {},
      plugins: {}
    }
  }

  private initNoteDB(): Promise<boolean> {
    return new Promise<boolean>(async (resolve, reject) => {
      try {
        if (!this.repositorys) return
        const fids: string[] = []
        await this.repositorys.folder.find().then(data => {
          data.map(item => fids.push(item.id))
        })

        const options: ConnectionOptions[] = []
        fids.forEach(fid => {
          options.push({
            name: fid,
            type: 'sqlite',
            database: `./dbs/${fid}`,
            entities: [Note, History],
            synchronize: true,
            logging: true
          })
        })
        await this.dbManager.addConnections(options)

        fids.forEach(fid => {
          this.connections.notes[fid] = this.dbManager.getConnection(fid)
          this.repositorys.notes[`note_${fid}`] = this.connections.notes[fid].getRepository(Note)
          this.repositorys.historys[`history_${fid}`] = this.connections.notes[fid].getRepository(History)
        })

        resolve(true)
      } catch (error) {
        reject(error)
      }
    })
  }

  private handleFolderCreate(folder: Folder) {
    const options: ConnectionOptions[] = []
    options.push({
      name: folder.id,
      type: 'sqlite',
      database: `./dbs/${folder.id}`,
      entities: [Note, History],
      synchronize: true,
      logging: true
    })
    this.dbManager.addConnections(options)
  }

  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  public getRepository(name: keyof Repositorys) {
    return this.repositorys[name]
  }

  public init(): Promise<boolean> {
    return new Promise<boolean>(async (resolve, reject) => {
      try {
        await this.dbManager.connent()
        this.initSystemDB()
        await this.initNoteDB()
        resolve(true)
      } catch (error) {
        reject(error)
      }
    })
  }
}

@EventSubscriber()
export class FolderSubscriber implements EntitySubscriberInterface<Folder> {
  // eslint-disable-next-line @typescript-eslint/ban-types
  listenTo(): Function {
    return Folder;
  }

  // Create note database.
  afterInsert(event: InsertEvent<Folder>): void {
    eventProxy.emit('Folder-Create', event.entity)
  }
}

export default Storage
