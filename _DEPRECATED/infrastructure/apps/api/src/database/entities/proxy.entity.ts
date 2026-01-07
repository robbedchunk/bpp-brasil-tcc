import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm'

@Entity('proxy')
@Index('idx_proxy_last_used', ['last_used'])
@Index('idx_proxy_type', ['type'])
export class Proxy {
  @PrimaryGeneratedColumn('increment')
  id: number

  @Column({ type: 'text', nullable: true })
  ip?: string | null

  @Column({ type: 'int', nullable: true })
  port?: number | null

  @Column({ type: 'text', nullable: true })
  username?: string | null

  @Column({ type: 'text', nullable: true })
  pass?: string | null

  @Column({ type: 'text', nullable: true })
  type?: string | null // elite / anonymous / transparent

  @Column({ type: 'char', length: 2, nullable: true })
  country?: string | null // ISO 2-letter country code

  @Column({ type: 'boolean', default: true })
  active: boolean

  @Column({ type: 'int', default: 0, name: 'error_count' })
  errorCount: number | null

  @Column({ type: 'int', default: 0, name: 'total_requests' })
  totalRequests: number | null

  @Column({ type: 'int', default: 0, name: 'total_failures' })
  totalFailures: number | null

  //failureCount
  @Column({ type: 'int', default: 0, name: 'failure_count' })
  failureCount: number | null

  @Column({ type: 'int', default: 0, name: 'success_count' })
  successCount: number | null

  @Column({
    type: 'timestamptz',
    nullable: true,
    default: null,
    name: 'last_used',
  })
  last_used?: Date

  // last_status
  @Column({ type: 'text', nullable: true })
  last_status?: string | null
}
