import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
} from 'typeorm'
import { Store } from '../../../database/entities/store.entity'
import { ScrapeContent } from '../../scrape/entities/scrape-content.entity'

@Entity()
export class ScrapeJob {
  @PrimaryGeneratedColumn()
  id: number

  @ManyToOne(() => Store)
  @JoinColumn({ name: 'store_id' })
  store: Store

  @Column()
  url: string

  @Column({ default: 'pending' })
  status: 'pending' | 'in_progress' | 'done' | 'error'

  @Column({ type: 'timestamptz', nullable: true })
  lastScraped: Date | null

  @CreateDateColumn()
  createdAt: Date

  @UpdateDateColumn()
  updatedAt: Date

  @OneToMany(() => ScrapeContent, content => content.scrapeJob)
  contents: ScrapeContent[]
}
