import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { Store } from './store.entity';

@Entity('category')
@Index('idx_category_store_parent', ['storeId', 'parentId'])
export class Category {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column({ type: 'bigint', nullable: true })
  parentId?: number | null;

  @ManyToOne(() => Store, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'store_id' })
  store: Store;

  @Column({ name: 'store_id', type: 'bigint' })
  storeId: number;

  @Column({ type: 'text', nullable: false })
  name: string;

  @Column({ type: 'boolean', default: true })
  active: boolean;
}
