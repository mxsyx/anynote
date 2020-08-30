import { v4 } from 'node-uuid'
import { Folder } from './entities'
import repos from './connect'

export async function createFolder(options: {
  pid: string, level: number, name: string, locked?: boolean, total?: number
}): Promise<boolean> {
  const { pid, level, name, locked, total } = options

  const folder = new Folder()
  folder.id = v4()
  folder.pid = pid
  folder.level = level
  folder.name = name
  folder.locked = locked || false
  folder.total = total || 0

  return new Promise<boolean>((resolve, reject) => {
    repos.folder.save(folder)
      .then(() => {
        resolve(true)
      })
      .catch(() => {
        reject(false)
      })
  })
}

export async function deleteFolder(id: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    repos.folder.delete(id)
      .then(() => {
        resolve(true)
      })
      .catch(() => {
        reject(false)
      })
  })
}

export async function renameFolder(id: string, name: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    repos.folder.update(id, { name })
      .then(() => {
        resolve(true)
      })
      .catch(() => {
        reject(false)
      })
  })
}
