import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from 'typeorm'
import { Product } from './product.entity'
import { Store } from './store.entity'
import { Region } from './region.entity'
import { Scrape } from './scrape.entity'
import { ExtractionModel } from './extraction-model.entity'

@Entity('price_observation')
@Index('idx_price_obs_product_date', ['productId', 'observedAt'])
@Index('idx_price_obs_store_date', ['storeId', 'observedAt'])
@Index('idx_price_obs_region', ['regionId'])
@Index('idx_price_obs_currency', ['currency'])
@Index('idx_price_obs_availability', ['availability'])
@Index('idx_price_obs_is_promo', ['isPromo'])
export class PriceObservation {
  @PrimaryGeneratedColumn('increment')
  id: number

  @ManyToOne(() => Product, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'product_id' })
  product: Product | null

  @Column({ name: 'product_id', type: 'bigint' })
  productId: number

  @ManyToOne(() => Store, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'store_id' })
  store: Store | null

  @Column({ name: 'store_id', type: 'bigint' })
  storeId: number | null

  @ManyToOne(() => Region, { nullable: true })
  @JoinColumn({ name: 'region_id' })
  region?: Region | null

  @Column({ name: 'region_id', nullable: true })
  regionId?: number | null

  @ManyToOne(() => Scrape, { nullable: true })
  @JoinColumn({ name: 'scrape_id' })
  scrape?: Scrape | null

  @Column({ name: 'scrape_id', nullable: true })
  scrapeId?: number | null

  @Column({ type: 'varchar', length: 50, nullable: true })
  configVersion?: string | null

  @ManyToOne(() => ExtractionModel, { nullable: true })
  @JoinColumn({ name: 'extraction_model_id' })
  extractionModel?: ExtractionModel | null

  @Column({ name: 'extraction_model_id', type: 'bigint', nullable: true })
  extractionModelId?: number | null

  @Column({ type: 'timestamptz', nullable: false })
  observedAt: Date | null

  @Column({ type: 'numeric', nullable: false })
  price: number | null

  @Column({ type: 'char', length: 3, nullable: false })
  currency: string | null

  @Column({ type: 'boolean', nullable: true })
  availability?: boolean | false // in_stock / out_of_stock

  @Column({ type: 'boolean', default: false })
  isPromo: boolean | null

  @Column({ type: 'numeric', nullable: true })
  priceBefore?: number | null

  @Column({ type: 'numeric', nullable: true })
  shipping?: number | null

  @Column({ type: 'boolean', default: false })
  taxIncluded: boolean | null

  @Column({ type: 'text', nullable: true })
  seller?: string | null

  @Column({ type: 'text', nullable: false })
  sourceUrl: string | null

  @Column({ type: 'text', nullable: true })
  htmlSnapshot?: string | null

  @Column({ type: 'text', nullable: true })
  snapshotHash?: string | null

  @Column({ type: 'numeric', nullable: true })
  normalizedPrice?: number | null

  @Column({ type: 'text', nullable: true })
  priceUnit?: string | null

  @Column({ type: 'numeric', nullable: true })
  unitValue?: number | null

  @Column({ type: 'text', nullable: true })
  unitMeasure?: string | null

  @Column({ type: 'numeric', nullable: true })
  matchedConfidence?: number | null

  @Column({ type: 'jsonb', nullable: true })
  extractionMeta?: Record<string, any> | null

  @Column({ type: 'jsonb', nullable: true })
  botDetectionMeta?: Record<string, any> | null

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date | null
}
