import { v4 } from 'node-uuid'
import { Folder, Note, Tag, Configure, History, Trash } from './entities'
import repos from './connect'
import { getNow } from './utils'
import { NoteType } from './types'

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

export function createNoteByOptions(fid: string, options: {
  id?: string, type: NoteType, title?: string, cTime?: string,
  uTime?: string, weight?: number, locked?: boolean, author?: string, origin?: string,
  lisence?: string, remark?: string, content?: string, version?: number
}): Promise<Note> {
  const { id = v4(), type, title = '', cTime = getNow('datetime'),
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

export function createNoteByInstance(fid: string, instance: Note): Promise<Note> {
  const note = new Note()
  note.id = instance.id
  note.type = instance.type
  note.title = instance.title
  note.cTime = instance.cTime
  note.uTime = instance.uTime
  note.weight = instance.weight
  note.locked = instance.locked
  note.author = instance.author
  note.origin = instance.origin
  note.lisence = instance.lisence
  note.remark = instance.remark
  note.content = instance.content
  note.version = instance.version

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
  return new Promise<boolean>(async (resolve, reject) => {
    try {
      const note = await repos.notes[fid].findOne({ id })
      if (!note) throw new Error(`note: ${id} not found when delete this note.`)
      if (await dropNoteToTrash(fid, note)) {
        await repos.notes[fid].delete({ id })
        resolve(true)
      }
    } catch (error) {
      // FIXME when dropToTrash throw error, we should fallback.
      reject(false)
    }
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

export function listTag(): Promise<Tag[]> {
  return new Promise<Tag[]>((resolve, reject) => {
    repos.tag.find()
      .then((data) => {
        resolve(data)
      })
      .catch(error => {
        reject(error)
      })
  })
}

export function deleteTag(id: string): Promise<boolean> {
  return new Promise<boolean>(async (resolve, reject) => {
    try {
      const notes = await repos.allNote.createQueryBuilder('all_note')
        .where('all_note.tids like %:tid%', { tid: id })
        .getMany()
      for (let i = 0; i < notes.length; i++) {
        const tids = notes[i].tids.split('|')
        tids.splice(tids.indexOf(id), 1)
        await repos.allNote.update(notes[i].nid, { tids: tids.join('|') })
      }
      resolve(true)
    } catch (error) {
      reject(error)
    }
  })
}

export function addTag(nid: string, tid: string): Promise<boolean> {
  return new Promise<boolean>(async (resolve, reject) => {
    try {
      const note = await repos.allNote.findOne(nid)
      if (!note) throw new Error(`note: ${nid} not found in all note table`)
      const tids = note.tids.split('|')
      tids.push(tid)
      await repos.allNote.update(nid, { tids: tids.join('|') })
      resolve(true)
    } catch (error) {
      reject(error)
    }
  })
}

export function removeTag(nid: string, tid: string): Promise<boolean> {
  return new Promise<boolean>(async (resolve, reject) => {
    try {
      const note = await repos.allNote.findOne(nid)
      if (!note) throw new Error(`note: ${nid} not found in all note table`)
      const tids = note.tids.split('|')
      tids.splice(tids.indexOf(tid), 1)
      await repos.allNote.update(nid, { tids: tids.join('|') })
      resolve(true)
    } catch (error) {
      reject(error)
    }
  })
}

export function star(nid: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    repos.allNote.update(nid, { star: true })
      .then(() => {
        resolve(true)
      })
      .catch((error) => {
        reject(error)
      })
  })
}

export function unStar(nid: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    repos.allNote.update(nid, { star: false })
      .then(() => {
        resolve(true)
      })
      .catch((error) => {
        reject(error)
      })
  })
}

export function createHistory(fid: string, nid: string, content: string): Promise<History> {
  const history = new History()
  history.nid = nid
  history.when = getNow('datetime')
  history.content = content

  return new Promise<History>((resolve, reject) => {
    repos.historys[fid].save(history)
      .then((data) => {
        resolve(data)
      })
      .catch(error => {
        reject(error)
      })
  })
}

export function deleteHistory(fid: string, id: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    repos.historys[fid].delete({ id })
      .then(() => {
        resolve(true)
      })
      .catch(error => {
        reject(error)
      })
  })
}

