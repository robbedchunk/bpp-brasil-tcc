import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScrapeRun } from '../../database/entities/scrape-run.entity';
import { ScrapeRunService } from './scrape-run.service';
import { ScrapeRunController } from './scrape-run.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ScrapeRun])],
  controllers: [ScrapeRunController],
  providers: [ScrapeRunService],
  exports: [ScrapeRunService],
})
export class ScrapeRunModule {}
