import { Module } from '@nestjs/common';
import { CatalogSchedulerService } from './catalog-scheduler.service';
import { CatalogRunModule } from '../catalog-run/catalog-run.module';

@Module({
  imports: [CatalogRunModule],
  providers: [CatalogSchedulerService],
  exports: [CatalogSchedulerService],
})
export class SchedulerModule {}
