import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';

@Entity('region')
@Index('idx_region_country', ['countryCode'])
export class Region {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column({ type: 'text', nullable: false })
  name: string;

  @Column({ type: 'char', length: 2, nullable: false })
  countryCode: string;

  @Column({ type: 'text', nullable: true })
  zipCode?: string | null;

  @Column({ type: 'boolean', default: true })
  active: boolean;
}
