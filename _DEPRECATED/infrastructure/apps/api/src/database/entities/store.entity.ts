import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity()
@Index('idx_store_country', ['countryCode'])
export class Store {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Index('idx_store_name', { unique: true })
  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', nullable: true })
  domain?: string | null;

  @Column({ type: 'text', nullable: true })
  baseUrl?: string | null;

  @Column({ type: 'char', length: 2, nullable: true })
  countryCode?: string | null;

  @Column({ type: 'text', default: 'online' })
  channel: string;

  @Column({ type: 'jsonb', nullable: true })
  config?: Record<string, any>;

  @Column({ type: 'text', nullable: true })
  configVersion?: string | null;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
