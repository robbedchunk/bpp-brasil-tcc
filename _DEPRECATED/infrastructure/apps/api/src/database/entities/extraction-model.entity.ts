import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm'

@Entity('extraction_model')
export class ExtractionModel {
  @PrimaryGeneratedColumn('increment')
  id: number

  @Column({ type: 'text', nullable: true })
  name?: string | null

  @Column({ type: 'text', nullable: true })
  version?: string | null

  @Column({ type: 'jsonb', nullable: true })
  parameters?: Record<string, any> | null

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date | null

  @Column({ type: 'boolean', default: true })
  active: boolean | null
}
