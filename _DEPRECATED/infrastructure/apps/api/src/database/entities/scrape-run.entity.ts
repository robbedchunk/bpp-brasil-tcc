import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('scrape_run')
@Index('idx_scrape_run_status', ['status'])
@Index('idx_scrape_run_started', ['startedAt'])
export class ScrapeRun {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column({ type: 'timestamptz', nullable: false })
  startedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt?: Date | null;

  @Column({ type: 'text', nullable: false })
  status: string | null; // queued, running, finished, failed

  @Column({ type: 'text', nullable: true })
  initiatedBy?: string | null;

  @Column({ type: 'jsonb', nullable: true })
  stats?: Record<string, any> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date | null;
}