export function emptyHistory(fid: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    repos.historys[fid].createQueryBuilder('history')
      .delete()
      .execute()
      .then(() => {
        resolve(true)
      })
      .catch(error => {
        reject(error)
      })
  })
}

export function getHistorys(fid: string, nid: string): Promise<History[]> {
  return new Promise<History[]>((resolve, reject) => {
    repos.historys[fid].find({ nid })
      .then((data) => {
        resolve(data)
      })
      .catch(error => {
        reject(error)
      })
  })
}

export function fallbackHistory(fid: string, nid: string, hid: string): Promise<boolean> {
  return new Promise<boolean>(async (resolve, reject) => {
    try {
      const history = await repos.historys[fid].findOne(hid)
      if (!history) throw new Error(`history: ${hid} not found`)
      await repos.notes[fid].update({ id: nid }, { content: history.content })
      resolve(true)
    } catch (error) {
      reject(error)
    }
  })
}

function dropNoteToTrash(fid: string, note: Note): Promise<boolean> {
  const trash = new Trash()
  trash.nid = note.id
  trash.fid = fid
  trash.type = note.type
  trash.title = note.title
  trash.cTime = note.cTime
  trash.uTime = note.uTime
  trash.weight = note.weight
  trash.locked = note.locked
  trash.author = note.author
  trash.origin = note.origin
  trash.lisence = note.lisence
  trash.remark = note.remark
  trash.content = note.content
  trash.version = note.version

  return new Promise<boolean>((resolve, reject) => {
    repos.trash.save(trash)
      .then(() => {
        resolve(true)
      })
      .catch(error => {
        reject(error)
      })
  })
}

export function restoreNoteFromTrash(nid: string): Promise<boolean> {
  return new Promise<boolean>(async (resolve, reject) => {
    try {
      const trashNote = await repos.trash.findOne({ nid })
      if (!trashNote) throw new Error(`note: ${nid} not found when restore this note.`)
      const note = new Note()
      note.id = trashNote.nid
      note.type = trashNote.type
      note.title = trashNote.title
      note.cTime = trashNote.cTime
      note.uTime = trashNote.uTime
      note.weight = trashNote.weight
      note.locked = trashNote.locked
      note.author = trashNote.author
      note.origin = trashNote.origin
      note.lisence = trashNote.lisence
      note.remark = trashNote.remark
      note.content = trashNote.content
      note.version = trashNote.version
      await createNoteByInstance(trashNote.fid, note)
      resolve(true)
    } catch (error) {
      reject(false)
    }
  })
}

export function listTrash(): Promise<Trash[]> {
  return new Promise<Trash[]>((resolve, reject) => {
    repos.trash.find()
      .then((data) => {
        resolve(data)
      })
      .catch(error => {
        reject(error)
      })
  })
}

export function deleteTrash(nid: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    repos.trash.delete({ nid })
      .then(() => {
        resolve(true)
      })
      .catch(error => {
        reject(error)
      })
  })
}

export function emptyTrash(): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    repos.trash.createQueryBuilder('trash')
      .delete()
      .execute()
      .then(() => {
        resolve(true)
      })
      .catch(error => {
        reject(error)
      })
  })
}



export function setConfigure(name: string, value: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    repos.configure.update({ name }, { value })
      .then(() => {
        resolve(true)
      })
      .catch((error) => {
        reject(error)
      })
  })
}

export function getConfigures(): Promise<Configure[]> {
  return new Promise<Configure[]>((resolve, reject) => {
    repos.configure.find()
      .then(configures => {
        resolve(configures)
      })
      .catch(error => {
        reject(error)
      })
  })
}
