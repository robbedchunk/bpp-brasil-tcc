import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm'

@Entity('daily_price_aggregate')
@Index('idx_dpa_day_region_category', ['day', 'regionId', 'categoryId'])
export class DailyPriceAggregate {
  @PrimaryGeneratedColumn()
  id: number

  @Column({ type: 'date' })
  day: string

  @Column({ type: 'int', nullable: true })
  regionId?: number | null

  @Column({ type: 'int', nullable: true })
  categoryId?: number | null

  @Column({ type: 'numeric', nullable: true })
  avgPrice?: number | null

  @Column({ type: 'numeric', nullable: true })
  minPrice?: number | null

  @Column({ type: 'numeric', nullable: true })
  maxPrice?: number | null

  @Column({ type: 'numeric', nullable: true })
  itemCount?: number | null

  @Column({ type: 'jsonb', nullable: true })
  meta?: Record<string, any> | null
}
