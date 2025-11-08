import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm'

@Entity('fx_rate')
@Index('idx_fx_day_currency', ['day', 'baseCurrency', 'quoteCurrency'])
export class FxRate {
  @PrimaryGeneratedColumn()
  id: number

  @Column({ type: 'date' })
  day: string

  @Column({ type: 'char', length: 3 })
  baseCurrency: string

  @Column({ type: 'char', length: 3 })
  quoteCurrency: string

  @Column({ type: 'numeric', precision: 12, scale: 6 })
  rate: number

  @Column({ type: 'text', nullable: true })
  source?: string | null

  @Column({ type: 'jsonb', nullable: true })
  meta?: Record<string, any> | null
}
