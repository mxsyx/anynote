import { Entity,  BaseEntity} from 'typeorm'
import { PrimaryColumn, Column } from '../resolve'

@Entity()
class Tag extends BaseEntity {
  @PrimaryColumn({ type: 'char', name: 'nid', length: 36, nullable: false })
  nid: string

  @PrimaryColumn({ type: 'char', name: 'fid', length: 36, nullable: false })
  fid: string
  
  @PrimaryColumn({ type: 'char', name: 'tid', length: 36, nullable: false })
  tid: string

  @Column({ type: 'nvarchar', name: 'name', length: 140, nullable: false })
  title: string
}

export default Tag
