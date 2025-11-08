import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('brand')
@Index('idx_brand_canonical', ['canonical'], { unique: true })
@Index('idx_brand_name_tsv', ['name'])
export class Brand {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column({ type: 'text', nullable: false })
  name: string;

  @Column({ type: 'text', nullable: true })
  canonical?: string | null;

  @Column({ type: 'text', nullable: true })
  origin?: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
