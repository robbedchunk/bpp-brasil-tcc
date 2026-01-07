import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('worker')
@Index('idx_worker_alive', ['isAlive'])
@Index('idx_worker_last_heartbeat', ['lastHeartbeat'])
export class Worker {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column({ type: 'text', nullable: true })
  workerName?: string | null;

  @Column({ type: 'text', nullable: true })
  ip?: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  dateCreated: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastHeartbeat?: Date;

  @Column({ type: 'int', default: 0 })
  errorCount: number;

  @Column({ type: 'timestamptz', nullable: true })
  dateKilled?: Date;

  @Column({ type: 'boolean', default: true })
  isAlive: boolean;
}
