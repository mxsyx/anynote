import {
  Entity,
  PrimaryColumn,
  Column,
  BaseEntity
} from "typeorm";

@Entity()
export class Note extends BaseEntity {
  @PrimaryColumn({ type: 'text', name: 'id', length: 36, nullable: false })
  id: string;

  @Column({ type: 'text', name: 'type', length: 1, nullable: false })
  type: string;

  @Column({ type: 'text', name: 'title', length: 140, nullable: false })
  title: string;

  @Column({ type: 'text', name: 'c_time', nullable: false })
  cTime: string;

  @Column({ type: 'text', name: 'u_time', nullable: false })
  uTime: string;

  @Column({ type: 'integer', name: 'word_count', unsigned: true, nullable: false })
  wordCount: number;

  @Column({ type: 'text', name: 'author', length: 28, default: null })
  author: string;

  @Column({ type: 'text', name: 'link', length: 255, default: null })
  link: string;

  @Column({ type: 'text', name: 'lisence', length: 16, default: null })
  lisence: string;

  @Column({ type: 'text', name: 'remark', length: 800, default: null })
  remark: string;

  @Column({ type: 'text', name: 'content', nullable: false })
  content: string;

  @Column({ type: 'integer', name: 'version', unsigned: true, nullable: false })
  version: number;
}