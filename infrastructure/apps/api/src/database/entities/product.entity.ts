import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { Store } from './store.entity';
import { Category } from './category.entity';
import { Brand } from './brand.entity';

@Entity('product')
@Index('idx_product_store', ['storeId'])
@Index('idx_product_brand', ['brandId'])
@Index('idx_product_unique', ['storeId', 'name', 'quantityValue', 'quantityUnit'], { unique: true })
export class Product {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @ManyToOne(() => Category, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'category_id' })
  category: Category;

  @Column({ name: 'category_id', type: 'bigint' })
  categoryId: number;

  @ManyToOne(() => Store, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'store_id' })
  store: Store;

  @Column({ name: 'store_id', type: 'bigint' })
  storeId: number;

  @ManyToOne(() => Brand, { nullable: true })
  @JoinColumn({ name: 'brand_id' })
  brand?: Brand;

  @Column({ name: 'brand_id', type: 'bigint', nullable: true })
  brandId?: number | null

  @Column({ type: 'text', nullable: true })
  sku?: string | null;

  @Column({ type: 'text', nullable: true })
  upc?: string | null;

  @Column({ type: 'text', nullable: true })
  gtin?: string | null;

  @Column({ type: 'text', nullable: false })
  name: string;

  @Column({ type: 'text', nullable: true })
  canonicalName?: string | null;

  @Column({ type: 'text', array: true, nullable: true })
  alternateNames?: string[] | null;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  @Column({ type: 'numeric', nullable: true })
  quantityValue?: number | null

  @Column({ type: 'text', nullable: true })
  quantityUnit?: string | null;

  @Column({ type: 'jsonb', nullable: true })
  attributes?: Record<string, any>;

  @Column({ type: 'text', nullable: true })
  imageUrl?: string | null;

  @Column({ type: 'text', nullable: true })
  productUrl?: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
