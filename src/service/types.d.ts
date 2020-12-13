/*
 * File: /src/service/types.d.ts
 * Author: Mxsyx (mxsyxin@gmail.com)
 * Created At: 2020-10-11 08:06:24
 * -----
 * Last Modified: 2020-11-20 07:06:48
 * Modified By: Mxsyx (mxsyxin@gmail.com>)
 * -----
 * Lisense: GNU General Public License v3
 */

import { Connection, Repository } from "typeorm";
import { Folder, Configure, Tag, AllNote, Note, History, Trash } from "./entities";
import { ConfigureHandler, FolderHandler, HistoryHanlder, NodeHandler, TagHanlder, TrashHanlder } from "./handlers";

export interface Connections {
  schema: Connection,
  extend: Connection,
  notes: { [index: string]: Connection },
  plugins: { [index: string]: Connection }
}

export interface Repositorys {
  folder: Repository<Folder>,
  configure: Repository<Configure>,
  tag: Repository<Tag>,
  allNote: Repository<AllNote>,
  trash: Repository<Trash>,
  notes: { [index: string]: Repository<Note> },
  historys: { [index: string]: Repository<History> },
  plugins: {/* [index: string]: Repository<> */ }
}

export type Handlers = {
  folder: FolderHandler,
  configure: ConfigureHandler,
  tag: TagHanlder,
  trash: TrashHanlder,
  note: NodeHandler,
  history: HistoryHanlder
}

export type NoteType = 'R' | 'M'
