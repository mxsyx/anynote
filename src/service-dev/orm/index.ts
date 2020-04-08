import "reflect-metadata";
import { createConnection } from "typeorm";
import { Note } from "./entity/Note";
const uuid = require('node-uuid');

/**
 * Save note content into database.
 * @param content note content
 */
function saveNote(content: string): void {
  createConnection({
    type: 'sqlite',
    database: "schema",
    entities: [
      Note
    ],
    synchronize: true,
    logging: false
  }).then(async connection => {
    const rep = connection.getRepository(Note);
    const note = new Note();
    note.id = uuid.v4();
    note.type = 'O',
    note.title = 'IT技术笔记'
    note.cTime = new Date().toLocaleString();
    note.uTime = new Date().toLocaleString();
    note.wordCount = 10000;
    note.content = content;
    note.version = 1;
    await rep.save(note);
  }).catch(error => console.log(error));
}

export { saveNote };