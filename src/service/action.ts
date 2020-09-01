import { v4 } from 'node-uuid'
import { Folder, Note } from './entities'
import repos from './connect'
import { getNow } from './utils'
import { UpdateResult } from 'typeorm'

interface ActionResult<T> {
  status: boolean,
  instance?: T,
  extra?: Record<string, unknown>
}
type PromiseActionResult<T> = Promise<ActionResult<T>>

export function createFolder(options: {
  id?: string, pid?: string, level?: number, name: string,
  locked?: boolean, total?: number
}): PromiseActionResult<Folder> {
  const { id = v4(), pid = null, level = 0,
    name, locked = false, total = 0 
  } = options

  const folder = new Folder()
  folder.id = id
  folder.pid = pid
  folder.level = level
  folder.name = name
  folder.locked = locked
  folder.total = total

  return new Promise<ActionResult<Folder>>((resolve, reject) => {
    repos.folder.save(folder)
      .then((data) => {
        resolve({ status: true, instance: data })
      })
      .catch(() => {
        reject({ status: false })
      })
  })
}

export function deleteFolder(id: string): Promise<boolean> {
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

export function renameFolder(id: string, name: string): Promise<boolean> {
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

export function moveFolder(id: string, to: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    // TODO move folder
  })
}

export function createNote(options: {
  fid: string, id?: string, type: string, title?: string, cTime?: string,
  uTime?: string, weight?: number, locked?: boolean, author: string, origin: string,
  lisence: string, remark: string, content: string, version: number
}): PromiseActionResult<Note> {
  const { fid, id = v4(), type, title = '', cTime = getNow('datetime'),
    uTime = cTime, weight = 0, locked = false, author = null, origin = null,
    lisence = null, remark = null, content = '', version = 0
  } = options

  const note = new Note()
  note.id = id
  note.type = type
  note.title = title
  note.cTime = cTime
  note.uTime = uTime
  note.weight = weight
  note.locked = locked
  note.author = author
  note.origin = origin
  note.lisence = lisence
  note.remark = remark
  note.content = content
  note.version = version

  // TODO note database maybe not found

  return new Promise<ActionResult<Note>>((resolve, reject) => {
    repos.notes[fid].save(note)
      .then((data) => {
        resolve({ status: true, instance: data })
      })
      .catch(() => {
        reject({ status: false })
      })
  })
}

export function deleteNote(fid: string, id: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    repos.notes[fid].delete(id)
      .then(() => {
        resolve(true)
      })
      .catch(() => {
        reject(false)
      })
  })
}

export function renameNote(fid: string, id: string, title: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    repos.notes[fid].update(id, { title })
      .then(() => {
        resolve(true)
      })
      .catch(() => {
        reject(false)
      })
  })
}

export function updateNoteContent(fid: string, id: string, content: string)
  : PromiseActionResult<UpdateResult> {
  const uTime = getNow('datetime')
  return new Promise<ActionResult<UpdateResult>>((resolve, reject) => {
    // TODO version update
    repos.notes[fid].update(id, { content, uTime: uTime })
      .then((data) => {
        resolve({ status: true, instance: data, extra: { 'uTime': uTime } })
      })
      .catch(() => {
        reject(false)
      })
  })
}
