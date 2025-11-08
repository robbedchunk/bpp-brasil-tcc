import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  CreateDateColumn,
  JoinColumn,
} from 'typeorm'
import { ScrapeJob } from './scrape-job.entity'

@Entity()
export class ScrapeContent {
  @PrimaryGeneratedColumn()
  id: number

  @OneToMany(() => ScrapeContent, c => c.scrapeJob)
  contents: ScrapeContent[]

  @ManyToOne(() => ScrapeJob, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'scrape_job_id' })
  scrapeJob: ScrapeJob

  @Column({ type: 'timestamptz', name: 'scraped_at', default: () => 'now()' })
  scrapedAt: Date

  @Column({ type: 'int', name: 'status_code', nullable: true })
  statusCode?: number | null

  @Column({ nullable: true, name: 'content_type', type: 'text', default: null })
  contentType?: string | null

  @Column({ type: 'text', nullable: true, default: null, name: 'html' })
  html?: string | null

  @Column({ type: 'text', nullable: true, default: null, name: 'text_content' })
  textContent?: string | null

  @Column({ type: 'text', nullable: true, default: null, name: 'content_hash' })
  contentHash?: string | null

  @Column({ type: 'jsonb', nullable: true, default: null, name: 'metadata' })
  metadata?: Record<string, any> | null
}
