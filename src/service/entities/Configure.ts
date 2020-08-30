import { Entity, BaseEntity } from 'typeorm'
import { PrimaryGeneratedColumn, Column } from '../resolve'

@Entity()
class Configure extends BaseEntity {
  @PrimaryGeneratedColumn({ type: 'int', name: 'id', unsigned: true })
  id: string

  @Column({ type: 'varchar', name: 'name', length: 32, nullable: false })
  name: string

  @Column({ type: 'varchar', name: 'value', length: 127, nullable: false })
  value: string
}

export default Configure
