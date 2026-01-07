import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
} from 'typeorm'
import { Product } from './product.entity'

@Entity({ name: 'product_link' })
export class ProductLink {
  @PrimaryGeneratedColumn()
  id: number

  @ManyToOne(() => Product)
  @JoinColumn({ name: 'product_id' })
  product: Product

  @Column({ name: 'product_id' })
  productId: number

  @ManyToOne(() => Product)
  @JoinColumn({ name: 'linked_product_id' })
  linkedProduct: Product

  @Column({ name: 'linked_product_id' })
  linkedProductId: number

  @Column({ type: 'varchar', length: 50, nullable: true })
  type?: string | null

  @Column({ type: 'varchar', length: 50, nullable: true })
  source?: string | null

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  linkedAt: Date
}
