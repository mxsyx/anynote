import { Entity, BaseEntity } from 'typeorm'
import { PrimaryColumn, Column } from '../resolve'

@Entity()
class Folder extends BaseEntity {
  @PrimaryColumn({ type: 'char', name: 'id', length: 36, nullable: false })
  id: string

  @Column({ type: 'char', name: 'pid', length: 36, nullable: false })
  pid: string

  @Column({ type: 'tinyint', name: 'title', unsigned: true, nullable: false })
  level: number

  @Column({ type: 'nvarchar', name: 'name', length: 128, nullable: false })
  name: string

  @Column({ type: 'tinyint', name: 'locked', unsigned: true, nullable: false, default: 0 })
  locked: number

  @Column({ type: 'smallint', name: 'total', unsigned: true, nullable: false, default: 0 })
  total: number
}

export default Folder
