import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PriceObservation } from '../../database/entities/price-observation.entity';
import { PriceObservationService } from './price-observation.service';
import { PriceObservationController } from './price-observation.controller';

@Module({
  imports: [TypeOrmModule.forFeature([PriceObservation])],
  controllers: [PriceObservationController],
  providers: [PriceObservationService],
  exports: [PriceObservationService],
})
export class PriceObservationModule {}