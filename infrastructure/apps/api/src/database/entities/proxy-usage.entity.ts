import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  JoinColumn,
  Index,
} from 'typeorm'
import { Proxy } from './proxy.entity'
import { ScrapeJob } from '../../modules/scrape/entities/scrape-job.entity'

@Entity({ name: 'proxy_usage_log' })
@Index('idx_proxy_usage_proxy', ['proxy'])
@Index('idx_proxy_usage_used_at', ['usedAt'])
export class ProxyUsage {
  @PrimaryGeneratedColumn()
  id: number

  @ManyToOne(() => Proxy, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'proxy_id' })
  proxy: Proxy

  @ManyToOne(() => ScrapeJob, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'scrape_job_id' })
  scrapeJob?: ScrapeJob | null

  @CreateDateColumn({
    type: 'timestamptz',
    name: 'used_at',
    default: () => 'now()',
  })
  usedAt: Date

  @Column({ type: 'text', nullable: true })
  status?: 'success' | 'fail' | null

  @Column({ type: 'int', name: 'response_code', nullable: true })
  responseCode?: number | null

  @Column({ type: 'int', name: 'latency_ms', nullable: true })
  latencyMs?: number | null

  @Column({ type: 'text', nullable: true })
  url?: string | null

  @Column({ type: 'text', nullable: true })
  message?: string | null
}
