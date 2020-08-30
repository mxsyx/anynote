import 'reflect-metadata'
import { createConnection } from 'typeorm'
import { v4 } from 'node-uuid'
import { Folder, Note, TagMeta, Tag, Star, History, Trash } from './entities'

/**
 * Save note content into database.
 * @param content note content
 */
function saveNote(content: string): void {
  createConnection({
    type: 'sqlite',
    database: 'schema',
    entities: [Folder, Note, TagMeta, Tag, Star, History, Trash],
    synchronize: true,
    logging: false,
  })
    .then(async (connection) => {
      const rep = connection.getRepository(Note)
      const note = new Note()
      note.id = v4()
      note.type = 'R'
      note.title = 'IT技术笔记'
      note.cTime = new Date().toLocaleString()
      note.uTime = new Date().toLocaleString()
      note.wordCount = 10000
      note.content = content
      note.version = 1
      await rep.save(note)
    })
    .catch((error) => console.log(error))
}

saveNote('test')
