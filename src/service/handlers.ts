import { v4 } from 'node-uuid'
import { Repository } from 'typeorm'
import { Folder, Note, Tag, Configure, History, Trash, AllNote } from './entities'
import { getNow } from './utils'
import { NoteType } from './types'

export class FolderHandler {
  private repository: Repository<Folder>

  constructor(repository: Repository<Folder>) {
    
    this.repository = repository
  }

  create(options: {
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
      this.repository.save(folder)
        .then((data) => {
          resolve(data)
        })
        .catch((error) => {
          reject(error)
        })
    })
  }

  delete(id: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.repository.delete(id)
        .then(() => {
          resolve(true)
        })
        .catch((error) => {
          reject(error)
        })
    })
  }

  rename(id: string, name: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.repository.update(id, { name })
        .then(() => {
          resolve(true)
        })
        .catch((error) => {
          reject(error)
        })
    })
  }

  move(id: string, pid: string, level: number): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.repository.update(id, { pid, level })
        .then(() => {
          resolve(true)
        })
        .catch((error) => {
          reject(error)
        })
    })
  }
}

export class NodeHandler {
  private repositorys: { [index: string]: Repository<Note> }

  constructor(repositorys: { [index: string]: Repository<Note> },) {
    this.repositorys = repositorys
  }

  createByOptions(fid: string, options: {
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
      this.repositorys[fid].save(note)
        .then((data) => {
          resolve(data)
        })
        .catch((error) => {
          reject(error)
        })
    })
  }

  createByInstance(fid: string, instance: Note): Promise<Note> {
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
      this.repositorys[fid].save(note)
        .then((data) => {
          resolve(data)
        })
        .catch((error) => {
          reject(error)
        })
    })
  }

  delete(fid: string, id: string): Promise<boolean> {
    return new Promise<boolean>(async (resolve, reject) => {
      try {
        const note = await this.repositorys[fid].findOne({ id })
        if (!note) throw new Error(`note: ${id} not found when delete this note.`)
        if (await CommonHanlder.trashHanlder.dropNote(fid, note)) {
          await this.repositorys[fid].delete({ id })
          resolve(true)
        }
      } catch (error) {
        // FIXME when dropToTrash throw error, we should fallback.
        reject(false)
      }
    })
  }

  rename(fid: string, id: string, title: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.repositorys[fid].update(id, { title })
        .then(() => {
          resolve(true)
        })
        .catch((error) => {
          reject(error)
        })
    })
  }

  updateContent(fid: string, id: string, content: string): Promise<string> {
    const uTime = getNow('datetime')
    return new Promise<string>(async (resolve, reject) => {
      try {
        await this.repositorys[fid].update(id, { content, uTime: uTime })
        await this.repositorys[fid].manager.increment(Note, { id }, "version", 1)
        resolve(uTime)
      } catch (error) {
        reject(error)
      }
    })
  }

  move(id: string, fid: string, toFid: string): Promise<boolean> {
    return new Promise<boolean>(async (resolve, reject) => {
      try {
        const note = await this.repositorys[fid].findOne(id)
        if (!note) throw new Error(`note: ${id} not found`)
        await this.repositorys[toFid].save(note)
        await this.repositorys[fid].delete(id)
        resolve(true)
      } catch (error) {
        reject(error)
      }
    })
  }

  changeWeight(fid: string, id: string): Promise<number> {
    const weight = Date.now()
    return new Promise<number>(async (resolve, reject) => {
      this.repositorys[fid].update(id, { weight })
        .then(() => {
          resolve(weight)
        })
        .catch((error) => {
          reject(error)
        })
    })
  }

  changeLisence(fid: string, id: string, lisence: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.repositorys[fid].update(id, { lisence })
        .then(() => {
          resolve(true)
        })
        .catch(() => {
          reject(false)
        })
    })
  }

  changeAuthor(fid: string, id: string, author: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.repositorys[fid].update(id, { author })
        .then(() => {
          resolve(true)
        })
        .catch(() => {
          reject(false)
        })
    })
  }

  changeOrigin(fid: string, id: string, origin: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.repositorys[fid].update(id, { origin })
        .then(() => {
          resolve(true)
        })
        .catch(() => {
          reject(false)
        })
    })
  }

  updateRemark(fid: string, id: string, remark: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.repositorys[fid].update(id, { remark })
        .then(() => {
          resolve(true)
        })
        .catch(() => {
          reject(false)
        })
    })
  }
}

export class HistoryHanlder {
  private repositorys: { [index: string]: Repository<History> }

  constructor(repositorys: { [index: string]: Repository<History> }) {
    this.repositorys = repositorys
  }

  create(fid: string, nid: string, content: string): Promise<History> {
    const history = new History()
    history.nid = nid
    history.when = getNow('datetime')
    history.content = content

    return new Promise<History>((resolve, reject) => {
      this.repositorys[fid].save(history)
        .then((data) => {
          resolve(data)
        })
        .catch(error => {
          reject(error)
        })
    })
  }

  delete(fid: string, id: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.repositorys[fid].delete({ id })
        .then(() => {
          resolve(true)
        })
        .catch(error => {
          reject(error)
        })
    })
  }

  empty(fid: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.repositorys[fid].createQueryBuilder('history')
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

  list(fid: string, nid: string): Promise<History[]> {
    return new Promise<History[]>((resolve, reject) => {
      this.repositorys[fid].find({ nid })
        .then((data) => {
          resolve(data)
        })
        .catch(error => {
          reject(error)
        })
    })
  }

  fallback(fid: string, nid: string, hid: string): Promise<boolean> {
    return new Promise<boolean>(async (resolve, reject) => {
      try {
        const history = await this.repositorys[fid].findOne(hid)
        if (!history) throw new Error(`history: ${hid} not found`)
        await this.repositorys[fid].update({ id: nid }, { content: history.content })
        resolve(true)
      } catch (error) {
        reject(error)
      }
    })
  }
}

