import { Module } from '@nestjs/common'
import { ExtractionTransformerService } from './extraction-transformer.service'
import { ExtractionTransformerController } from './extraction-transformer.controller'

@Module({
  controllers: [ExtractionTransformerController],
  providers: [ExtractionTransformerService],
  exports: [ExtractionTransformerService],
})
export class ExtractionTransformerModule {}
