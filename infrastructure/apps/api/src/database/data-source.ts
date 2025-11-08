import 'dotenv/config';
import { DataSource } from 'typeorm';
import { Store } from './entities/store.entity';
import { Region } from './entities/region.entity';
import { Brand } from './entities/brand.entity';
import { Category } from './entities/category.entity';
import { Product } from './entities/product.entity';
import { Scrape } from './entities/scrape.entity';
import { ScrapeRun } from './entities/scrape-run.entity';
import { ScrapeLog } from './entities/scrape-log.entity';
import { Proxy } from './entities/proxy.entity';
import { Worker } from './entities/worker.entity';
import { ExtractionModel } from './entities/extraction-model.entity';
import { PriceObservation } from './entities/price-observation.entity';
import { ProductLink } from './entities/product-link.entity';
import { DailyMarketIndex } from './entities/daily-market-index.entity';
import { FxRate } from './entities/fx-rate.entity';
import { DailyPriceAggregate } from './entities/daily-price-aggregate.entity';

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  username: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'postgres',
  entities: [
    Store,
    Region,
    Brand,
    Category,
    Product,
    Scrape,
    ScrapeRun,
    ScrapeLog,
    Proxy,
    Worker,
    ExtractionModel,
    PriceObservation,
    ProductLink,
    DailyMarketIndex,
    FxRate,
    DailyPriceAggregate,
  ],
  migrations: ['src/database/migrations/**/*.ts'],
  synchronize: false,
  migrationsRun: true,
  logging: true,
});
