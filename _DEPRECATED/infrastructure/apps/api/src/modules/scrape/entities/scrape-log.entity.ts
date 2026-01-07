import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { ScrapeJob } from './scrape-job.entity';

@Entity()
export class ScrapeLog {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => ScrapeJob)
  @JoinColumn({ name: 'scrape_job_id' })
  job: ScrapeJob;

  @Column({ nullable: true })
  logLevel: string;

  @Column({ type: 'text', nullable: true })
  message: string;

  @CreateDateColumn()
  createdAt: Date;
}
