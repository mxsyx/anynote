import { Entity,  BaseEntity } from 'typeorm'
import { PrimaryColumn, Column } from '../resolve'
import { NoteType } from '../types'

@Entity()
class Folder extends BaseEntity {
  @PrimaryColumn({ type: 'char', name: 'nid', length: 36, nullable: false })
  nid: string

  @Column({ type: 'char', name: 'fid', length: 36, nullable: false })
  fid: string

  @Column({ type: 'char', name: 'type', length: 1, nullable: false })
  type: NoteType

  @Column({ type: 'nvarchar', name: 'title', length: 140, nullable: false })
  title: string

  @Column({ type: 'datetime', name: 'c_time', nullable: false })
  cTime: string

  @Column({ type: 'datetime', name: 'u_time', nullable: false })
  uTime: string

  @Column({ type: 'timestamp', name: 'weight', nullable: false, default: 0 })
  weight: number

  @Column({ type: 'tinyint', name: 'locked', unsigned: true, nullable: false, default: 0 })
  locked: number

  @Column({ type: 'int', name: 'word_count', unsigned: true, nullable: false, default: 0 })
  wordCount: number

  @Column({ type: 'nvarchar', name: 'author', length: 28, default: null })
  author: string

  @Column({ type: 'text', name: 'link', length: 255, default: null })
  origin: string

  @Column({ type: 'text', name: 'lisence', length: 16, default: null })
  lisence: string

  @Column({ type: 'text', name: 'remark', length: 800, default: null })
  remark: string

  @Column({ type: 'text', name: 'content', nullable: false })
  content: string

  @Column({ type: 'int', name: 'version', unsigned: true, default: 1 })
  version: number
}

export default Folder
