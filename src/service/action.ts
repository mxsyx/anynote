import { v4 } from 'node-uuid'
import { Folder, Note, Tag } from './entities'
import repos from './connect'
import { getNow } from './utils'

export function createFolder(options: {
  id?: string, pid?: string, level?: number, name: string,
  locked?: boolean, total?: number
}): Promise<Folder> {
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

  return new Promise<Folder>((resolve, reject) => {
    repos.folder.save(folder)
      .then((data) => {
        resolve(data)
      })
      .catch((error) => {
        reject(error)
      })
  })
}

export function deleteFolder(id: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    repos.folder.delete(id)
      .then(() => {
        resolve(true)
      })
      .catch((error) => {
        reject(error)
      })
  })
}

export function renameFolder(id: string, name: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    repos.folder.update(id, { name })
      .then(() => {
        resolve(true)
      })
      .catch((error) => {
        reject(error)
      })
  })
}

export function moveFolder(id: string, pid: string, level: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    repos.folder.update(id, { pid, level })
      .then(() => {
        resolve(true)
      })
      .catch((error) => {
        reject(error)
      })
  })
}

export function createNote(options: {
  fid: string, id?: string, type: string, title?: string, cTime?: string,
  uTime?: string, weight?: number, locked?: boolean, author: string, origin: string,
  lisence: string, remark: string, content: string, version: number
}): Promise<Note> {
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

  return new Promise<Note>((resolve, reject) => {
    repos.notes[fid].save(note)
      .then((data) => {
        resolve(data)
      })
      .catch((error) => {
        reject(error)
      })
  })
}

export function deleteNote(fid: string, id: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    repos.notes[fid].delete(id)
      .then(() => {
        resolve(true)
      })
      .catch((error) => {
        reject(error)
      })
  })
}

export function renameNote(fid: string, id: string, title: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    repos.notes[fid].update(id, { title })
      .then(() => {
        resolve(true)
      })
      .catch((error) => {
        reject(error)
      })
  })
}

export function updateNoteContent(fid: string, id: string, content: string): Promise<string> {
  const uTime = getNow('datetime')
  return new Promise<string>(async (resolve, reject) => {
    try {
      await repos.notes[fid].update(id, { content, uTime: uTime })
      await repos.notes[fid].manager.increment(Note, { id }, "version", 1)
      resolve(uTime)
    } catch (error) {
      reject(error)
    }
  })
}

export function moveNote(id: string, fid: string, toFid: string): Promise<boolean> {
  return new Promise<boolean>(async (resolve, reject) => {
    try {
      const note = await repos.notes[fid].findOne(id)
      if (!note) throw new Error(`note: ${id} not found`)
      await repos.notes[toFid].save(note)
      await repos.notes[fid].delete(id)
      resolve(true)
    } catch (error) {
      reject(error)
    }
  })
}

export function changeWeight(fid: string, id: string): Promise<number> {
  const weight = Date.now()
  return new Promise<number>(async (resolve, reject) => {
    repos.notes[fid].update(id, { weight })
      .then(() => {
        resolve(weight)
      })
      .catch((error) => {
        reject(error)
      })
  })
}

export function changeLisence(fid: string, id: string, lisence: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    repos.notes[fid].update(id, { lisence })
      .then(() => {
        resolve(true)
      })
      .catch(() => {
        reject(false)
      })
  })
}

export function changeAuthor(fid: string, id: string, author: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    repos.notes[fid].update(id, { author })
      .then(() => {
        resolve(true)
      })
      .catch(() => {
        reject(false)
      })
  })
}

export function changeOrigin(fid: string, id: string, origin: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    repos.notes[fid].update(id, { origin })
      .then(() => {
        resolve(true)
      })
      .catch(() => {
        reject(false)
      })
  })
}

export function updateRemark(fid: string, id: string, remark: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    repos.notes[fid].update(id, { remark })
      .then(() => {
        resolve(true)
      })
      .catch(() => {
        reject(false)
      })
  })
}

export function createTag(name: string, id: string = v4()): Promise<Tag> {
  const tag = new Tag()
  tag.id = id
  tag.name = name

  return new Promise<Tag>((resolve, reject) => {
    repos.tag.save(tag)
      .then((data) => {
        resolve(data)
      })
      .catch((error) => {
        reject(error)
      })
  })
}

// TODO delete tag
export function deleteTag(name: string, id: string = v4()): Promise<Tag> {
  const tag = new Tag()
  tag.id = id
  tag.name = name

  return new Promise<Tag>((resolve, reject) => {
    repos.tag.save(tag)
      .then((data) => {
        resolve(data)
      })
      .catch((error) => {
        reject(error)
      })
  })
}

export function addTag(id: string, tid: string = v4()): Promise<boolean> {
  return new Promise<boolean>(async (resolve, reject) => {
    try {
      const note = await repos.allNote.findOne(id)
      if (!note) throw new Error(`note: ${id} not found in all note table`)
      const tids = note.tids.split('|')
      tids.push(tid)
      await repos.allNote.update(id, { tids: tids.join('|') })
      resolve(true)
    } catch (error) {
      reject(error)
    }
  })
}

export function removeTag(id: string, tid: string = v4()): Promise<boolean> {
  return new Promise<boolean>(async (resolve, reject) => {
    try {
      const note = await repos.allNote.findOne(id)
      if (!note) throw new Error(`note: ${id} not found in all note table`)
      const tids = note.tids.split('|')
      tids.splice(tid.indexOf(tid), 1)
      await repos.allNote.update(id, { tids: tids.join('|') })
      resolve(true)
    } catch (error) {
      reject(error)
    }
  })
}

