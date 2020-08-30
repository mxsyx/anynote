import { Entity, BaseEntity } from 'typeorm'
import { PrimaryColumn, Column } from '../resolve'

@Entity()
class AllNote extends BaseEntity {
  @PrimaryColumn({ type: 'char', name: 'nid', length: 36, nullable: false })
  nid: string

  @Column({ type: 'char', name: 'fid', length: 36, nullable: false })
  fid: string

  @Column({ type: 'nvarchar', name: 'title', length: 140, nullable: false })
  title: string

  @Column({ type: 'varchar', name: 'tids', length: 776, default: null })
  tids: string

  @Column({ type: 'tinyint', name: 'star', unsigned: true, nullable: false, default: 0 })
  star: boolean
}

export default AllNote
