import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm'
import { ScrapeRun } from './scrape-run.entity'
import { Store } from './store.entity'
import { Region } from './region.entity'

@Entity('scrape')
@Index('idx_scrape_store_type', ['storeId', 'type'])
@Index('idx_scrape_status', ['status'])
@Index('idx_scrape_run_fk', ['scrapeRunId'])
@Index('idx_scrape_finished', ['finishedAt'])
export class Scrape {
  @PrimaryGeneratedColumn('increment')
  id: number

  @ManyToOne(() => ScrapeRun, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'scrape_run_id' })
  scrapeRun: ScrapeRun | null

  @Column({ name: 'scrape_run_id', type: 'bigint', nullable: true })
  scrapeRunId?: number | null

  @ManyToOne(() => Store, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'store_id' })
  store: Store | null

  @Column({ name: 'store_id', type: 'bigint' })
  storeId: number | null

  @ManyToOne(() => Region, { nullable: true })
  @JoinColumn({ name: 'region_id' })
  region?: Region | null

  @Column({ name: 'region_id', type: 'bigint', nullable: true })
  regionId?: number | null

  @Column({ type: 'text', nullable: false })
  type: string | null // 'category', 'product', 'search', 'frontpage'

  @Column({ type: 'text', nullable: false })
  sourceUrl: string | null // the URL fetched

  @Column({ type: 'text', nullable: true })
  status?: string | null // 'success', 'error', 'skipped'

  @Column({ type: 'timestamptz', nullable: true })
  startedAt?: Date | null

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt?: Date | null

  @Column({ type: 'text', nullable: true })
  workerId?: string | null

  @Column({ type: 'bigint', nullable: true })
  proxyId?: number | null

  @Column({ type: 'text', nullable: true })
  configVersion?: string | null

  @Column({ type: 'text', nullable: true, default: '' })
  errorMessage?: string | null

  @Column({ type: 'boolean', default: false })
  weightRequired: boolean | null

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any> | null
}
