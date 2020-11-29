import { Entity, BaseEntity } from 'typeorm'
import { PrimaryGeneratedColumn, Column } from '../resolve'

@Entity()
class History extends BaseEntity {
  @PrimaryGeneratedColumn({ type: 'int', name: 'id', unsigned: true })
  id: number

  @Column({ type: 'char', name: 'nid', length: 36, nullable: false })
  nid: string

  @Column({ type: 'datetime', name: 'when', nullable: false })
  when: string

  @Column({ type: 'text', name: 'name', nullable: false })
  content: string
}

export default History
