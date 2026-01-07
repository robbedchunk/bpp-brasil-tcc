import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from '../../app.module'
import { WorkerService } from './worker.service'

async function bootstrap () {
  const appContext = await NestFactory.createApplicationContext(AppModule)
  const worker = appContext.get(WorkerService)

  console.log('Starting scraping worker...')
  await worker.runAllStores()

  console.log('Scraping complete.')
  await appContext.close()
}

bootstrap().catch(e => {
  console.error('Worker failed:', e)
  process.exit(1)
})
