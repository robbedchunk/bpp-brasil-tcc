import 'dotenv/config'
import { APP_GUARD } from '@nestjs/core'
import { JwtAuthGuard } from './modules/auth/jwt-auth.guard'
import { Module } from '@nestjs/common'
import { AuthModule } from './modules/auth/auth.module'
import { TypeOrmModule } from '@nestjs/typeorm'
import { VersionModule } from './version/version.module'
import { StoreModule } from './modules/store/store.module'
import { RegionModule } from './modules/region/region.module'
import { BrandModule } from './modules/brand/brand.module'
import { CategoryModule } from './modules/category/category.module'
import { ProductModule } from './modules/product/product.module'
import { ScrapeRunModule } from './modules/scrape-run/scrape-run.module'
import { ScrapeModule } from './modules/scrape/scrape.module'
import { ScrapeLogModule } from './modules/scrape-log/scrape-log.module'
import { ProxyModule } from './modules/proxy/proxy.module'
import { WorkerModule } from './modules/worker/worker.module'
import { ExtractionModelModule } from './modules/extraction-model/extraction-model.module'
import { PriceObservationModule } from './modules/price-observation/price-observation.module'
import { ProductLinkModule } from './modules/product-link/product-link.module'
import { DailyPriceAggregateModule } from './modules/daily-price-aggregate/daily-price-aggregate.module'
import { DailyMarketIndexModule } from './modules/daily-market-index/daily-market-index.module'
import { FxRateModule } from './modules/fx-rate/fx-rate.module'
import { ScheduleModule } from '@nestjs/schedule'
import { ExtractionTransformerModule } from './modules/extraction-transformer/extraction-transformer.module'
import { OpenAIModule } from './modules/openai/openai.module'
import { WorkerService } from './modules/worker/worker.service'
import { ScrapeScheduler } from './modules/scheduler/scrape-scheduler.module'



@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      autoLoadEntities: true,
      entities: [__dirname + '/database/entities/*.entity{.ts,.js}'],
      dropSchema: false,
      migrationsRun: true,
      synchronize: false, // dev only, recreate fields.
      logging: true,
    }),
    WorkerModule,
    OpenAIModule,
    ExtractionTransformerModule,
    ScheduleModule.forRoot(),
    //  ScrapeSchedulerModule,
    AuthModule,
    VersionModule,
    StoreModule,
    RegionModule,
    BrandModule,
    CategoryModule,
    ProductModule,
    ScrapeRunModule,
    ScrapeModule,
    ScrapeLogModule,
    ProxyModule,
    WorkerModule,
    ExtractionModelModule,
    PriceObservationModule,
    ProductLinkModule,
    DailyMarketIndexModule,
    FxRateModule,
    DailyPriceAggregateModule,
    WorkerModule,
  ],
  controllers: [],

  providers: [
    ScrapeScheduler,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AppModule {}
