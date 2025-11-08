import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FxRate } from '../../database/entities/fx-rate.entity';
import { FxRateService } from './fx-rate.service';
import { FxRateController } from './fx-rate.controller';

@Module({
  imports: [TypeOrmModule.forFeature([FxRate])],
  controllers: [FxRateController],
  providers: [FxRateService],
  exports: [FxRateService],
})
export class FxRateModule {}
