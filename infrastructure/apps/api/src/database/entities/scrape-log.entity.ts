import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm'
import { Scrape } from './scrape.entity'

@Entity('scrape_log')
export class ScrapeLog {
  @PrimaryGeneratedColumn('increment')
  id: number

  @ManyToOne(() => Scrape, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'scrape_id' })
  scrape: Scrape | null

  @Column({ name: 'scrape_id', type: 'bigint', nullable: true })
  scrapeId?: number | null

  @Column({ type: 'text', nullable: true })
  logLevel?: string | null // info, warning, error

  @Column({ type: 'text', nullable: true })
  message?: string | null

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date | null
}
