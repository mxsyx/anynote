import { Entity,  BaseEntity} from 'typeorm'
import { PrimaryColumn, Column } from '../resolve'

@Entity()
class Tag extends BaseEntity {
  @PrimaryColumn({ type: 'char', name: 'id', length: 36, nullable: false })
  id: string

  @Column({ type: 'nvarchar', name: 'name', length: 32, nullable: false })
  name: string
}

export default Tag
