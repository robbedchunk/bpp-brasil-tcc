import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from '../../app.module'
import { ScrapeService } from './scrape.service'

async function bootstrap () {
  const appContext = await NestFactory.createApplicationContext(AppModule)
  const scrapeService = appContext.get(ScrapeService)

  console.log('Starting manual scrape...')
  const jobs = await scrapeService.findAll()
  const pending = jobs.filter(j => j.status === 'pending')

  console.log(`Found ${pending.length} pending scrape jobs`)
  for (const job of pending) {
    await scrapeService.queueJob(job.id)
  }

  console.log(`Queued ${pending.length} scrape jobs to Redis`)
  await appContext.close()
}

bootstrap().catch(e => {
  console.error('Manual scrape failed:', e)
  process.exit(1)
})
