import { Entity, BaseEntity } from 'typeorm'
import { PrimaryColumn, Column } from '../resolve'
import { NoteType } from '../types'

@Entity()
class Trash extends BaseEntity {
  @PrimaryColumn({ type: 'char', name: 'nid', length: 36, nullable: false })
  id: string

  @Column({ type: 'char', name: 'type', length: 1, readonly: true, nullable: false })
  type: NoteType

  @Column({ type: 'nvarchar', name: 'title', length: 140 })
  title: string

  @Column({ type: 'text', name: 'content' })
  content: string

  @Column({ type: 'datetime', name: 'when', nullable: false })
  when: string
}

export default Trash