export class TagHanlder {
  private repository: Repository<Tag>
  private allnote: Repository<AllNote>

  constructor(repository: Repository<Tag>, allnote: Repository<AllNote>) {
    this.repository = repository,
    this.allnote= allnote
  }

  create(name: string, id: string = v4()): Promise<Tag> {
    const tag = new Tag()
    tag.id = id
    tag.name = name

    return new Promise<Tag>((resolve, reject) => {
      this.repository.save(tag)
        .then((data) => {
          resolve(data)
        })
        .catch((error) => {
          reject(error)
        })
    })
  }

  list(): Promise<Tag[]> {
    return new Promise<Tag[]>((resolve, reject) => {
      this.repository.find()
        .then((data) => {
          resolve(data)
        })
        .catch(error => {
          reject(error)
        })
    })
  }

  delete(id: string): Promise<boolean> {
    return new Promise<boolean>(async (resolve, reject) => {
      try {
        const notes = await this.allnote.createQueryBuilder('all_note')
          .where('all_note.tids like %:tid%', { tid: id })
          .getMany()
        for (let i = 0; i < notes.length; i++) {
          const tids = notes[i].tids.split('|')
          tids.splice(tids.indexOf(id), 1)
          await this.allnote.update(notes[i].nid, { tids: tids.join('|') })
        }
        resolve(true)
      } catch (error) {
        reject(error)
      }
    })
  }

  add(nid: string, tid: string): Promise<boolean> {
    return new Promise<boolean>(async (resolve, reject) => {
      try {
        const note = await this.allnote.findOne(nid)
        if (!note) throw new Error(`note: ${nid} not found in all note table`)
        const tids = note.tids.split('|')
        tids.push(tid)
        await this.allnote.update(nid, { tids: tids.join('|') })
        resolve(true)
      } catch (error) {
        reject(error)
      }
    })
  }

  remove(nid: string, tid: string): Promise<boolean> {
    return new Promise<boolean>(async (resolve, reject) => {
      try {
        const note = await this.allnote.findOne(nid)
        if (!note) throw new Error(`note: ${nid} not found in all note table`)
        const tids = note.tids.split('|')
        tids.splice(tids.indexOf(tid), 1)
        await this.allnote.update(nid, { tids: tids.join('|') })
        resolve(true)
      } catch (error) {
        reject(error)
      }
    })
  }
}


export class StarHanlder {
  private repository: Repository<AllNote>

  constructor(repository: Repository<AllNote>) {
    this.repository = repository
  }

  star(nid: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.repository.update(nid, { star: true })
        .then(() => {
          resolve(true)
        })
        .catch((error) => {
          reject(error)
        })
    })
  }

  unStar(nid: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.repository.update(nid, { star: false })
        .then(() => {
          resolve(true)
        })
        .catch((error) => {
          reject(error)
        })
    })
  }
}


export class TrashHanlder {
  private repository: Repository<Trash>
  private noteHanlder: NodeHandler

  constructor(repository: Repository<Trash>, noteHanlder: NodeHandler) {
    this.repository = repository,
    this.noteHanlder = noteHanlder
  }

  dropNote(fid: string, note: Note): Promise<boolean> {
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
      this.repository.save(trash)
        .then(() => {
          resolve(true)
        })
        .catch(error => {
          reject(error)
        })
    })
  }

  restore(nid: string): Promise<boolean> {
    return new Promise<boolean>(async (resolve, reject) => {
      try {
        const trashNote = await this.repository.findOne({ nid })
        if (!trashNote) throw new Error(`note: ${nid} not found when restore this note.`)
        const _note = new Note()
        _note.id = trashNote.nid
        _note.type = trashNote.type
        _note.title = trashNote.title
        _note.cTime = trashNote.cTime
        _note.uTime = trashNote.uTime
        _note.weight = trashNote.weight
        _note.locked = trashNote.locked
        _note.author = trashNote.author
        _note.origin = trashNote.origin
        _note.lisence = trashNote.lisence
        _note.remark = trashNote.remark
        _note.content = trashNote.content
        _note.version = trashNote.version
        await this.noteHanlder.createByInstance(trashNote.fid, _note)
        resolve(true)
      } catch (error) {
        reject(false)
      }
    })
  }

  list(): Promise<Trash[]> {
    return new Promise<Trash[]>((resolve, reject) => {
      this.repository.find()
        .then((data) => {
          resolve(data)
        })
        .catch(error => {
          reject(error)
        })
    })
  }

  delete(nid: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.repository.delete({ nid })
        .then(() => {
          resolve(true)
        })
        .catch(error => {
          reject(error)
        })
    })
  }

  empty(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.repository.createQueryBuilder('trash')
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
}


export class ConfigureHandler {
  private repository: Repository<Configure>

  constructor(repository: Repository<Configure>) {
    this.repository = repository
  }


  set(name: string, value: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.repository.update({ name }, { value })
        .then(() => {
          resolve(true)
        })
        .catch((error) => {
          reject(error)
        })
    })
  }

  list(): Promise<Configure[]> {
    return new Promise<Configure[]>((resolve, reject) => {
      this.repository.find()
        .then(configures => {
          resolve(configures)
        })
        .catch(error => {
          reject(error)
        })
    })
  }
}

export class CommonHanlder {
  public static trashHanlder: TrashHanlder
}
