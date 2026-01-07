import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { ExtractionModel } from '../../database/entities/extraction-model.entity'
import { ExtractionModelService } from './extraction-model.service'
import { ExtractionModelController } from './extraction-model.controller'

@Module({
  imports: [TypeOrmModule.forFeature([ExtractionModel])],
  controllers: [ExtractionModelController],
  providers: [ExtractionModelService],
  exports: [ExtractionModelService],
})
export class ExtractionModelModule {}
