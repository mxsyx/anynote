import { Entity, BaseEntity } from 'typeorm'
import { PrimaryColumn, Column } from '../resolve'

@Entity()
class Note extends BaseEntity {
  @PrimaryColumn({ type: 'char', name: 'id', length: 36, nullable: false })
  id: string

  @Column({ type: 'char', name: 'type', length: 1, readonly: true, nullable: false })
  type: string

  @Column({ type: 'nvarchar', name: 'title', length: 140, nullable: false })
  title: string

  @Column({ type: 'datetime', name: 'c_time', readonly: true, nullable: false })
  cTime: string

  @Column({ type: 'datetime', name: 'u_time', nullable: false })
  uTime: string

  @Column({ type: 'timestamp', name: 'weight', nullable: false, default: 0 })
  weight: number

  @Column({ type: 'tinyint', name: 'locked', unsigned: true, nullable: false, default: 0 })
  locked: boolean

  @Column({ type: 'nvarchar', name: 'author', length: 28, default: null })
  author: string | null

  @Column({ type: 'text', name: 'link', length: 255, default: null })
  origin: string | null

  @Column({ type: 'text', name: 'lisence', length: 14, default: null })
  lisence: string | null

  @Column({ type: 'text', name: 'remark', length: 800, default: null })
  remark: string | null

  @Column({ type: 'text', name: 'content', nullable: false })
  content: string

  @Column({ type: 'int', name: 'version', unsigned: true, default: 1 })
  version: number
}

export default Note
